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

## Provenance and revert

- **Reverting a creation archives the item** (nothing is ever deleted).
  Captures, users and settings cannot be archived, so their creation cannot
  be reverted.
- **Conflict rule.** A revert warns when a later event on the same item set
  any field the revert would set back; for a creation, any later change
  counts. A person's earlier revert of an event in the same run is not a
  conflict for a whole-run revert.
- **Whole-run revert is one transaction** (`mutateMany`), newest event
  first, so it either fully applies or not at all.
- **Only people can revert.** Claude has no revert tool and mutate refuses
  `revert` from any other actor.
