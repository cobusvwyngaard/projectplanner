// Settings > Signed-in browsers (SPEC section 8). Mounted at /api/sessions
// behind the session and same-origin checks. Every revocation writes a
// session_revoke event (auth/sessions.ts).

import { Hono } from "hono";
import type { SessionsResponse } from "../../shared/api";
import { clearedSessionCookie, listActiveSessions, revokeAllForUser, revokeSession } from "../auth/sessions";
import type { AppBindings } from "../env";
import { NotFoundError } from "../lib/errors";

export const sessionsRouter = new Hono<AppBindings>();

sessionsRouter.get("/", async (c) => {
  const current = c.get("sessionId");
  const sessions = await listActiveSessions(c.env.DB);
  const body: SessionsResponse = {
    sessions: sessions.map((s) => ({ ...s, current: s.id === current })),
  };
  return c.json(body);
});

sessionsRouter.post("/revoke-mine", async (c) => {
  await revokeAllForUser(c.env.DB, c.get("user").id);
  c.header("Set-Cookie", clearedSessionCookie());
  return c.json({ ok: true as const });
});

sessionsRouter.post("/revoke-current", async (c) => {
  await revokeSession(c.env.DB, c.get("user").id, c.get("sessionId"));
  c.header("Set-Cookie", clearedSessionCookie());
  return c.json({ ok: true as const });
});

sessionsRouter.post("/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const revoked = await revokeSession(c.env.DB, c.get("user").id, id);
  if (!revoked) throw new NotFoundError("No active session with that id.");
  // Signing this browser out through its own row clears its cookie as well.
  if (id === c.get("sessionId")) c.header("Set-Cookie", clearedSessionCookie());
  return c.json({ ok: true as const });
});
