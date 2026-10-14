import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { User } from "../shared/types";

/**
 * The Worker environment as the code sees it. Secrets are optional: a deploy
 * without them must fail closed, never open.
 */
export type AppEnv = Omit<Env, "LOGIN_PHRASE_1" | "LOGIN_PHRASE_2" | "ELEVENLABS_API_KEY" | "TRANSCRIBER"> & {
  LOGIN_PHRASE_1?: string;
  LOGIN_PHRASE_2?: string;
  ELEVENLABS_API_KEY?: string;
  /** "mock" in tests and local development only */
  TRANSCRIBER?: string;
  /** KV-compatible store for the OAuth provider, backed by D1 (src/worker/oauth/kv.ts) */
  OAUTH_KV: KVNamespace;
  /** Injected by @cloudflare/workers-oauth-provider */
  OAUTH_PROVIDER: OAuthHelpers;
};

/** Hono generics for routes behind the session check. */
export interface AppBindings {
  Bindings: AppEnv;
  Variables: {
    user: User;
    sessionId: string;
  };
}

/** Props stored in an OAuth grant and passed to the MCP agent. */
export interface GrantProps extends Record<string, unknown> {
  userId: string;
}
