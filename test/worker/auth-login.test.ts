import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LOGIN_FAILED_MESSAGE } from "../../src/worker/auth/login-page";
import { normalise } from "../../src/worker/auth/phrase";
import { SESSION_COOKIE, hashToken } from "../../src/worker/auth/sessions";
import { MINUTE_MS, addMs } from "../../src/worker/lib/time";
import {
  ORIGIN,
  PHRASE_1,
  PHRASE_2,
  call,
  freshIp,
  postLogin,
  sessionTokenFrom,
  signIn,
  withSession,
} from "../helpers/auth";
import { USER_1, USER_2, allEvents, freshDb } from "../helpers/db";

let db: D1Database;
let consoleSpies: MockInstance[] = [];
/** Every response body and header seen in a test, to check no phrase leaks. */
let seen: string[] = [];

async function record(res: Response): Promise<Response> {
  const body = await res.clone().text();
  seen.push(body, ...[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`));
  return res;
}

beforeEach(async () => {
  db = await freshDb();
  seen = [];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
});

afterEach(() => {
  // Neither phrase, in any spelling, may reach a response or the console.
  const logged = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String));
  const haystack = normalise([...seen, ...logged].join("\n"));
  for (const phrase of [PHRASE_1, PHRASE_2, "wrong phrase guess"]) {
    expect(haystack).not.toContain(normalise(phrase));
  }
  vi.restoreAllMocks();
});

async function sessionUser(token: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT user_id FROM sessions WHERE token_hash = ?`)
    .bind(await hashToken(token))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

describe("the phrase page", () => {
  it("has one phrase field, one button and nothing else to fill in", async () => {
    const res = await record(await call("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<label for="phrase">Enter your phrase</label>`);
    expect(html).toMatch(/<input id="phrase" name="phrase" type="password" autocomplete="current-password"[^>]* autofocus/);
    expect(html).toContain(`<button type="submit">Sign in</button>`);
    expect(html).toContain(`<input type="hidden" name="next" value="/">`);
    expect(html.match(/<input /g)).toHaveLength(2);
    expect(html).not.toMatch(/<script|<link|https?:\/\//i);
    expect(html).not.toMatch(/user ?name|e-?mail|forgot|reset/i);
    expect(html).not.toContain(LOGIN_FAILED_MESSAGE);
  });

  it("escapes the next value it puts in the form", async () => {
    const res = await record(await call(`/login?next=${encodeURIComponent('/board?x="><b>')}`));
    const html = await res.text();
    expect(html).toContain(`value="/board?x=&quot;&gt;&lt;b&gt;"`);
    expect(html).not.toContain(`"><b>`);
  });

  it("sends a signed-in browser straight on", async () => {
    const session = await signIn(PHRASE_1);
    const res = await record(await call("/login?next=%2Fsettings", { headers: { Cookie: session.cookie } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings");
  });
});

describe("signing in", () => {
  it("phrase 1 signs in as user 1 and phrase 2 as user 2", async () => {
    const one = await record(await postLogin(PHRASE_1));
    const two = await record(await postLogin(PHRASE_2));
    expect(one.status).toBe(303);
    expect(two.status).toBe(303);
    expect(await sessionUser(sessionTokenFrom(one) ?? "")).toBe(USER_1);
    expect(await sessionUser(sessionTokenFrom(two) ?? "")).toBe(USER_2);
  });

  it("ignores case, extra spaces and accent encoding", async () => {
    for (const typed of ["  TEST phrase ONE  ", "test\tphrase   one", "Test  Phrase  One"]) {
      const res = await record(await postLogin(typed));
      expect(res.status, typed).toBe(303);
      expect(await sessionUser(sessionTokenFrom(res) ?? "")).toBe(USER_1);
    }
    const res = await record(await postLogin("TEST PHRASE TWO"));
    expect(await sessionUser(sessionTokenFrom(res) ?? "")).toBe(USER_2);
  });

  it("sets the session cookie with exactly the required attributes", async () => {
    const res = await record(await postLogin(PHRASE_1));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000$`),
    );
  });

  it("stores only the SHA-256 hash of the token", async () => {
    const session = await signIn(PHRASE_1);
    const rows = await db.prepare(`SELECT token_hash FROM sessions`).all<{ token_hash: string }>();
    expect(rows.results).toEqual([{ token_hash: await hashToken(session.token) }]);
    expect(rows.results[0]?.token_hash).not.toContain(session.token);
    expect(rows.results[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("goes on to a safe next path, and to / otherwise", async () => {
    const cases: Array<[string, string]> = [
      ["/board?view=list", "/board?view=list"],
      ["/authorize?client_id=x&state=y", "/authorize?client_id=x&state=y"],
      ["//evil.example/path", "/"],
      ["/\\evil.example", "/"],
      ["https://evil.example/", "/"],
      ["board", "/"],
      ["", "/"],
    ];
    for (const [next, location] of cases) {
      const res = await record(await postLogin(PHRASE_1, { next }));
      expect(res.status, next).toBe(303);
      expect(res.headers.get("Location"), next).toBe(location);
    }
  });

  it("logs the sign-in as a human event with the user agent", async () => {
    const res = await record(await postLogin(PHRASE_2, { userAgent: "Test Browser/1.0" }));
    const sessionRow = await db.prepare(`SELECT id FROM sessions`).first<{ id: string }>();
    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_kind: "human",
      actor_user_id: USER_2,
      run_id: null,
      entity_type: "session",
      entity_id: sessionRow?.id,
      action: "login",
      before: null,
      after: { user_agent: "Test Browser/1.0" },
    });
    expect(sessionTokenFrom(res)).not.toBeNull();
  });

  it("truncates a long user agent to 300 characters", async () => {
    await signIn(PHRASE_1, { userAgent: "A".repeat(1000) });
    const row = await db.prepare(`SELECT user_agent FROM sessions`).first<{ user_agent: string }>();
    expect(row?.user_agent).toHaveLength(300);
  });
});

describe("failed sign-in", () => {
  async function expectGenericFailure(res: Response): Promise<void> {
    await record(res);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toContain(LOGIN_FAILED_MESSAGE.replace("'", "&#39;"));
  }

  it("rejects a wrong phrase with the generic message and no session", async () => {
    await expectGenericFailure(await postLogin("wrong phrase guess"));
    await expectGenericFailure(await postLogin(""));
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await allEvents()).toEqual([]);
  });

  it("keeps the next path through a failure", async () => {
    const res = await record(await postLogin("wrong phrase guess", { next: "/inbox" }));
    expect(await res.text()).toContain(`name="next" value="/inbox"`);
  });

  it("locks out after 5 failures: the 6th try with the right phrase is refused", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await expectGenericFailure(await postLogin("wrong phrase guess", { ip }));
    await expectGenericFailure(await postLogin(PHRASE_1, { ip }));
    const row = await db.prepare(`SELECT lockouts, locked_until FROM login_attempts WHERE ip = ?`).bind(ip).first<{
      lockouts: number;
      locked_until: string;
    }>();
    expect(row?.lockouts).toBe(1);
    const minutes = (Date.parse(row?.locked_until ?? "") - Date.now()) / MINUTE_MS;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Another address is not affected.
    expect((await record(await postLogin(PHRASE_1))).status).toBe(303);
  });

  it("doubles the next lockout to 30 minutes", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await postLogin("wrong phrase guess", { ip });
    // Let the first lockout run out.
    await db
      .prepare(`UPDATE login_attempts SET locked_until = ? WHERE ip = ?`)
      .bind(addMs(new Date(), -1000).toISOString(), ip)
      .run();
    expect((await record(await postLogin("wrong phrase guess", { ip }))).status).toBe(401);
    for (let i = 0; i < 4; i++) await postLogin("wrong phrase guess", { ip });
    await expectGenericFailure(await postLogin(PHRASE_1, { ip }));
    const row = await db.prepare(`SELECT lockouts, locked_until FROM login_attempts WHERE ip = ?`).bind(ip).first<{
      lockouts: number;
      locked_until: string;
    }>();
    expect(row?.lockouts).toBe(2);
    const minutes = (Date.parse(row?.locked_until ?? "") - Date.now()) / MINUTE_MS;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it("a success clears the failures", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await postLogin("wrong phrase guess", { ip });
    expect((await record(await postLogin(PHRASE_1, { ip }))).status).toBe(303);
    expect(await db.prepare(`SELECT * FROM login_attempts WHERE ip = ?`).bind(ip).first()).toBeNull();
    for (let i = 0; i < 4; i++) await postLogin("wrong phrase guess", { ip });
    expect((await record(await postLogin(PHRASE_2, { ip }))).status).toBe(303);
  });

  it("counts every address in an IPv6 /64 together", async () => {
    for (let i = 1; i <= 5; i++) await postLogin("wrong phrase guess", { ip: `2001:db8:1:2::${i}` });
    await expectGenericFailure(await postLogin(PHRASE_1, { ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    expect((await record(await postLogin(PHRASE_1, { ip: "2001:db8:1:3::1" }))).status).toBe(303);
  });

  it("refuses a sign-in posted from another site without counting it", async () => {
    const ip = freshIp();
    await expectGenericFailure(await postLogin(PHRASE_1, { ip, origin: "https://evil.example" }));
    expect(await db.prepare(`SELECT * FROM login_attempts WHERE ip = ?`).bind(ip).first()).toBeNull();
  });
});

describe("signing out", () => {
  it("revokes the session, clears the cookie and logs the revocation", async () => {
    const session = await signIn(PHRASE_1);
    const res = await record(await call("/logout", { method: "POST", headers: withSession(session) }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.getSetCookie()).toEqual([
      `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    const after = await record(await call("/api/sessions", { headers: withSession(session) }));
    expect(after.status).toBe(401);
    const revoke = (await allEvents()).find((e) => e.action === "session_revoke");
    expect(revoke).toMatchObject({ actor_kind: "human", actor_user_id: USER_1, entity_type: "session" });
    expect(revoke?.before).toEqual({ revoked_at: null });
    expect(typeof revoke?.after?.revoked_at).toBe("string");
  });

  it("refuses a sign-out posted from another site", async () => {
    const session = await signIn(PHRASE_1);
    const res = await record(
      await call("/logout", { method: "POST", headers: { Cookie: session.cookie, Origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
    expect((await record(await call("/api/sessions", { headers: withSession(session) }))).status).toBe(200);
  });

  it("works without a session too", async () => {
    const res = await record(await call("/logout", { method: "POST", headers: { Origin: ORIGIN } }));
    expect(res.status).toBe(303);
  });
});
