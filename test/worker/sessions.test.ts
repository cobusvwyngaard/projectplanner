import { beforeEach, describe, expect, it } from "vitest";
import type { SessionsResponse } from "../../src/shared/api";
import {
  SESSION_COOKIE,
  createSession,
  hashToken,
  revokeAllForUser,
  revokeSession,
  validateSession,
} from "../../src/worker/auth/sessions";
import { DAY_MS, MINUTE_MS, addMs } from "../../src/worker/lib/time";
import { ORIGIN, PHRASE_1, PHRASE_2, call, sessionTokenFrom, signIn, withSession } from "../helpers/auth";
import { USER_1, USER_2, allEvents, freshDb } from "../helpers/db";

let db: D1Database;
const T0 = new Date("2026-10-14T08:00:00.000Z");
const CLEARED = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

beforeEach(async () => {
  db = await freshDb();
});

async function sessionRow(id: string) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first<{ last_seen_at: string; revoked_at: string | null }>();
}

async function sessionIdFor(token: string): Promise<string> {
  const row = await db.prepare(`SELECT id FROM sessions WHERE token_hash = ?`).bind(await hashToken(token)).first<{ id: string }>();
  return row?.id ?? "";
}

describe("validateSession", () => {
  it("accepts a fresh session and returns its user", async () => {
    const { token, sessionId } = await createSession(db, USER_2, "Agent", T0);
    const valid = await validateSession(db, token, addMs(T0, MINUTE_MS));
    expect(valid?.session.id).toBe(sessionId);
    expect(valid?.user).toMatchObject({ id: USER_2, display_name: "Person 2", initials: "P2" });
    expect(valid?.refreshed).toBe(false);
  });

  it("rejects unknown and malformed tokens", async () => {
    await createSession(db, USER_1, null, T0);
    expect(await validateSession(db, "A".repeat(43), T0)).toBeNull();
    expect(await validateSession(db, "short", T0)).toBeNull();
    expect(await validateSession(db, "", T0)).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const { token, sessionId } = await createSession(db, USER_1, null, T0);
    expect(await revokeSession(db, USER_1, sessionId, T0)).toBe(true);
    expect(await validateSession(db, token, T0)).toBeNull();
    expect(await revokeSession(db, USER_1, sessionId, T0)).toBe(false);
  });

  it("refreshes last_seen_at when it is more than 10 minutes old", async () => {
    const { token, sessionId } = await createSession(db, USER_1, null, T0);
    const soon = await validateSession(db, token, addMs(T0, 10 * MINUTE_MS));
    expect(soon?.refreshed).toBe(false);
    expect((await sessionRow(sessionId))?.last_seen_at).toBe(T0.toISOString());
    const later = addMs(T0, 11 * MINUTE_MS);
    const refreshed = await validateSession(db, token, later);
    expect(refreshed?.refreshed).toBe(true);
    expect(refreshed?.session.last_seen_at).toBe(later.toISOString());
    expect((await sessionRow(sessionId))?.last_seen_at).toBe(later.toISOString());
  });

  it("expires 400 days after the last use, and using it keeps it alive", async () => {
    const { token } = await createSession(db, USER_1, null, T0);
    const day399 = addMs(T0, 399 * DAY_MS);
    expect(await validateSession(db, token, day399)).not.toBeNull();
    // Used on day 399, so it is still valid on day 600.
    expect(await validateSession(db, token, addMs(T0, 600 * DAY_MS))).not.toBeNull();
    expect(await validateSession(db, token, addMs(T0, 1001 * DAY_MS))).toBeNull();
  });
});

describe("sessions over HTTP", () => {
  it("re-issues the cookie when the session is refreshed on use", async () => {
    const session = await signIn(PHRASE_1);
    const fresh = await call("/api/sessions", { headers: withSession(session) });
    expect(fresh.headers.getSetCookie()).toEqual([]);

    const id = await sessionIdFor(session.token);
    const old = addMs(new Date(), -11 * MINUTE_MS).toISOString();
    await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(old, id).run();
    const res = await call("/api/sessions", { headers: withSession(session) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      `${SESSION_COOKIE}=${session.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`,
    ]);
    expect((await sessionRow(id))?.last_seen_at).not.toBe(old);
  });

  it("a revoked session gets 401 from /api and the phrase page for pages", async () => {
    const session = await signIn(PHRASE_1);
    await revokeSession(db, USER_1, await sessionIdFor(session.token));
    const api = await call("/api/sessions", { headers: withSession(session) });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: { code: "unauthorised", message: "Please sign in to continue." } });
    const page = await call("/board", { headers: { Cookie: session.cookie } });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/login?next=%2Fboard");
  });

  it("lists active sessions of both users, most recent first, marking this one", async () => {
    const mine = await signIn(PHRASE_1, { userAgent: "Phone" });
    const theirs = await signIn(PHRASE_2, { userAgent: "Laptop" });
    const gone = await signIn(PHRASE_2, { userAgent: "Old tablet" });
    await revokeSession(db, USER_2, await sessionIdFor(gone.token));
    const myId = await sessionIdFor(mine.token);
    await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(addMs(new Date(), -5 * MINUTE_MS).toISOString(), myId).run();

    const res = await call("/api/sessions", { headers: withSession(mine) });
    expect(res.status).toBe(200);
    const body = await res.json<SessionsResponse>();
    expect(body.sessions.map((s) => [s.user_id, s.user_agent, s.current])).toEqual([
      [USER_2, "Laptop", false],
      [USER_1, "Phone", true],
    ]);
    expect(body.sessions.every((s) => s.revoked_at === null)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("token");
    expect(JSON.stringify(body)).not.toContain(theirs.token);
  });

  it("signs out any session, the other user's included, with an event", async () => {
    const mine = await signIn(PHRASE_1);
    const theirs = await signIn(PHRASE_2);
    const theirId = await sessionIdFor(theirs.token);
    const res = await call(`/api/sessions/${theirId}/revoke`, { method: "POST", headers: withSession(mine) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await call("/api/sessions", { headers: withSession(theirs) })).status).toBe(401);
    expect((await call("/api/sessions", { headers: withSession(mine) })).status).toBe(200);
    const revoke = (await allEvents()).filter((e) => e.action === "session_revoke");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toMatchObject({ actor_kind: "human", actor_user_id: USER_1, entity_id: theirId });
    expect(revoke[0]?.after?.revoked_at).toBe((await sessionRow(theirId))?.revoked_at);
  });

  it("revoking this browser's own row clears its cookie", async () => {
    const mine = await signIn(PHRASE_1);
    const id = await sessionIdFor(mine.token);
    const res = await call(`/api/sessions/${id}/revoke`, { method: "POST", headers: withSession(mine) });
    expect(res.headers.getSetCookie()).toEqual([CLEARED]);
  });

  it("404s for unknown or already revoked sessions", async () => {
    const mine = await signIn(PHRASE_1);
    const res = await call(`/api/sessions/01NOSUCHSESSION0000000000/revoke`, { method: "POST", headers: withSession(mine) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("revoke-mine signs out every browser of this user and only this user", async () => {
    const a = await signIn(PHRASE_1);
    const b = await signIn(PHRASE_1);
    const other = await signIn(PHRASE_2);
    const res = await call("/api/sessions/revoke-mine", { method: "POST", headers: withSession(a) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([CLEARED]);
    expect((await call("/api/sessions", { headers: withSession(a) })).status).toBe(401);
    expect((await call("/api/sessions", { headers: withSession(b) })).status).toBe(401);
    expect((await call("/api/sessions", { headers: withSession(other) })).status).toBe(200);
    const revokes = (await allEvents()).filter((e) => e.action === "session_revoke");
    expect(revokes).toHaveLength(2);
    expect(revokes.every((e) => e.actor_kind === "human" && e.actor_user_id === USER_1)).toBe(true);
  });

  it("revoke-current signs out only this browser", async () => {
    const a = await signIn(PHRASE_1);
    const b = await signIn(PHRASE_1);
    const res = await call("/api/sessions/revoke-current", { method: "POST", headers: withSession(a) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([CLEARED]);
    expect((await call("/api/sessions", { headers: withSession(a) })).status).toBe(401);
    expect((await call("/api/sessions", { headers: withSession(b) })).status).toBe(200);
  });

  it("revokeAllForUser writes one event per session in one go", async () => {
    await createSession(db, USER_1, null, T0);
    await createSession(db, USER_1, null, T0);
    expect(await revokeAllForUser(db, USER_1, T0)).toBe(2);
    expect(await revokeAllForUser(db, USER_1, T0)).toBe(0);
    expect((await allEvents()).filter((e) => e.action === "session_revoke")).toHaveLength(2);
  });

  it("sessions from a new sign-in work straight away", async () => {
    const res = await call("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams({ phrase: PHRASE_2, next: "/list" }).toString(),
    });
    const token = sessionTokenFrom(res);
    expect(token).not.toBeNull();
    const me = await call("/api/sessions", { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    expect(me.status).toBe(200);
  });
});
