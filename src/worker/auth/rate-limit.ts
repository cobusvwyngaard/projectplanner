// Guessing protection for the login form (SPEC 3.3), kept in D1.
//
// Per client address: after 5 failed attempts the address is locked out for
// 15 minutes, and each further lockout doubles that (15, 30, 60 minutes ...,
// with no upper limit). Failures start again from 0 at each lockout. A
// success clears the record. 24 hours after the end of the last lockout or
// the last failure, whichever is later, the failures and the lockout count
// start again from 0, so a long lockout never ends in a fresh start.
//
// An attempt is counted BEFORE the phrase is checked, in one atomic upsert
// that refuses while the address is locked out. The 5th attempt sets the
// lockout in that same statement, so concurrent requests never get more than
// 5 phrase checks per window and a locked address never reaches the phrase
// check. If that 5th attempt turns out to be right, the success clears it.

import { DAY_MS, addMs, iso } from "../lib/time";

export const MAX_FAILURES = 5;
export const FIRST_LOCKOUT_MINUTES = 15;
/** Doublings stop here only to keep the numbers finite (15 × 2^20 minutes is about 30 years). */
export const MAX_LOCKOUT_DOUBLINGS = 20;
export const LOCKOUT_DECAY_MS = DAY_MS;

/** The address the limit applies to: CF-Connecting-IP, IPv6 grouped by /64. */
export function clientKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP")?.trim();
  if (!ip) return "unknown";
  return addressKey(ip);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** An IPv4 address as is; an IPv6 address as its /64 prefix; anything else as "unknown". */
export function addressKey(ip: string): string {
  if (isIpv4(ip)) return ip;
  const groups = ipv6Groups(ip.toLowerCase());
  if (groups === null) return "unknown";
  // IPv4-mapped (::ffff:a.b.c.d) is really an IPv4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function ipv6Groups(input: string): number[] | null {
  const address = input.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? "";
      if (i === pieces.length - 1 && piece.includes(".")) {
        if (!isIpv4(piece)) return null;
        const [a = 0, b = 0, c = 0, d = 0] = piece.split(".").map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** An attempt that may go on to the phrase check. */
export interface Attempt {
  key: string;
  /** Attempts counted in this window, this one included */
  failures: number;
}

/**
 * Count an attempt for this address before the phrase is checked. Returns
 * null, without counting anything, while the address is locked out.
 */
export async function beginAttempt(db: D1Database, key: string, now: Date = new Date()): Promise<Attempt | null> {
  // In an upsert's SET clause every column name means the value before the
  // update. `quiet` is true when the last failure and the end of the last
  // lockout (ISO strings compare in time order) are both over 24 hours ago.
  const quiet = `max(updated_at, COALESCE(locked_until, updated_at)) < ?3`;
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (ip, failures, locked_until, lockouts, updated_at)
       VALUES (?1, 1, NULL, 0, ?2)
       ON CONFLICT (ip) DO UPDATE SET
         failures = CASE WHEN ${quiet} OR failures >= ?4 THEN 1 ELSE failures + 1 END,
         lockouts = CASE WHEN ${quiet} THEN 0 ELSE lockouts END,
         locked_until = CASE
           WHEN NOT (${quiet}) AND failures + 1 = ?4
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || (?5 * (1 << min(lockouts, ?6))) || ' minutes')
           ELSE NULL
         END,
         updated_at = ?2
       WHERE locked_until IS NULL OR locked_until <= ?2
       RETURNING failures`,
    )
    .bind(key, iso(now), iso(addMs(now, -LOCKOUT_DECAY_MS)), MAX_FAILURES, FIRST_LOCKOUT_MINUTES, MAX_LOCKOUT_DOUBLINGS)
    .first<{ failures: number }>();
  return row ? { key, failures: row.failures } : null;
}

/**
 * The phrase was wrong. On the 5th failure the lockout set by beginAttempt()
 * stands: the failures start again from 0 and the lockout count goes up, so
 * the next lockout lasts twice as long.
 */
export async function recordFailure(db: D1Database, attempt: Attempt, now: Date = new Date()): Promise<void> {
  if (attempt.failures < MAX_FAILURES) return;
  await db
    .prepare(
      `UPDATE login_attempts SET failures = 0, lockouts = lockouts + 1, updated_at = ?
       WHERE ip = ? AND failures >= ?`,
    )
    .bind(iso(now), attempt.key, MAX_FAILURES)
    .run();
}

/** The phrase was right: forget this address's failures and lockouts. */
export async function recordSuccess(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(key).run();
}
