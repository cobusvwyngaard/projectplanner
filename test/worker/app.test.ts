import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, PHRASE_1, PHRASE_2, call, signIn, withSession, type SignedIn } from "../helpers/auth";
import { freshDb } from "../helpers/db";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

beforeEach(async () => {
  await freshDb();
});

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Permissions-Policy")).toBe("microphone=(self), camera=(), geolocation=()");
}

describe("test configuration", () => {
  it("uses the phrases from vitest.config.ts whatever .dev.vars says", () => {
    expect(env.LOGIN_PHRASE_1).toBe(PHRASE_1);
    expect(env.LOGIN_PHRASE_2).toBe(PHRASE_2);
  });
});

describe("without a session", () => {
  it("/api/* is a 401 JSON error, before any routing", async () => {
    for (const path of ["/api", "/api/", "/api/bootstrap", "/api/sessions", "/api/no/such/route", "/api/captures/01ABC/audio"]) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("Content-Type"), path).toContain("application/json");
      expect(await res.json(), path).toEqual({ error: { code: "unauthorised", message: "Please sign in to continue." } });
    }
    const post = await call("/api/notes", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
    expect(post.status).toBe(401);
  });

  it("audio is a 401 whatever the method or range", async () => {
    const res = await call("/api/captures/01ABC/audio", { headers: { Range: "bytes=0-99" } });
    expect(res.status).toBe(401);
    expect((await call("/api/captures/01ABC/audio", { method: "HEAD" })).status).toBe(401);
  });

  it("pages send the browser to the phrase page with the path and query to return to", async () => {
    const cases: Array<[string, string]> = [
      ["/", "/login?next=%2F"],
      ["/board", "/login?next=%2Fboard"],
      ["/list?tab=mine&label=x", "/login?next=%2Flist%3Ftab%3Dmine%26label%3Dx"],
      ["/assets/app-fixture.js", "/login?next=%2Fassets%2Fapp-fixture.js"],
      ["/index.html", "/login?next=%2Findex.html"],
    ];
    for (const [path, location] of cases) {
      const res = await call(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe(location);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
    }
  });

  it("serves the files a browser needs before signing in", async () => {
    const manifest = await call("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("Cache-Control")).toBe("no-cache");
    const icon = await call("/icons/icon-fixture.svg");
    expect(icon.status).toBe(200);
    expectSecurityHeaders(icon);
  });

  it("answers a public file that does not exist with a 404, never the app shell", async () => {
    for (const path of ["/sw.js", "/icons/missing.png", "/icons/", "/icons"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("spa-shell");
    }
  });
});

describe("plain http", () => {
  it("is sent to the same address on https before anything else runs", async () => {
    for (const [method, path] of [["GET", "/login?next=%2Fboard"], ["POST", "/token"], ["GET", "/mcp"], ["GET", "/.well-known/oauth-authorization-server"]] as const) {
      const res = await SELF.fetch(`http://planner.test${path}`, { method, redirect: "manual" });
      expect(res.status, path).toBe(308);
      expect(res.headers.get("Location"), path).toBe(`https://planner.test${path}`);
    }
  });

  it("is served as it is on a loopback address (local development)", async () => {
    const res = await SELF.fetch("http://localhost:8788/login", { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("https responses tell browsers to stay on https, except on localhost", async () => {
    for (const path of ["/login", "/board", "/api/sessions"]) {
      const res = await call(path);
      expect(res.headers.get("Strict-Transport-Security"), path).toBe("max-age=31536000");
    }
    const local = await SELF.fetch("https://localhost/login", { redirect: "manual" });
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("with a session", () => {
  let session: SignedIn;

  beforeEach(async () => {
    session = await signIn(PHRASE_1);
  });

  it("serves the app shell for client routes, never cached", async () => {
    for (const path of ["/", "/board", "/settings"]) {
      const res = await call(path, { headers: { Cookie: session.cookie, "Sec-Fetch-Mode": "navigate" } });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('data-fixture="spa-shell"');
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expectSecurityHeaders(res);
    }
  });

  it("lets hashed assets be cached for good", async () => {
    const res = await call("/assets/app-fixture.js", { headers: { Cookie: session.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(res);
  });

  it("answers unknown /api routes with a 404 JSON error", async () => {
    const res = await call("/api/no/such/route", { headers: withSession(session) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(res);
  });

  it("refuses cross-site changes to /api", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const foreign = await call("/api/sessions/revoke-current", {
        method,
        headers: { Cookie: session.cookie, Origin: "https://evil.example" },
      });
      expect(foreign.status, method).toBe(403);
      expect(await foreign.json(), method).toMatchObject({ error: { code: "forbidden" } });
      const nullOrigin = await call("/api/sessions/revoke-current", { method, headers: { Cookie: session.cookie, Origin: "null" } });
      expect(nullOrigin.status, method).toBe(403);
      const crossSite = await call("/api/sessions/revoke-current", {
        method,
        headers: { Cookie: session.cookie, "Sec-Fetch-Site": "cross-site" },
      });
      expect(crossSite.status, method).toBe(403);
    }
    // Still signed in: none of those got through.
    expect((await call("/api/sessions", { headers: withSession(session) })).status).toBe(200);
  });

  it("allows same-origin changes, and changes without an Origin header", async () => {
    const sameSite = await call("/api/no/such/route", {
      method: "POST",
      headers: { Cookie: session.cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameSite.status).toBe(404);
    const noOrigin = await call("/api/no/such/route", { method: "POST", headers: { Cookie: session.cookie } });
    expect(noOrigin.status).toBe(404);
  });

  it("allows cross-site reads (the session cookie is SameSite=Lax anyway)", async () => {
    const res = await call("/api/sessions", { headers: { Cookie: session.cookie, Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });

  it("answers other methods on pages with a 404", async () => {
    const res = await call("/board", { method: "POST", headers: withSession(session) });
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe("security headers", () => {
  it("are on the phrase page, redirects and API errors", async () => {
    const responses = [await call("/login"), await call("/board"), await call("/api/sessions")];
    for (const res of responses) {
      expectSecurityHeaders(res);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
