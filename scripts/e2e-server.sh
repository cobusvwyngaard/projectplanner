#!/usr/bin/env sh
# Starts the Worker for the Playwright tests (playwright.config.ts): a fresh
# local D1 and R2 under .wrangler/e2e, migrations applied, then `wrangler dev`
# on port 8788. Wrangler builds the app first (the build command in
# wrangler.jsonc). Login phrases come from .dev.vars.
set -eu
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
export CI=true
rm -rf .wrangler/e2e
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e
exec npx wrangler dev --local --port 8788 --persist-to .wrangler/e2e --show-interactive-dev-session=false
