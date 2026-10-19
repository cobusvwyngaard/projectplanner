// Settings > Claude connections (SPEC section 8). Mounted at
// /api/claude-connections behind the session and same-origin checks. The
// connections are the OAuth provider's grants, read straight from it: who
// allowed Claude, as which client, and when. Disconnecting revokes the grant
// (the tokens stop working at once) and writes one session_revoke event.

import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { ClaudeConnectionView, ClaudeConnectionsResponse } from "../../shared/api";
import type { AppBindings } from "../env";
import { NotFoundError } from "../lib/errors";
import { iso } from "../lib/time";
import { ulid } from "../lib/ulid";
import { humanActor } from "../mutate/actor";
import { eventStatement } from "../mutate/events";

/** What a client is called when it registered without a usable name. */
const UNNAMED_CLIENT = "Unnamed client";

export const claudeRouter = new Hono<AppBindings>();

/** One user's grants, following the provider's cursor until it has none left. */
async function grantsOf(provider: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  for (let cursor: string | undefined = undefined; ; ) {
    const page = await provider.listUserGrants(userId, cursor === undefined ? {} : { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) return grants;
  }
}

/** The clients' chosen names, looked up once each. */
async function clientNames(provider: OAuthHelpers, clientIds: Iterable<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const clientId of clientIds) {
    if (names.has(clientId)) continue;
    const client = await provider.lookupClient(clientId);
    names.set(clientId, client?.clientName?.trim() || UNNAMED_CLIENT);
  }
  return names;
}

claudeRouter.get("/", async (c) => {
  const provider = c.env.OAUTH_PROVIDER;
  const { results: users } = await c.env.DB.prepare(`SELECT id FROM users ORDER BY id`).all<{ id: string }>();
  const grants = (
    await Promise.all(users.map((user) => grantsOf(provider, user.id)))
  ).flat();
  const names = await clientNames(
    provider,
    grants.map((grant) => grant.clientId),
  );
  const connections: ClaudeConnectionView[] = grants
    .map((grant) => ({
      id: grant.id,
      user_id: grant.userId,
      client_name: names.get(grant.clientId) ?? UNNAMED_CLIENT,
      // The provider counts in seconds; the API speaks ISO timestamps.
      connected_at: new Date(grant.createdAt * 1000).toISOString(),
    }))
    .sort((a, b) => b.connected_at.localeCompare(a.connected_at) || b.id.localeCompare(a.id));
  const body: ClaudeConnectionsResponse = { connections };
  return c.json(body);
});

claudeRouter.post("/:userId/:grantId/disconnect", async (c) => {
  const provider = c.env.OAUTH_PROVIDER;
  const userId = c.req.param("userId");
  const grantId = c.req.param("grantId");
  const grant = (await grantsOf(provider, userId)).find((candidate) => candidate.id === grantId);
  if (!grant) throw new NotFoundError("No Claude connection with that id.");
  const client = await provider.lookupClient(grant.clientId);
  const clientName = client?.clientName?.trim() || UNNAMED_CLIENT;

  await provider.revokeGrant(grantId, userId);
  const ts = iso(new Date());
  await c.env.DB.batch([
    eventStatement(c.env.DB, {
      id: ulid(),
      ts,
      actor: humanActor(c.get("user").id),
      entityType: "claude_connection",
      entityId: grantId,
      action: "session_revoke",
      before: { user_id: userId, client_name: clientName },
      after: null,
      sourceCaptureIds: null,
      revertsEventId: null,
    }),
  ]);
  return c.json({ ok: true as const });
});
