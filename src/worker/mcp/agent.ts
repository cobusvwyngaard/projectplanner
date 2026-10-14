// The MCP server Claude talks to (SPEC section 7). One Durable Object per MCP
// session; the OAuth provider has already checked the bearer token and puts
// the grant's props (the user Claude acts for) in this.props.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { GrantProps } from "../env";

// The Durable Object gets the Worker's bindings as they are, without the
// per-request OAUTH_KV and OAUTH_PROVIDER that AppEnv adds, so its env is
// Cloudflare.Env (McpAgent also requires its Env to extend Cloudflare.Env).
export class PlannerMcp extends McpAgent<Cloudflare.Env, Record<string, never>, GrantProps> {
  server = new McpServer({ name: "planner", version: "1.0.0" });

  async init(): Promise<void> {
    // The planner tools are registered here in phase 3 (SPEC section 7).
  }
}
