import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/worker/auth/sessions";
import type { AppEnv, GrantProps } from "../../src/worker/env";
import { oauthKv } from "../../src/worker/oauth/kv";
import { providerOptions } from "../../src/worker/oauth/provider";
import { ORIGIN, PHRASE_1, PHRASE_2, call, postLogin, sessionTokenFrom, signIn, type SignedIn } from "../helpers/auth";
import { USER_1, USER_2, freshDb } from "../helpers/db";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const EVIL_URI = "https://evil.example/landing";
const RESOURCE = `${ORIGIN}/mcp`;

beforeEach(async () => {
  await freshDb();
});

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Dynamic client registration (RFC 7591), as claude.ai does it. */
async function registerClient(name = "Claude Test Client", redirectUri = REDIRECT_URI): Promise<string> {
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
  expect(res.status).toBe(201);
  const body = await res.json<{ client_id: string }>();
  return body.client_id;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
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

function consent(query: string, session: SignedIn, decision: string, origin = ORIGIN): Promise<Response> {
  return call(`/authorize?${query}`, {
    method: "POST",
    headers: { Cookie: session.cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision }).toString(),
  });
}

async function exchangeCode(clientId: string, code: string, verifier: string): Promise<Response> {
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

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } },
};

function mcpRequest(token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return call("/mcp", { method: "POST", headers, body: JSON.stringify(INITIALIZE) });
}

/** The JSON-RPC message in a JSON or server-sent-events response. */
async function rpcMessage(res: Response): Promise<{ result?: { serverInfo?: { name?: string } } }> {
  const text = await res.text();
  if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line.startsWith("{"));
    return JSON.parse(data ?? "{}") as { result?: { serverInfo?: { name?: string } } };
  }
  return JSON.parse(text) as { result?: { serverInfo?: { name?: string } } };
}

/** Run the whole flow up to an access token for the user of `phrase`. */
async function connect(phrase: string): Promise<{ accessToken: string; clientId: string }> {
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

describe("/authorize without a session", () => {
  it("sends the browser to the phrase page and back to the consent step", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const query = authorizeQuery(clientId, challenge);
    const res = await call(`/authorize?${query}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(`/authorize?${query}`);

    // Signing in on that page returns to exactly that consent URL.
    const login = await postLogin(PHRASE_1, { next: location.searchParams.get("next") ?? "" });
    expect(login.status).toBe(303);
    expect(login.headers.get("Location")).toBe(`/authorize?${query}`);
    const cookie = `${SESSION_COOKIE}=${sessionTokenFrom(login) ?? ""}`;
    const page = await call(login.headers.get("Location") ?? "", { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
  });

  it("refuses the consent POST too", async () => {
    const query = new URLSearchParams({ client_id: "x", redirect_uri: REDIRECT_URI }).toString();
    const res = await call(`/authorize?${query}`, { method: "POST", headers: { Origin: ORIGIN } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(`/authorize?${query}`)}`);
  });
});

describe("/mcp without a valid bearer token", () => {
  it("is refused with no token at all", async () => {
    const res = await mcpRequest(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("is refused with a made-up token", async () => {
    for (const token of ["made-up-token", `${USER_1}:fakegrant:fakesecret`, "a:b:c"]) {
      const res = await mcpRequest(token);
      expect(res.status, token).toBe(401);
      expect(await res.text(), token).not.toContain("planner");
    }
  });

  it("is refused with a session cookie instead of a token", async () => {
    const session = await signIn(PHRASE_1);
    const res = await call("/mcp", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
  });
});

describe("the consent page", () => {
  it("names the client, the person and where the browser goes next", async () => {
    const clientId = await registerClient("Claude <script>alert(1)</script>");
    const { challenge } = await pkce();
    const query = authorizeQuery(clientId, challenge);
    const session = await signIn(PHRASE_2);
    const res = await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "Allow <strong>Claude &lt;script&gt;alert(1)&lt;/script&gt;</strong> to read and change the planner on behalf of <strong>Person 2</strong>?",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(html).toContain(`action="/authorize?${query.replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`value="allow">Allow</button>`);
    expect(html).toContain(`value="cancel" class="secondary">Cancel</button>`);
    // The request is re-parsed from the URL on POST, never from hidden fields.
    expect(html).not.toContain(`type="hidden"`);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' https:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("shows an error page for an unknown client", async () => {
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const res = await call(`/authorize?${authorizeQuery("no-such-client", challenge)}`, { headers: { Cookie: session.cookie } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link does not work");
  });

  it("sends a request without PKCE back to the client with an error", async () => {
    const clientId = await registerClient();
    const session = await signIn(PHRASE_1);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "s1",
    }).toString();
    const res = await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("s1");
  });

  it("Cancel sends the browser back with access_denied and the state", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const res = await consent(authorizeQuery(clientId, challenge), session, "cancel");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a consent POST from another site", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const res = await consent(authorizeQuery(clientId, challenge), session, "allow", "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses a POST without a decision", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const res = await consent(authorizeQuery(clientId, challenge), session, "maybe");
    expect(res.status).toBe(400);
  });
});

describe("the full connector flow", () => {
  it("register, consent, token, then MCP initialize as the signed-in user", async () => {
    // 1. Dynamic client registration.
    const clientId = await registerClient();

    // 2. The consent page, signed in, with PKCE (S256).
    const { verifier, challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const query = authorizeQuery(clientId, challenge);
    const page = await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("on behalf of <strong>Person 1</strong>");

    // 3. Allow: redirected to the client with a code and the state.
    const allowed = await consent(query, session, "allow");
    expect(allowed.status).toBe(302);
    const location = new URL(allowed.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code") ?? "";
    expect(code.startsWith(`${USER_1}:`)).toBe(true);

    // 4. Exchange the code with the PKCE verifier.
    const tokenRes = await exchangeCode(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const token = await tokenRes.json<{ access_token: string; token_type: string; scope: string }>();
    expect(token.token_type.toLowerCase()).toBe("bearer");
    expect(token.scope).toBe("planner");

    // The grant's props carry the user Claude acts for.
    // getOAuthApi reads only OAUTH_KV; OAUTH_PROVIDER is what it creates.
    const helperEnv: Partial<AppEnv> = { ...env, OAUTH_KV: oauthKv(env.DB) };
    const helpers = getOAuthApi(providerOptions(ORIGIN), helperEnv as AppEnv);
    const summary = await helpers.unwrapToken<GrantProps>(token.access_token);
    expect(summary?.userId).toBe(USER_1);
    expect(summary?.grant.props).toEqual({ userId: USER_1 });
    const grants = await helpers.listUserGrants(USER_1);
    expect(grants.items.map((g) => g.metadata)).toEqual([{ label: "Claude Test Client" }]);

    // 5. MCP initialize with the bearer token.
    const mcp = await mcpRequest(token.access_token);
    expect(mcp.status).toBe(200);
    const message = await rpcMessage(mcp);
    expect(message.result?.serverInfo?.name).toBe("planner");
  });

  it("a code cannot be used without the right PKCE verifier", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const allowed = await consent(authorizeQuery(clientId, challenge), session, "allow");
    const code = new URL(allowed.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const other = await pkce();
    const res = await exchangeCode(clientId, code, other.verifier);
    expect(res.status).toBe(400);
  });

  it("each person's connection acts for that person", async () => {
    const two = await connect(PHRASE_2);
    expect(two.accessToken.startsWith(`${USER_2}:`)).toBe(true);
    const mcp = await mcpRequest(two.accessToken);
    expect(mcp.status).toBe(200);
  });

  it("serves OAuth metadata for the MCP resource", async () => {
    const res = await call("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });
    const as = await call("/.well-known/oauth-authorization-server");
    expect(await as.json()).toMatchObject({
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      scopes_supported: ["planner"],
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("the planner only connects to Claude", () => {
  /** A client stored with a foreign redirect URI, as /register allowed before. */
  async function foreignClient(): Promise<string> {
    const helperEnv: Partial<AppEnv> = { ...env, OAUTH_KV: oauthKv(env.DB) };
    const helpers = getOAuthApi(providerOptions(ORIGIN), helperEnv as AppEnv);
    const client = await helpers.createClient({
      clientName: "Evil",
      redirectUris: [EVIL_URI],
      tokenEndpointAuthMethod: "none",
    });
    return client.clientId;
  }

  async function expectRefused(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This planner only connects to Claude");
    expect(html).not.toContain("evil.example");
  }

  it("never sends the browser to a foreign redirect URI, not even with an error", async () => {
    const clientId = await foreignClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const good = authorizeQuery(clientId, challenge, { redirect_uri: EVIL_URI });
    // Without PKCE the provider would answer with an error redirect.
    const bad = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: EVIL_URI, state: "s" }).toString();
    for (const query of [good, bad]) {
      await expectRefused(await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } }));
      await expectRefused(await consent(query, session, "allow"));
      await expectRefused(await consent(query, session, "cancel"));
      // Signed out, the phrase page is not offered either.
      await expectRefused(await call(`/authorize?${query}`));
    }
  });

  it("refuses a foreign redirect URI for a client registered for Claude", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const query = authorizeQuery(clientId, challenge, { redirect_uri: "https://claude.ai.evil.example/api/mcp/auth_callback" });
    await expectRefused(await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } }));
    const missing = new URLSearchParams({ response_type: "code", client_id: clientId }).toString();
    await expectRefused(await call(`/authorize?${missing}`, { headers: { Cookie: session.cookie } }));
  });

  it("refuses to register a client with any foreign redirect URI", async () => {
    for (const uris of [[EVIL_URI], [REDIRECT_URI, EVIL_URI], ["https://claude.ai/other"], ["http://claude.ai/api/mcp/auth_callback"]]) {
      const res = await call("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Evil", redirect_uris: uris, token_endpoint_auth_method: "none" }),
      });
      expect(res.status, uris.join(" ")).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });

  it("registers Claude's callbacks and local tools on a loopback address", async () => {
    await registerClient("Claude", "https://claude.com/api/mcp/auth_callback");
    const local = await registerClient("MCP Inspector", "http://localhost:6274/oauth/callback");
    await registerClient("Local", "http://127.0.0.1:33418/callback");
    await registerClient("Local v6", "http://[::1]:33418/callback");
    const { challenge } = await pkce();
    const session = await signIn(PHRASE_1);
    const query = authorizeQuery(local, challenge, { redirect_uri: "http://localhost:6274/oauth/callback" });
    const page = await call(`/authorize?${query}`, { headers: { Cookie: session.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("a program on this device");
  });
});
