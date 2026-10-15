#!/usr/bin/env sh
# Production deploy (`npm run deploy`, see SETUP.md): apply the D1 migrations,
# then deploy the Worker (wrangler builds the app first).
#
# `wrangler deploy` creates the D1 database and the R2 bucket named in
# wrangler.jsonc when they do not exist yet, but `wrangler d1 migrations
# apply` cannot run before the database exists. So when the migrations report
# that the database is missing (the very first deploy), the Worker is deployed
# first, which creates it, and the migrations are applied straight after.
set -eu
cd "$(dirname "$0")/.."
log=$(mktemp)
trap 'rm -f "$log"' EXIT
# Only stderr goes to the log, so wrangler's confirmation prompt still shows.
if npx wrangler d1 migrations apply DB --remote 2>"$log"; then
  cat "$log" >&2
  npx wrangler deploy
elif grep -q "Couldn't find a D1 DB" "$log"; then
  echo "There is no D1 database yet: deploying first, which creates it, then applying the migrations." >&2
  npx wrangler deploy
  npx wrangler d1 migrations apply DB --remote
else
  cat "$log" >&2
  exit 1
fi
