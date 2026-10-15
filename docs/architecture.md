# Architecture

How the shared planner is put together. SPEC.md says *what* to build; this
file says *where* things live and the conventions every module follows.

## Runtime layout

One Cloudflare Worker (`src/worker/index.ts`) serves everything:

```
request ─► plain http on a host other than localhost: 308 to the same URL on https
        ─► POST /register listing a redirect URI other than Claude's or a
          loopback one: 400 invalid_redirect_uri (oauth/redirects.ts)
        ─► providerFor(origin): OAuthProvider (@cloudflare/workers-oauth-provider), one per origin
            ├─ /mcp                      bearer token checked by the provider ─► PlannerMcp (McpAgent, Durable Object)
            ├─ /token, /register,
            │  /.well-known/*            handled by the provider itself
            └─ everything else ─► Hono app (src/worker/app.ts)
                 ├─ /login (GET, POST), /logout (POST)      public
                 ├─ /manifest.webmanifest, /sw.js,
                 │  /favicon.svg, /icons/*                  public, no data; 404 when the file is missing
                 ├─ /authorize (GET, POST)                   redirect_uri must be allowed, else a 400 page;
                 │                                           session required, else redirect to /login?next=…
                 ├─ /api/sessions, /api/*                    session required, else 401 JSON
                 └─ SPA (index.html, /assets/*)              session required, else redirect to /login?next=…
cron (every 10 min) ─► src/worker/cron.ts: transcription retries, auto-closing runs
```

The provider must know its resource URL (`<origin>/mcp`) when it is built,
and the Worker's hostname is not known at build time, so
`src/worker/oauth/provider.ts` builds one provider per request origin and
caches it (see DECISIONS.md).

The OAuth provider needs a KV namespace. To keep the deployment to one
Worker, D1 and R2 (SPEC section 1), `OAUTH_KV` is a KV-compatible adapter over
the `oauth_kv` D1 table (`src/worker/oauth/kv.ts`), injected into `env` before
the provider runs.

## Source tree

```
migrations/            D1 schema (0001_init.sql, then numbered additions)
src/shared/            types and helpers used by the Worker and the browser
  types.ts             row types (match the schema column for column)
  api.ts               request/response shapes of /api/*
src/worker/
  index.ts             entry: OAuthProvider wiring, fetch + scheduled, exports PlannerMcp
  env.ts               AppEnv, AppBindings (Hono), GrantProps
  app.ts               Hono app: security headers, public routes, session gate, SPA
  lib/                 ulid, errors (AppError → HTTP), time (Africa/Johannesburg)
  mutate/              THE ONLY WRITE PATH for board data (see below)
  auth/                phrase check, sessions, rate limit, login page, middleware
  oauth/               KV adapter, /authorize consent, the redirect URI allowlist
  api/                 Hono routers for /api/*, one file per area
  board/               read models: board queries, provenance badges, activity
                       and history, runs, titles, field rules, placement of new notes
  captures/            upload, R2 storage, transcription, audio streaming (phase 2)
  mcp/                 PlannerMcp agent and one module per tool group (phase 3)
src/app/               React SPA (Vite); index.html at the repo root
  main.tsx, App.tsx    entry (starts the store) and the shell: header, nav, panel, toasts
  api.ts, store.ts     fetch wrapper and the store wired to the browser
  lib/                 pure logic with unit tests: state, sync (poller), board,
                       items, list tabs, events in words, activity paging
  board/ list/ panel/  the canvas, the List view and the item panel
  activity/ settings/  the Activity and Settings views
  components/          chips, badges, times, event rows and Revert
  styles.css           all app styles; board/board.css loads with the canvas
static/                files copied as-is into the build (favicon.svg; the PWA
                       manifest, sw.js and icons come with the capture phase)
scripts/e2e-server.sh  wrangler dev on port 8788 with a fresh local database
test/worker/           Vitest inside workerd (real D1/R2/DO via Miniflare)
test/unit/             Vitest under Node (pure functions, source scans)
test/helpers/          shared test helpers
test/fixtures/client/  fixed static files the worker tests serve as the app
e2e/                   Playwright smoke tests against `wrangler dev`
```

## The single write path (SPEC 4.1)

`src/worker/mutate/index.ts` exports `mutate(db, actor, mutation)` and
`mutateMany(db, actor, mutations, {prelude})`. Every write to `notes`,
`tasks`, `links`, `labels`, `users`, `settings` and to the content fields of
`captures` goes through it. Each change commits in one `db.batch()` with:

1. an UPDATE conditional on the changed fields still holding the values read
   (or an INSERT for creations);
2. a `write_guard` row that aborts the batch if that UPDATE missed (the
   batch is retried up to three times, then a 409 is returned; reverts pass
   `retryStale: false` and start again from their conflict check instead);
3. the `events` row with the before/after diff of the changed fields
   (the full row for creations).

Claude writes (`actor.kind === 'claude'`) also carry a guard that the run is
open, belongs to that user and is under two hours old, and mutate refuses
archive/unarchive/revert and any write to labels, settings or users.

Rules for all code:

- Never write `INSERT`/`UPDATE`/`DELETE` SQL for those tables anywhere else.
  `test/unit/write-paths.test.ts` scans the source and fails if you do.
- The only other writers are: `auth/sessions.ts` (sessions, with login and
  session_revoke events via `eventStatement`), `auth/rate-limit.ts`
  (login_attempts), `oauth/kv.ts` (oauth_kv), run bookkeeping in `mcp/` and
  the transcription lease/attempt counters in `captures/` (columns
  `transcribe_attempts`, `transcribe_next_at` only).
- Reverts: `src/worker/mutate/revert.ts` (`revertEvent`, `revertRun`).

## API conventions

- Hono routers typed `Hono<AppBindings>`; the signed-in user is `c.get("user")`.
- Validate every body and query with zod (`zod` v4). Return 400 with
  `{ error: { code: "invalid_request", message, details } }` on failure.
- Throw `AppError` subclasses from `lib/errors.ts`; `app.ts` turns them into
  `{ error: { code, message, details } }` with the right status. Unknown
  errors become a 500 with a generic message (and are logged without request
  bodies, cookies or secrets).
- Responses use the types in `src/shared/api.ts`. Rows go out as stored
  except `captures.transcript_json`, which never leaves the Worker.
- Every mutating `/api` request must be same-origin: the gate rejects a
  request whose `Origin` header is present and differs from the Worker's
  origin, or whose `Sec-Fetch-Site` is `cross-site`.
- Never log, echo or persist a login phrase, a session token, the
  ElevenLabs key or an OAuth token.

## Change feed

`events.seq` (AUTOINCREMENT) is the commit order. `GET /api/changes?since=<event id>`
returns events with a higher seq plus the current rows they touched. The app
polls every 5 s while visible and once on focus or when it becomes visible
(`src/app/lib/sync.ts`, wired to the browser in `src/app/store.ts`): polls
never overlap, `more` polls again at once, `reset` reloads `/api/bootstrap`,
and network errors back off quietly.

## Placement

A note created without `x`/`y` (the list's quick-add, and Claude's
`create_note` in phase 3) goes in the first free cell of a grid
(`src/worker/board/placement.ts`): 6 columns and 40 rows of cells the size of
the note, 40 px apart, clear of every open note and placed task. A placed
task counts as 220 × 100, the size of its card on the canvas. When the grid
is full the note goes below everything.

## Provenance

Badges ("Cobus", "Claude (via Cobus)") come from the first and last event of
each note/task (`src/worker/board/provenance.ts`), returned as `prov` on
`NoteView`/`TaskView`. `src/shared/actors.ts` formats an `ActorRef` for display.

## Front end

- React 19 + Vite, `@xyflow/react` for the canvas. No other UI libraries.
  The canvas is loaded lazily, with its own stylesheet.
- Path routes: `/board`, `/list`, `/activity`, `/settings` (and `/inbox` in
  phase 2). `/` opens the board on wide screens and the list on phones
  (< 768 px). The item panel is `?item=note:<id>` or `?item=task:<id>` on
  any route: a drawer on wide screens, a full-screen sheet on phones.
- `src/app/api.ts` wraps fetch: JSON in/out, `ApiError` on failure, and a
  401 sends the browser to `/login?next=<current path and query>`.
- `src/app/store.ts` holds bootstrap state, applies mutation responses and
  change-feed results, and runs the poller. Components read it with
  `usePlanner(selector)`; `src/app/actions.ts` makes every change (API call,
  optimistic update, toast on failure).
- Canvas saves: one `PATCH` per moved card on drag stop, `w`/`h` on resize
  end, arrow-key moves 600 ms after the last key.
- Plain CSS with custom properties (`src/app/styles.css`), light and dark via
  `prefers-color-scheme`, system font stack. No external fonts, CDNs or
  analytics; the CSP only allows `'self'`.
- Text on a label colour uses `textColourFor()` from `src/shared/colour.ts`.
- All UI text in South African English: colour, organise, cancelled,
  "Signed-in browsers", dates as 14 Oct 2026.

## Testing

```
npm run typecheck        # tsc -b over worker, app and node configs
npm test                 # vitest: worker project (workerd) + unit project (node)
npm run build            # vite build + wrangler deploy --dry-run
npm run test:e2e         # Playwright against wrangler dev (see e2e/README.md)
```

Worker tests call `freshDb()` from `test/helpers/db.ts` to get an empty,
migrated database. Test login phrases are set in `vitest.config.ts`; the
local-development ones are in `.dev.vars` (copy `.dev.vars.example`). Worker
tests serve the fixed files in `test/fixtures/client` as the app's static
assets (`miniflare.assets.directory`), so they do not depend on a build.

The Playwright smoke tests (`e2e/`, see `e2e/README.md`) start
`scripts/e2e-server.sh`: a fresh local D1 in `.wrangler/e2e`, migrations
applied, then `wrangler dev` on port 8788, which builds the app first.
