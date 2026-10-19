// Settings > Claude connections (SPEC 8): both people's connections are read
// from the OAuth provider, disconnecting one kills Claude's tokens at once and
// writes one event, and the two routes keep the session, origin and
// not-found guards every /api route has.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeConnectionView, ClaudeConnectionsResponse } from "../../src/shared/api";
import type { AppEnv } from "../../src/worker/env";
import { oauthKv } from "../../src/worker/oauth/kv";
import { providerOptions } from "../../src/worker/oauth/provider";
import { ORIGIN, PHRASE_1, PHRASE_2, call, signIn, withSession, type SignedIn } from "../helpers/auth";
import { USER_1, USER_2, allEvents, freshDb } from "../helpers/db";
import { RESOURCE, authorizeQuery, consent, exchangeCode, mcpRequest, pkce, registerClient } from "../helpers/mcp";

let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

interface Connection {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

/** A connection made the way claude.ai makes one: register, consent, exchange. */
async function connect(phrase: string, clientId: string): Promise<Connection> {
  const { verifier, challenge } = await pkce();
  const session = await signIn(phrase);
  const allowed = await consent(authorizeQuery(clientId, challenge), session, "allow");
  const code = new URL(allowed.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const token = await exchangeCode(clientId, code, verifier);
  expect(token.status).toBe(200);
  const body = await token.json<{ access_token: string; refresh_token?: string }>();
  if (!body.refresh_token) throw new Error("The token response carried no refresh token.");
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** A client registered without a name, so Settings has to name it somehow. */
async function anonymousClient(): Promise<string> {
  const helperEnv: Partial<AppEnv> = { ...env, OAUTH_KV: oauthKv(db) };
  const helpers = getOAuthApi(providerOptions(ORIGIN), helperEnv as AppEnv);
  const client = await helpers.createClient({
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "none",
  });
  return client.clientId;
}

function list(session: SignedIn): Promise<Response> {
  return call("/api/claude-connections", { headers: withSession(session) });
}

async function connectionsOf(session: SignedIn): Promise<ClaudeConnectionView[]> {
  const res = await list(session);
  expect(res.status).toBe(200);
  return (await res.json<ClaudeConnectionsResponse>()).connections;
}

function disconnect(session: SignedIn, userId: string, grantId: string, origin = ORIGIN): Promise<Response> {
  return call(`/api/claude-connections/${userId}/${grantId}/disconnect`, {
    method: "POST",
    headers: { Cookie: session.cookie, Origin: origin },
  });
}

/** Ask the token endpoint to swap the connection's refresh token for a new one. */
function refresh(connection: Connection): Promise<Response> {
  return call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
      client_id: connection.clientId,
      resource: RESOURCE,
    }).toString(),
  });
}

function connectionEvents() {
  return allEvents().then((events) => events.filter((event) => event.entity_type === "claude_connection"));
}

describe("GET /api/claude-connections", () => {
  it("lists both people's connections with the right names, newest first", async () => {
    await connect(PHRASE_1, await registerClient("Claude Desk"));
    await connect(PHRASE_2, await anonymousClient());

    const session = await signIn(PHRASE_1);
    const connections = await connectionsOf(session);
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.user_id).sort()).toEqual([USER_1, USER_2]);
    expect(connections.find((c) => c.user_id === USER_1)?.client_name).toBe("Claude Desk");
    expect(connections.find((c) => c.user_id === USER_2)?.client_name).toBe("Unnamed client");
    expect(connections.every((c) => new Date(c.connected_at).toISOString() === c.connected_at)).toBe(true);

    // The provider counts creation in whole seconds, so two connections made
    // in one test can share a timestamp. Back-date one of them to show the
    // order really is by recency and not by chance.
    const first = connections[0];
    if (!first) throw new Error("No connection was listed.");
    const key = `grant:${first.user_id}:${first.id}`;
    const row = await db.prepare(`SELECT value FROM oauth_kv WHERE key = ?`).bind(key).first<{ value: string }>();
    if (!row) throw new Error("The grant is not stored under the provider's key.");
    const stored = JSON.parse(row.value) as { createdAt: number };
    const backdated = JSON.stringify({ ...stored, createdAt: stored.createdAt - 3600 });
    await db.prepare(`UPDATE oauth_kv SET value = ? WHERE key = ?`).bind(backdated, key).run();

    const ordered = await connectionsOf(session);
    expect(ordered.map((c) => c.id)).toEqual(connections.map((c) => c.id).reverse());
  });

  it("needs a session, like every other API route", async () => {
    expect((await list(await signIn(PHRASE_1))).status).toBe(200);
    await connect(PHRASE_1, await registerClient());

    const anonymous = await call("/api/claude-connections");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: { code: "unauthorised", message: "Please sign in to continue." } });
    expect(await connectionsOf(await signIn(PHRASE_1))).toHaveLength(1);
  });
});

describe("disconnecting a Claude connection", () => {
  it("kills the access token and the refresh token, and writes one event", async () => {
    const connection = await connect(PHRASE_1, await registerClient("Claude Desk"));
    const session = await signIn(PHRASE_1);
    const [listed] = await connectionsOf(session);
    if (!listed) throw new Error("The connection was not listed.");
    expect((await mcpRequest(connection.accessToken)).status).toBe(200);

    const res = await disconnect(session, listed.user_id, listed.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Claude's own credentials stop working at once, both ways round.
    expect((await mcpRequest(connection.accessToken)).status).toBe(401);
    const renewed = await refresh(connection);
    expect(renewed.status).toBe(400);
    expect(await renewed.json()).toMatchObject({ error: "invalid_grant" });
    expect(await connectionsOf(session)).toEqual([]);

    const revokes = (await allEvents()).filter((event) => event.action === "session_revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toMatchObject({
      actor_kind: "human",
      actor_user_id: USER_1,
      entity_type: "claude_connection",
      entity_id: listed.id,
      action: "session_revoke",
      before: { user_id: USER_1, client_name: "Claude Desk" },
      after: null,
      source_capture_ids: null,
      reverts_event_id: null,
    });
  });

  it("404s for a connection that does not exist, writing no event", async () => {
    const session = await signIn(PHRASE_1);
    const unknown = await disconnect(session, USER_1, "01NOSUCHGRANT000000000");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });

    // Nor can one person disconnect the other person's connection.
    const connection = await connect(PHRASE_2, await registerClient());
    const theirs = (await connectionsOf(session)).find((c) => c.user_id === USER_2);
    if (!theirs) throw new Error("Person 2's connection was not listed.");
    const wrongUser = await disconnect(session, USER_1, theirs.id);
    expect(wrongUser.status).toBe(404);
    expect((await mcpRequest(connection.accessToken)).status).toBe(200);

    expect(await connectionEvents()).toEqual([]);
  });

  it("needs a session and refuses a POST from another site", async () => {
    const connection = await connect(PHRASE_1, await registerClient());
    const session = await signIn(PHRASE_1);
    const [listed] = await connectionsOf(session);
    if (!listed) throw new Error("The connection was not listed.");

    const noSession = await call(`/api/claude-connections/${USER_1}/${listed.id}/disconnect`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(noSession.status).toBe(401);

    const crossSite = await disconnect(session, listed.user_id, listed.id, "https://evil.example");
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: { code: "forbidden" } });

    expect(await connectionEvents()).toEqual([]);
    expect((await mcpRequest(connection.accessToken)).status).toBe(200);
  });
});
