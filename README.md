# Shared Planner

A private two-person project planner on one Cloudflare Worker (D1, R2 and a
Durable Object for the Claude connector). SPEC.md says what it does,
docs/architecture.md where things live and DECISIONS.md why. SETUP.md covers
deploying, the login phrases and signing in.

Key features: collaborative canvas and task list, activity history with attribution, Inbox and voice/upload/text capture with transcription (ElevenLabs), labels, due dates and keyboard-friendly panels.

```
npm ci
cp .dev.vars.example .dev.vars   # local phrases (placeholders)
npm run db:migrate:local
npm run dev                      # builds the app (dist/client) and starts the local Worker
npm run check                    # typecheck, tests and build
npm run test:e2e                 # Playwright smoke tests (e2e/README.md); uses scripts/e2e-server.mjs
```
