# Architecture

How the shared planner is put together. SPEC.md says *what* to build; this
file says *where* things live and the conventions every module follows.

## Runtime layout

One Cloudflare Worker (`src/worker/index.ts`) serves everything:

```
request ─► OAuthProvider (@cloudflare/workers-oauth-provider)
            ├─ /mcp                      bearer token checked by the provider ─► PlannerMcp (McpAgent, Durable Object)
            ├─ /token, /register,
            │  /.well-known/*            handled by the provider itself
            └─ everything else ─► Hono app (src/worker/app.ts)
                 ├─ /login (GET, POST), /logout (POST)      public
                 ├─ /manifest.webmanifest, /sw.js, /icons/*  public, no data
                 ├─ /authorize (GET, POST)                   session required, else redirect to /login?next=…
                 ├─ /api/*                                   session required, else 401 JSON
                 └─ SPA (index.html, /assets/*)              session required, else redirect to /login?next=…
cron (every 10 min) ─► src/worker/cron.ts: transcription retries, auto-closing runs
```

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
  oauth/               KV adapter, /authorize consent
  api/                 Hono routers for /api/*, one file per area
  board/               read models: board queries, provenance badges, placement
  captures/            upload, R2 storage, transcription, audio streaming (phase 2)
  mcp/                 PlannerMcp agent and one module per tool group (phase 3)
src/app/               React SPA (Vite); index.html at the repo root
static/                files copied as-is into the build (manifest, sw.js, icons)
test/worker/           Vitest inside workerd (real D1/R2/DO via Miniflare)
test/unit/             Vitest under Node (pure functions, source scans)
test/helpers/          shared test helpers
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
   batch is retried up to three times, then a 409 is returned);
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
polls every 5 s while visible and once on focus (`src/app/store.ts`).

## Provenance

Badges ("Cobus", "Claude (via Cobus)") come from the first and last event of
each note/task (`src/worker/board/provenance.ts`), returned as `prov` on
`NoteView`/`TaskView`. `src/shared/actors.ts` formats an `ActorRef` for display.

## Front end

- React 19 + Vite, `@xyflow/react` for the canvas. No other UI libraries.
- Path routes: `/board`, `/list`, `/inbox`, `/activity`, `/settings`. `/`
  opens the board on wide screens and the list on phones (< 768 px).
- `src/app/api.ts` wraps fetch: JSON in/out, `ApiError` on failure, and a
  401 sends the browser to `/login?next=<current path>`.
- `src/app/store.ts` holds bootstrap state, applies mutation responses and
  change-feed results, and runs the poller. Components read it with hooks.
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
local-development ones are in `.dev.vars` (copy `.dev.vars.example`).
