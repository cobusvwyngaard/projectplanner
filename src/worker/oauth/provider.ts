// The OAuth provider (SPEC 3.5): it answers /token, /register and
// /.well-known/*, checks the bearer token on /mcp before handing the request
// to PlannerMcp, and passes everything else to the Hono app.

import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { app } from "../app";
import type { AppEnv } from "../env";
import { PlannerMcp } from "../mcp/agent";

const mcpHandler = PlannerMcp.serve("/mcp");

/**
 * Access tokens are bound to the MCP URL of the origin they were issued on
 * (RFC 8707), and the provider needs that URL, absolute, when it is built.
 */
export function providerOptions(origin: string): OAuthProviderOptions<AppEnv> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: app,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["planner"],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Shared Planner" },
  };
}

// The Worker answers on whichever hostnames its routes give it, so there is
// one provider per origin. Only routed hostnames reach the Worker, so this
// stays tiny; the cap is a safeguard.
const MAX_PROVIDERS = 8;
const providers = new Map<string, OAuthProvider<AppEnv>>();

export function providerFor(origin: string): OAuthProvider<AppEnv> {
  const cached = providers.get(origin);
  if (cached) return cached;
  const provider = new OAuthProvider<AppEnv>(providerOptions(origin));
  if (providers.size >= MAX_PROVIDERS) {
    const oldest = providers.keys().next();
    if (!oldest.done) providers.delete(oldest.value);
  }
  providers.set(origin, provider);
  return provider;
}
