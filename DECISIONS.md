# Decisions

Choices made where SPEC.md was silent or ambiguous, with the reason. Newest
at the bottom of each section.

## Platform and tooling

- **OAuth storage in D1, not KV.** `@cloudflare/workers-oauth-provider`
  stores clients, grants and tokens through `env.OAUTH_KV`. SPEC section 1
  fixes the resources as one Worker, D1 and R2, so `OAUTH_KV` is a small
  KV-compatible adapter over the `oauth_kv` D1 table instead of a KV
  namespace.
- **McpAgent needs a Durable Object.** `agents`' `McpAgent` runs as a
  SQLite-backed Durable Object class (`PlannerMcp`) inside the same Worker.
  It is part of the Worker, not a separate service, and is on the Workers
  free plan.
- **Resources are named, not pinned by id.** `wrangler.jsonc` names the D1
  database (`projectplanner`) and the R2 bucket (`projectplanner-audio`)
  without ids. Wrangler resolves them by name and creates them on the first
  deploy if they are missing.
- **Builds run through wrangler.** `wrangler.jsonc` has a `build` command
  (`npm run build:client`) so `npx wrangler deploy` (the Cloudflare Git
  integration's default) always builds the SPA first.
- **TypeScript 7 and Vitest 4** with `@cloudflare/vitest-plugin`, the
  renamed successor of `@cloudflare/vitest-pool-workers`, so tests run inside
  workerd against real D1, R2 and Durable Objects.
- **npm 11 for installs.** npm 10.9 hits an arborist bug ("Cannot read
  properties of null (reading 'edgesOut')") when adding the Vitest packages;
  `npx npm@11 install` works and the lockfile installs cleanly with npm 10's
  `npm ci`.
- **Playwright pinned to 1.56.1** to match the Chromium build installed in
  the development container.

## Data model

- **`events.seq`.** Events have an `INTEGER PRIMARY KEY AUTOINCREMENT` `seq`
  besides the ULID `id`. D1 commits one transaction at a time, so `seq` is
  the commit order; ULIDs from different isolates in the same millisecond
  are not. The change feed takes an event id (as SPEC 4.2 says) and returns
  events with a higher `seq`.
- **Seeded users.** The two users have fixed ids
  `00000000000000000000000001` and `…02` and the names "Person 1" and
  "Person 2", changed in Settings. `LOGIN_PHRASE_1` signs in as the first.
- **`captures.transcribe_next_at`.** Added to the captures table: the
  earliest time the next transcription attempt may start. It implements the
  cron backoff and works as a lease so the upload request and the cron never
  transcribe the same capture at once.
- **Write guards.** Optimistic concurrency without a version column: an
  UPDATE only applies if the fields it changes still hold the values that
  were read, and a `write_guard` insert whose trigger aborts the transaction
  if it missed. The same mechanism checks that a Claude run is open and makes
  `start_run`'s claim all-or-nothing.
- **Links are stored once per pair.** Endpoints are sorted (`type:id`) before
  storing, so drawing A→B and B→A is the same link. Unlinking archives the
  row; linking the pair again un-archives it (action `link`).
- **Event diffs hold only changed fields**, except creations, whose `after`
  is the full row. `updated_at` and `captures.transcript_json` are never in
  event JSON.
- **A position is one value.** When `x` or `y` of a note or task changes, the
  change and its event carry both coordinates (before and after), so every
  event, and every revert of one, restores a whole position. Reverting a
  move along one axis after the task went to the tray works.

## Provenance and revert

- **Reverting a creation archives the item** (nothing is ever deleted).
  Captures, users and settings cannot be archived, so their creation cannot
  be reverted. An item that is already archived is left alone, as archiving
  does: a revert never moves an existing `archived_at`, so reverting a
  creation again, or a whole run after one of its creations was reverted,
  writes no event for it and counts 0.
- **Conflict rule.** A revert warns when a later event on the same item set
  any field the revert would set back; for a creation, any later change
  counts. A person's earlier revert of an event in the same run is not a
  conflict for a whole-run revert.
- **Whole-run revert is one transaction** (`mutateMany`), newest event
  first, so it either fully applies or not at all.
- **Only people can revert.** Claude has no revert tool and mutate refuses
  `revert` from any other actor.
- **A revert never overwrites a change it did not check.** The conflict
  check reads events before the batch, so the batch also carries a guard
  that none of the reverted items gained an event since the check, and
  mutate does not retry a stale guard for a revert (`retryStale: false`):
  retrying would read the new value and set it back without a warning.
  The whole revert starts again instead, conflict check included, up to
  three times. A change to the same fields then shows as a conflict; a
  change to other fields lets the revert go ahead; after three misses the
  person gets "changed at the same moment, try again".

## Login, sessions and OAuth

- **One OAuth provider per origin.** `@cloudflare/workers-oauth-provider`
  1.2.3 needs `resourceMetadata.resource` (an absolute `https` URL; `http`
  only on loopback) when it is constructed, and binds tokens to it (RFC 8707).
  The public hostname is not known at build time, so `providerFor(origin)`
  builds and caches one provider per origin with resource `${origin}/mcp`
  (at most 8; only routed hostnames reach the Worker). No env var is needed.
- **`PlannerMcp` uses `Cloudflare.Env`, not `AppEnv`.** `McpAgent` requires
  `Env extends Cloudflare.Env`, and the Durable Object gets the raw bindings
  without the per-request `OAUTH_KV`/`OAUTH_PROVIDER`. Tools read the user
  from `this.props.userId` (`GrantProps`).
- **Rate limit counts before checking.** Each attempt is counted in one
  atomic upsert before the phrase is compared, and the 5th sets the lockout
  in the same statement, so concurrent requests get at most 5 checks per
  window. A correct 5th attempt deletes the record.
- **Lockouts double without a cap (SPEC 3.3).** 15, 30, 60 … minutes, with
  the doubling stopped at 2^20 only to keep the numbers finite. An earlier
  version capped lockouts at 24 hours and measured the 24-hour reset from
  the start of the last lockout, so a 24-hour lockout reset itself and the
  schedule started again at 15 minutes (about 17 guesses a day per address
  instead of a shrinking number). That weakened "doubling on each further
  lockout", so the cap is gone and the reset (failures and lockout count
  back to 0) now needs 24 hours after the end of the last lockout or the
  last failure, whichever is later. Someone sharing a carrier-NAT address
  can lock out new sign-ins from it for longer; existing sessions are not
  affected (they last 400 days), and either person can sign in from another
  network.
- **Cross-site posts are refused, not counted.** `POST /login` with a foreign
  `Origin` or `Sec-Fetch-Site: cross-site` gets the generic 401 and does not
  count, so no website can lock a visitor out. `POST /logout` and
  `POST /authorize` answer such posts with 403.
- **IP keys.** Unparseable `CF-Connecting-IP` values share the `unknown`
  bucket with a missing header (local development and tests, so every local
  client shares one bucket). `::ffff:a.b.c.d` counts as `a.b.c.d`.
- **`safeNext()`** accepts only paths on this site: not `//` or `/\`, no
  control characters or backslashes anywhere, at most 2048 characters.
- **Sliding sessions.** When `last_seen_at` is more than 10 minutes old it is
  moved on and the same token is sent again with Max-Age 400 days, unless the
  handler already set or cleared the cookie (sign-out routes).
- **Revoking.** `POST /api/sessions/:id/revoke` also clears the cookie when
  `:id` is this browser, and is a 404 for unknown or revoked sessions.
  `revoke-mine` only touches active sessions. Each revocation is a
  conditional UPDATE plus a `write_guard`, retried up to 3 times, so a
  concurrent revoke never logs a second `session_revoke` event.
- **Caching.** `Cache-Control: no-store` for HTML, `/api`, redirects and error
  pages; `public, max-age=31536000, immutable` for 200s under `/assets/*`
  (still behind the session check); `no-cache` for the public files
  (`/manifest.webmanifest`, `/sw.js`, `/favicon.svg`, `/icons/*`).
- **Security headers** are set by a Hono middleware on a mutable copy of the
  final response. A handler may set its own CSP (the consent page does).
  Responses made by the OAuth provider itself (`/token`, `/register`,
  `/.well-known/*`, `/mcp`) keep the provider's headers.
- **The planner only connects to Claude.** `CLAUDE_REDIRECT_URIS` in
  `oauth/redirects.ts` is the one list: `https://claude.ai/api/mcp/auth_callback`
  and `https://claude.com/api/mcp/auth_callback` (origin and path), plus any
  http(s) loopback redirect (localhost, 127.0.0.0/8, [::1]) for local tools
  such as MCP Inspector. `/authorize` checks `redirect_uri` before the
  session check and before the provider: anything else gets a plain 400 page
  and no redirect at all, not even an error redirect or the phrase page, so
  the planner's address cannot bounce anyone to another site (RFC 9700
  4.11.2). `POST /register` with any other redirect URI is refused before the
  provider with 400 `invalid_redirect_uri` (RFC 7591).
- **Consent page CSP** allows `form-action 'self' https:` plus the redirect's
  origin only for an `http` loopback redirect, so local tools work; a
  loopback redirect also gets a warning on the page.
- **Grants and clients.** The grant label is the client's own name (else its
  client id); `scope` is passed through as parsed. Apart from the redirect
  URIs, `/register` keeps the provider's dynamic client registration
  defaults (public clients, 90-day client TTL, 1-hour access and 30-day
  refresh tokens); claude.ai registers this way. CIMD stays off: it would need the `global_fetch_strictly_public`
  flag, and no client needs it yet.
- **Unknown routes.** Other methods on page paths (e.g. `POST /board`) are a
  404 page once signed in and a redirect to the phrase page otherwise.
  Unknown `/api` paths are a 401 without a session and a 404 JSON with one.
- **The session cookie works on `http://localhost`.** It is
  `__Host-planner_session` with `Secure`; Chromium treats localhost as a
  potentially trustworthy origin and stores it, so local development and the
  Playwright tests need no relaxed cookie.

## Board API

- **Change feed start.** Without `since`, `/api/changes` is a reset only once
  events exist; on an empty database it is `reset: false` with nothing in it
  (otherwise a fresh install would reload the bootstrap every 5 s). A reset
  returns the given `since` as its cursor.
- **Bootstrap reads the cursor first**, then the rows: anything committed in
  between is newer than the cursor and arrives again through the feed.
- **Strict query strings.** Every query is a `z.strictObject`: unknown
  parameters are a 400 and empty ones count as absent. The app therefore
  never adds cache-busting parameters (responses are `no-store` anyway).
- **Placement.** Creating a note takes both `x` and `y` or neither; with
  neither, `board/placement.ts` puts it in the first free cell of a grid
  (6 columns, 40 rows, 40 px apart) clear of open notes and placed tasks,
  else below everything. Placed tasks count as 220 × 100, the size of a
  task card in the app. `PATCH` may change a note's `x` or `y` alone; tasks
  take `x` and `y` together everywhere (both null = the tray).
- **Default label.** New notes and tasks without `label_id` get
  `settings.default_label_id` while that label is active; an explicit `null`
  means no label. Archiving the default label clears the setting in the
  same `mutateMany`.
- **Archived labels.** An item may keep a label that was archived later
  (sending the same `label_id` is accepted) but cannot be given one.
- **Label names** are unique among active labels, ignoring case. A clash is a
  400 `invalid_request`, not a 409 (409 `conflict` means "changed by someone
  else just now"); so is unarchiving a label whose name has been taken.
  Renaming an archived label skips the check. The check reads before it
  writes, outside the batch, so two simultaneous creates could both pass;
  with two people that is accepted.
- **Reorder** must list exactly the active labels, once each (else 400);
  archived labels keep their `sort_order`. It costs one SELECT per label
  inside `mutateMany`, fine for a few dozen labels.
- **Status codes.** 201 for creating notes, tasks and labels; 200 otherwise,
  including `POST /api/links`, which returns the existing link with
  `event: null` when the pair is already linked.
- **Activity filters.** `user_id` matches `actor_user_id`, so "by person"
  includes Claude acting for that person; adding `actor=human` narrows it to
  their own actions. `from`/`to` are local dates at the fixed UTC+2 offset
  (no daylight saving): `ts >= from-1 22:00Z` and `ts < to 22:00Z`;
  `from` after `to` is a 400.
- **History** exists for notes, tasks, labels and captures (other types are
  a 400, unknown ids a 404). Notes and tasks include the link events that
  involve them. Provenance counts only an item's own events, so linking does
  not make someone its last changer.
- **Runs.** `RunView.capture_ids` lists only captures that exist, sorted.
  `/api/runs` is newest first (`started_at`, then id); `before` means
  started strictly earlier; `limit` is 1–200, default 50, as for events.
- **Settings.** `PUT /api/settings/:key` with an unknown key is a 404; the
  response is `{ settings }`. Keyterms are trimmed, not deduplicated.
- **Field rules.** Ids are 1–64 characters. Initials are trimmed and
  upper-cased before the 1–3 letters-or-digits check (Unicode letters
  allowed). Limits read like "20 000" (South African number style).
- **Archiving does not unlink.** Links to archived items stay in the links
  table and in bootstrap; the app skips edges whose ends are not loaded.
- **Reverts go straight through `mutate`**, not the API's rules: reverting a
  label rename or archive can leave two active labels with one name, and a
  reverted setting is not re-validated (it was valid when written).
  `defaultLabelId()` ignores an archived default label.
- **`apiRouter` sets `onError(jsonError)` itself**, so its routes answer with
  JSON errors wherever it is mounted; `/api/sessions` is mounted next to it
  in `app.ts`.

## Front end

- **One store, optimistic changes.** `PlannerStore` (`lib/sync.ts`) holds the
  bootstrap state. A change shows at once; while its request is in flight
  the change feed holds that row back (`held`, with the poll's highest seq),
  and a row our own change already moved past is not rolled back by an older
  poll or an older answer of ours (`seen` seqs). When the request settles,
  the held row wins unless our change committed after that poll, since later
  polls start past it and would never bring it again. On failure the held
  row, or else the row as it was, is put back, a toast explains, and
  whatever was typed stays in its field.
- **Polling.** Every 5 s while the tab is visible, once on focus or when it
  becomes visible, never two at once, `more` polls again at once, `reset`
  reloads the bootstrap. Network errors back off (10 s doubling to 60 s)
  without toasts; after two failures a quiet notice says the planner cannot
  be reached. A 401 anywhere goes to `/login?next=<path and query>`.
- **Routes.** `/board`, `/list`, `/activity`, `/settings` with the History
  API; `/` replaces itself with `/board` (768 px and wider) or `/list`. The
  open item is `?item=task:<id>` on any route, so Back closes the panel on a
  phone and an event title is a real link that also opens in a new tab.
  There is no inbox route or placeholder until phase 2.
- **The canvas loads on demand.** React Flow and its styles are a separate
  chunk (`React.lazy`), so phones that open the list first do not load it.
- **Saving positions.** A drag saves on drag stop: one `PATCH` per card that
  moved, never per pixel (selection drags too). Arrow-key moves of a
  selected card are saved 600 ms after the last key press. A resize saves
  `w`/`h` (and `x`/`y` from the top or left handles) on resize end.
- **Cards and links.** Node ids are item keys (`note:<id>`), so links map
  straight onto edges. Tasks are drawn above notes. Links are straight
  lines between the facing sides of the two cards rather than fixed
  handles; the handles only start a new link, and a selected link is lifted
  above the cards with its Unlink button. Delete and Backspace never remove
  cards; they only unlink selected links.
- **Task cards are 220 px wide and about 100 px high** (one-line meta and
  provenance, titles clamped to two lines), matching `board/placement.ts`.
  A task dropped from the tray is centred on the pointer.
- **New items open in the panel.** `+ Note` and a double-click on the empty
  board create a note there; `+ Task` asks only for a title. Both open the
  panel to carry on. Text fields save on blur or Enter (Ctrl/Cmd+Enter in
  multi-line fields).
- **Wording.** People's names are plain bold text; Claude's work carries a
  purple "Claude (via …)" badge. An item's own history says "this task";
  conflicts list the later changes and the fields they touched.
- **Settings.** A label rename saves on Enter or blur; a recolour needs
  "Save colour" (the colour input fires on every movement). Names and
  initials save with a button. The label for new items is a select here,
  since the API already had the setting.
- **Activity.** Filters live in the view, not the URL. New events from the
  poller are merged into the loaded pages; if more than a page arrived in
  between, the feed starts again so there is no gap.
- **Styling.** Plain CSS custom properties, light and dark from
  `prefers-color-scheme` (no in-app switch), system fonts, nothing external.
  On phones every control is at least 44 px; radio chips and swatches are
  real inputs covering the visible chip.
- **Smoke tests** run `wrangler dev` on port 8788 with a fresh database in
  `.wrangler/e2e` (`scripts/e2e-server.sh`) and sign in with the phrases
  from `.dev.vars`; see `e2e/README.md`.
