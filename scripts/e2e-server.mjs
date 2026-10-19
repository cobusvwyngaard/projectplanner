#!/usr/bin/env node
// Starts the Worker for the Playwright tests (playwright.config.ts): a fresh
// local D1 and R2 under .wrangler/e2e, migrations applied, then `wrangler dev`
// on port 8788. Wrangler builds the app first (the build command in
// wrangler.jsonc). Login phrases come from .dev.vars.
import { spawn } from 'child_process';
import { rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CI = 'true';

try {
  rmSync(resolve(root, '.wrangler/e2e'), { recursive: true, force: true });
} catch (e) {
  // ignore
}

const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const apply = spawn(cmd, ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', '.wrangler/e2e'], {
  cwd: root,
  shell: true,
  stdio: ['inherit', 'inherit', 'inherit'],
});

apply.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code);
  }
  const dev = spawn(cmd, ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', '.wrangler/e2e', '--show-interactive-dev-session=false'], {
    cwd: root,
    shell: true,
    stdio: 'inherit',
  });
  dev.on('exit', (c) => {
    process.exit(c ?? 1);
  });
});
