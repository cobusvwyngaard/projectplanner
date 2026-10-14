// Worker entry (docs/architecture.md): every request goes through the OAuth
// provider (oauth/provider.ts); the cron runs cron.ts.

import { runScheduled } from "./cron";
import type { AppEnv } from "./env";
import { PlannerMcp } from "./mcp/agent";
import { oauthKv } from "./oauth/kv";
import { providerFor } from "./oauth/provider";

export { PlannerMcp };

export default {
  fetch(request, env, ctx) {
    // A per-request copy of env with the D1-backed store the provider needs.
    // The provider adds OAUTH_PROVIDER to this copy before any handler runs.
    const appEnv = { ...env, OAUTH_KV: oauthKv(env.DB) } as AppEnv;
    return providerFor(new URL(request.url).origin).fetch(request, appEnv, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
