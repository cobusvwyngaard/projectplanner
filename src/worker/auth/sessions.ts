// Browser sessions (SPEC 3.2). The cookie holds a random 256-bit token; D1
// stores only its SHA-256 hash. Sessions last 400 days from their last use
// and are refreshed on use. Signing in and revoking are logged as events.

import type { Session, User } from "../../shared/types";
import { DAY_MS, MINUTE_MS, addMs, iso } from "../lib/time";
import { ulid } from "../lib/ulid";
import { humanActor } from "../mutate/actor";
import { eventStatement } from "../mutate/events";

export const SESSION_COOKIE = "__Host-planner_session";
export const SESSION_TTL_DAYS = 400;
export const SESSION_MAX_AGE_S = SESSION_TTL_DAYS * 24 * 60 * 60;
/** last_seen_at is written at most this often, and the cookie re-issued with it. */
export const REFRESH_AFTER_MS = 10 * MINUTE_MS;
export const USER_AGENT_MAX = 300;

const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ATTEMPTS = 3;

export interface ValidSession {
  session: Session;
  user: User;
  /** last_seen_at was moved on: send the cookie again so its expiry slides too */
  refreshed: boolean;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE_S}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/** The session token from the request's Cookie header, if it has a well-formed one. */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (TOKEN_RE.test(value)) return value;
  }
  return null;
}

function oldestValidLastSeen(now: Date): string {
  return iso(addMs(now, -SESSION_TTL_DAYS * DAY_MS));
}

/** Start a session for a user and log the sign-in, in one transaction. */
export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<{ token: string; sessionId: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const sessionId = ulid(now.getTime());
  const ts = iso(now);
  const agent = userAgent === null ? null : userAgent.slice(0, USER_AGENT_MAX);
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(sessionId, userId, await hashToken(token), ts, ts, agent),
    eventStatement(db, {
      id: ulid(now.getTime()),
      ts,
      actor: humanActor(userId),
      entityType: "session",
      entityId: sessionId,
      action: "login",
      before: null,
      after: { user_agent: agent },
      sourceCaptureIds: null,
      revertsEventId: null,
    }),
  ]);
  return { token, sessionId };
}

/**
 * The session and user for a token: not revoked and used within the last 400
 * days. Moves last_seen_at on when it is more than 10 minutes old.
 */
export async function validateSession(
  db: D1Database,
  token: string,
  now: Date = new Date(),
): Promise<ValidSession | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT s.id AS s_id, s.user_id, s.created_at AS s_created_at, s.last_seen_at, s.user_agent,
              u.email, u.display_name, u.initials, u.created_at AS u_created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.last_seen_at > ?`,
    )
    .bind(await hashToken(token), oldestValidLastSeen(now))
    .first<{
      s_id: string;
      user_id: string;
      s_created_at: string;
      last_seen_at: string;
      user_agent: string | null;
      email: string | null;
      display_name: string;
      initials: string;
      u_created_at: string;
    }>();
  if (!row) return null;

  let lastSeen = row.last_seen_at;
  let refreshed = false;
  if (lastSeen < iso(addMs(now, -REFRESH_AFTER_MS))) {
    const ts = iso(now);
    const result = await db
      .prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(ts, row.s_id)
      .run();
    // Revoked between the read and the write: the session is no longer valid.
    if (result.meta.changes === 0) return null;
    lastSeen = ts;
    refreshed = true;
  }
  return {
    session: {
      id: row.s_id,
      user_id: row.user_id,
      created_at: row.s_created_at,
      last_seen_at: lastSeen,
      user_agent: row.user_agent,
      revoked_at: null,
    },
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      initials: row.initials,
      created_at: row.u_created_at,
    },
    refreshed,
  };
}

/** Active sessions of both users, most recently used first. */
export async function listActiveSessions(db: D1Database, now: Date = new Date()): Promise<Session[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, created_at, last_seen_at, user_agent, revoked_at FROM sessions
       WHERE revoked_at IS NULL AND last_seen_at > ?
       ORDER BY last_seen_at DESC, id DESC`,
    )
    .bind(oldestValidLastSeen(now))
    .all<Session>();
  return results;
}

/**
 * Revoke sessions and log one session_revoke event per session, all in one
 * transaction. Each UPDATE is followed by a write guard, so if another
 * request revoked one of them first nothing is written and we start again.
 */
async function revokeIds(
  db: D1Database,
  actorUserId: string,
  find: () => Promise<string[]>,
  now: Date,
): Promise<number> {
  const ts = iso(now);
  for (let attempt = 1; ; attempt++) {
    const ids = await find();
    if (ids.length === 0) return 0;
    const statements = ids.flatMap((id) => [
      db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(ts, id),
      db.prepare(`INSERT INTO write_guard (expected, actual, reason) VALUES (1, changes(), 'session')`),
      eventStatement(db, {
        id: ulid(now.getTime()),
        ts,
        actor: humanActor(actorUserId),
        entityType: "session",
        entityId: id,
        action: "session_revoke",
        before: { revoked_at: null },
        after: { revoked_at: ts },
        sourceCaptureIds: null,
        revertsEventId: null,
      }),
    ]);
    try {
      await db.batch(statements);
      return ids.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("write_guard:") || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

/** Revoke one active session (of either user). Returns false if it was not active. */
export async function revokeSession(
  db: D1Database,
  actorUserId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const revoked = await revokeIds(
    db,
    actorUserId,
    async () => {
      const row = await db
        .prepare(`SELECT id FROM sessions WHERE id = ? AND revoked_at IS NULL AND last_seen_at > ?`)
        .bind(sessionId, oldestValidLastSeen(now))
        .first<{ id: string }>();
      return row ? [row.id] : [];
    },
    now,
  );
  return revoked > 0;
}

/** Revoke every session of the signed-in user, this one included. Returns how many. */
export async function revokeAllForUser(db: D1Database, actorUserId: string, now: Date = new Date()): Promise<number> {
  return revokeIds(
    db,
    actorUserId,
    async () => {
      const { results } = await db
        .prepare(`SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND last_seen_at > ? ORDER BY id`)
        .bind(actorUserId, oldestValidLastSeen(now))
        .all<{ id: string }>();
      return results.map((r) => r.id);
    },
    now,
  );
}
