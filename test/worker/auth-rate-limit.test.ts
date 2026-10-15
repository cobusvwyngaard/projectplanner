import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FAILURES,
  addressKey,
  beginAttempt,
  clientKey,
  recordFailure,
  recordSuccess,
} from "../../src/worker/auth/rate-limit";
import { HOUR_MS, MINUTE_MS, addMs } from "../../src/worker/lib/time";
import { freshDb } from "../helpers/db";

let db: D1Database;
const KEY = "198.51.100.7";
const T0 = new Date("2026-10-14T08:00:00.000Z");

beforeEach(async () => {
  db = await freshDb();
});

async function row(key = KEY) {
  return db
    .prepare(`SELECT failures, locked_until, lockouts, updated_at FROM login_attempts WHERE ip = ?`)
    .bind(key)
    .first<{ failures: number; locked_until: string | null; lockouts: number; updated_at: string }>();
}

/** Fail `count` times at `now`; returns whether every attempt reached the phrase check. */
async function fail(count: number, now: Date, key = KEY): Promise<boolean> {
  let allChecked = true;
  for (let i = 0; i < count; i++) {
    const attempt = await beginAttempt(db, key, now);
    if (attempt === null) {
      allChecked = false;
      continue;
    }
    await recordFailure(db, attempt, now);
  }
  return allChecked;
}

describe("lockout", () => {
  it("allows 5 failures, then locks the address out for 15 minutes", async () => {
    expect(await fail(MAX_FAILURES, T0)).toBe(true);
    expect(await row()).toMatchObject({
      failures: 0,
      lockouts: 1,
      locked_until: addMs(T0, 15 * MINUTE_MS).toISOString(),
    });
    // Refused without counting while locked, even the moment before it ends.
    expect(await beginAttempt(db, KEY, addMs(T0, 14 * MINUTE_MS + 59_000))).toBeNull();
    expect((await row())?.failures).toBe(0);
    // Allowed again once the 15 minutes are over.
    expect(await beginAttempt(db, KEY, addMs(T0, 15 * MINUTE_MS))).toMatchObject({ failures: 1 });
  });

  it("doubles each further lockout: 15, 30, 60 minutes", async () => {
    let now = T0;
    for (const minutes of [15, 30, 60, 120]) {
      expect(await fail(MAX_FAILURES, now)).toBe(true);
      const locked = await row();
      expect(locked?.locked_until).toBe(addMs(now, minutes * MINUTE_MS).toISOString());
      expect(await beginAttempt(db, KEY, addMs(now, minutes * MINUTE_MS - 1000))).toBeNull();
      now = addMs(now, minutes * MINUTE_MS);
    }
    expect((await row())?.lockouts).toBe(4);
  });

  it("keeps doubling past 24 hours for a guesser who tries whenever allowed", async () => {
    let now = T0;
    for (let lockout = 0; lockout < 10; lockout++) {
      const minutes = 15 * 2 ** lockout;
      expect(await fail(MAX_FAILURES, now)).toBe(true);
      expect((await row())?.locked_until, `lockout ${lockout + 1}`).toBe(addMs(now, minutes * MINUTE_MS).toISOString());
      now = addMs(now, minutes * MINUTE_MS);
    }
    // The 10th lockout lasted 7680 minutes (5⅓ days).
    expect((await row())?.lockouts).toBe(10);
  });

  it("bounds the doubling only to keep the numbers finite", async () => {
    await db
      .prepare(`INSERT INTO login_attempts (ip, failures, locked_until, lockouts, updated_at) VALUES (?, 0, NULL, 40, ?)`)
      .bind(KEY, T0.toISOString())
      .run();
    await fail(MAX_FAILURES, T0);
    expect((await row())?.locked_until).toBe(addMs(T0, 15 * 2 ** 20 * MINUTE_MS).toISOString());
  });

  it("forgets the lockout count 24 hours after the last lockout ends", async () => {
    await fail(MAX_FAILURES, T0);
    const second = addMs(T0, 15 * MINUTE_MS);
    await fail(MAX_FAILURES, second);
    const ends = addMs(second, 30 * MINUTE_MS);
    expect(await row()).toMatchObject({ lockouts: 2, locked_until: ends.toISOString() });
    // 24 hours after the lockout started, but not after it ended: still counted.
    const early = addMs(second, 24 * HOUR_MS + 1000);
    await fail(MAX_FAILURES, early);
    expect(await row()).toMatchObject({ lockouts: 3, locked_until: addMs(early, 60 * MINUTE_MS).toISOString() });
    // 24 hours after that lockout ended: back to a first lockout of 15 minutes.
    const later = addMs(early, 60 * MINUTE_MS + 24 * HOUR_MS + 1000);
    await fail(MAX_FAILURES, later);
    expect(await row()).toMatchObject({ lockouts: 1, locked_until: addMs(later, 15 * MINUTE_MS).toISOString() });
  });

  it("measures the 24 hours from the last failure when that is later", async () => {
    await fail(MAX_FAILURES, T0);
    const failure = addMs(T0, 20 * MINUTE_MS);
    await fail(1, failure);
    await fail(MAX_FAILURES - 1, addMs(failure, 24 * HOUR_MS - 1000));
    expect((await row())?.lockouts).toBe(2);
  });

  it("forgets old failures after 24 hours too", async () => {
    await fail(MAX_FAILURES - 1, T0);
    await fail(1, addMs(T0, 25 * HOUR_MS));
    expect(await row()).toMatchObject({ failures: 1, lockouts: 0, locked_until: null });
  });

  it("a success clears the record", async () => {
    await fail(MAX_FAILURES - 1, T0);
    const attempt = await beginAttempt(db, KEY, T0);
    expect(attempt).not.toBeNull();
    await recordSuccess(db, KEY);
    expect(await row()).toBeNull();
    // A fresh start: 5 more failures are needed for a lockout.
    expect(await fail(MAX_FAILURES - 1, T0)).toBe(true);
    expect((await row())?.locked_until).toBeNull();
  });

  it("a right phrase on the 5th attempt still signs in and clears the lockout", async () => {
    await fail(MAX_FAILURES - 1, T0);
    const fifth = await beginAttempt(db, KEY, T0);
    expect(fifth?.failures).toBe(MAX_FAILURES);
    if (fifth) await recordSuccess(db, fifth.key);
    expect(await beginAttempt(db, KEY, T0)).not.toBeNull();
  });

  it("lets at most 5 concurrent attempts through to the phrase check", async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, () => beginAttempt(db, KEY, T0)));
    expect(attempts.filter((a) => a !== null)).toHaveLength(MAX_FAILURES);
  });

  it("keeps addresses apart", async () => {
    await fail(MAX_FAILURES, T0, "198.51.100.1");
    expect(await beginAttempt(db, "198.51.100.1", T0)).toBeNull();
    expect(await beginAttempt(db, "198.51.100.2", T0)).not.toBeNull();
  });
});

describe("client address", () => {
  function requestFrom(ip?: string): Request {
    const headers: Record<string, string> = {};
    if (ip !== undefined) headers["CF-Connecting-IP"] = ip;
    return new Request("https://planner.test/login", { headers });
  }

  it("uses CF-Connecting-IP, or 'unknown' without it", () => {
    expect(clientKey(requestFrom("192.0.2.10"))).toBe("192.0.2.10");
    expect(clientKey(requestFrom())).toBe("unknown");
    expect(clientKey(requestFrom(""))).toBe("unknown");
  });

  it("groups IPv6 addresses by /64", () => {
    const a = addressKey("2001:db8:aaaa:bbbb:1:2:3:4");
    expect(a).toBe("2001:db8:aaaa:bbbb::/64");
    expect(addressKey("2001:0DB8:AAAA:BBBB:ffff::1")).toBe(a);
    expect(addressKey("2001:db8:aaaa:bbbb::")).toBe(a);
    expect(addressKey("2001:db8:aaaa:bbbc::1")).not.toBe(a);
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(addressKey("::ffff:192.0.2.33")).toBe("192.0.2.33");
  });

  it("puts anything unparseable in one bucket", () => {
    expect(addressKey("not an address")).toBe("unknown");
    expect(addressKey("1:2:3:4:5:6:7:8:9")).toBe("unknown");
    expect(addressKey("1::2::3")).toBe("unknown");
    expect(addressKey("300.1.1.1")).toBe("unknown");
  });
});
