// Worker entry (docs/architecture.md): every request goes through the OAuth
// provider (oauth/provider.ts); the cron runs cron.ts.

import { runScheduled } from "./cron";
import type { AppEnv } from "./env";
import { PlannerMcp } from "./mcp/agent";
import { oauthKv } from "./oauth/kv";
import { providerFor } from "./oauth/provider";
import { refuseForeignRegistration } from "./oauth/redirects";

export { PlannerMcp };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/register" && request.method === "POST") {
      const refused = await refuseForeignRegistration(request);
      if (refused) return refused;
    }
    // A per-request copy of env with the D1-backed store the provider needs.
    // The provider adds OAUTH_PROVIDER to this copy before any handler runs.
    const appEnv = { ...env, OAUTH_KV: oauthKv(env.DB) } as AppEnv;
    return providerFor(url.origin).fetch(request, appEnv, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
