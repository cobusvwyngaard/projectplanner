# AGENTS.md — rules for coding agents

Shared Planner: a private planner for two people on one Cloudflare Worker
(TypeScript, Hono, D1, R2, React + Vite). SPEC.md is the specification;
docs/architecture.md says where code lives. Read only the parts your task needs.

## Workflow

- Start every task from the latest `main`:
  `git fetch origin && git checkout main && git pull --ff-only`
- Work on the branch the task names (`opencode/<task>`). Never commit to or push
  `main`; the project manager reviews and merges.
- Small commits with clear messages. Push with `git push -u origin <branch>`.
- Stop and report if a command fails twice. Do not guess around errors.
- Never deploy (`wrangler deploy`, `npm run deploy`) unless the task says so.
  Deploys happen when `main` changes.

## Hard rules

1. Never print, log, commit or paste secrets: `LOGIN_PHRASE_1`, `LOGIN_PHRASE_2`,
   `ELEVENLABS_API_KEY`, `.dev.vars`, API tokens. `wrangler secret list` (names
   only) is fine; `wrangler secret put` is not, unless the task says so.
2. Every write to notes, tasks, links, labels, users, settings or capture
   content goes through `mutate()`/`mutateMany()` in `src/worker/mutate/`.
   No other code may INSERT/UPDATE/DELETE those tables
   (`test/unit/write-paths.test.ts` fails otherwise).
3. Do not weaken login, sessions, provenance/revert or the Claude guardrails
   (SPEC sections 1, 3, 4.1, 5).
4. South African English in all UI text and comments: colour, organise,
   behaviour, cancelled.
5. TypeScript strict. No `any`, no dead code, no TODO comments.
6. No new npm dependencies unless the task allows it.

## Commands

```
npm ci                 # install (once per clone / after package-lock changes)
npx tsc -b             # typecheck — must be clean
npx vitest run         # unit and Worker tests — must pass
npm run build          # app + Worker build check — must pass
npx playwright test    # browser smoke tests (needs Chromium; see e2e/README.md)
npm run dev            # local app on http://localhost:8787 (uses .dev.vars)
```

Local development needs `.dev.vars` (copy `.dev.vars.example`; placeholders
only, never real values).

## Report at the end of every task

1. Branch name and final commit SHA.
2. Files changed, one line each.
3. Output summary of `npx tsc -b`, `npx vitest run`, `npm run build`
   (pass/fail and test counts).
4. Anything you could not do, and why.
