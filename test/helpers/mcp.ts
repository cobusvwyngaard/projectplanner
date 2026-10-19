// Helpers for tests that talk to the real MCP endpoint with a real OAuth
// token, the way claude.ai does: dynamic client registration, the consent
// page, the token exchange, then a small JSON-RPC client for /mcp
// (streamable HTTP: one session id per connection).

import { ORIGIN, call, signIn, type SignedIn } from "./auth";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
export const RESOURCE = `${ORIGIN}/mcp`;

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Dynamic client registration (RFC 7591), as claude.ai does it. */
export async function registerClient(name = "Claude Test Client", redirectUri = REDIRECT_URI): Promise<string> {
  const res = await call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status !== 201) throw new Error(`Registration failed with status ${res.status}`);
  const body = await res.json<{ client_id: string }>();
  return body.client_id;
}

export function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "planner",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...extra,
  }).toString();
}

export function consent(query: string, session: SignedIn, decision: string, origin = ORIGIN): Promise<Response> {
  return call(`/authorize?${query}`, {
    method: "POST",
    headers: { Cookie: session.cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision }).toString(),
  });
}

export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<Response> {
  return call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  });
}

/** Run the whole flow up to an access token for the user of `phrase`. */
export async function connect(phrase: string): Promise<{ accessToken: string; clientId: string }> {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const session = await signIn(phrase);
  const query = authorizeQuery(clientId, challenge);
  const allowed = await consent(query, session, "allow");
  const code = new URL(allowed.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const token = await exchangeCode(clientId, code, verifier);
  const body = await token.json<{ access_token: string }>();
  return { accessToken: body.access_token, clientId };
}

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } },
};

/** A raw initialize POST, with or without a bearer token (no session kept). */
export function mcpRequest(token: string | null): Promise<Response> {
  return call("/mcp", { method: "POST", headers: mcpHeaders(token), body: JSON.stringify(INITIALIZE) });
}

function mcpHeaders(token: string | null, sessionId?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (sessionId !== undefined && sessionId !== null) headers["mcp-session-id"] = sessionId;
  return headers;
}

export interface RpcMessage<T = Record<string, unknown>> {
  result?: T;
  error?: { code: number; message: string };
}

/** The JSON-RPC message in a JSON or server-sent-events response. */
export async function rpcMessage<T = Record<string, unknown>>(res: Response): Promise<RpcMessage<T>> {
  const text = await res.text();
  if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line.startsWith("{"));
    return JSON.parse(data ?? "{}") as RpcMessage<T>;
  }
  return JSON.parse(text) as RpcMessage<T>;
}

export interface ToolOutcome {
  /** The tool itself refused (AppError or invalid input) */
  isError: boolean;
  /** The text content of the result */
  text: string;
  /** The text parsed as JSON, or null when it is not JSON */
  json: Record<string, unknown> | null;
}

/** One MCP session over /mcp, with a bearer token. */
export class McpClient {
  private sessionId: string | null = null;

  constructor(private readonly token: string) {}

  /** initialize (which mints the session id), then say the client is ready. */
  async start(): Promise<RpcMessage<{ serverInfo?: { name?: string } }>> {
    const res = await call("/mcp", { method: "POST", headers: mcpHeaders(this.token), body: JSON.stringify(INITIALIZE) });
    if (res.status !== 200) throw new Error(`MCP initialize failed with status ${res.status}`);
    this.sessionId = res.headers.get("mcp-session-id");
    const message = await rpcMessage<{ serverInfo?: { name?: string } }>(res);
    await call("/mcp", {
      method: "POST",
      headers: mcpHeaders(this.token, this.sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return message;
  }

  async request<T = Record<string, unknown>>(method: string, params?: unknown): Promise<RpcMessage<T>> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method };
    if (params !== undefined) body.params = params;
    const res = await call("/mcp", { method: "POST", headers: mcpHeaders(this.token, this.sessionId), body: JSON.stringify(body) });
    if (res.status !== 200) throw new Error(`MCP ${method} failed with status ${res.status}: ${await res.text()}`);
    return rpcMessage<T>(res);
  }

  async listTools(): Promise<{ tools: { name: string; description: string }[] }> {
    const message = await this.request<{ tools: { name: string; description: string }[] }>("tools/list");
    if (message.error) throw new Error(`tools/list failed: ${message.error.message}`);
    return message.result ?? { tools: [] };
  }

  /** Call a tool and report the outcome; a tool error is an outcome, not a throw. */
  async callTool(name: string, args: unknown): Promise<ToolOutcome> {
    const message = await this.request<{ content?: { type: string; text: string }[]; isError?: boolean }>("tools/call", {
      name,
      arguments: args,
    });
    if (message.error) throw new Error(`tools/call ${name} failed: ${message.error.message}`);
    const text = (message.result?.content ?? []).map((c) => c.text).join("\n");
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { isError: message.result?.isError === true, text, json };
  }
}
