// Downloading an email capture's attachments through the Worker (SPEC 11.3):
// after the session check, with the file name and stored type, and nothing for
// an attachment that was not kept. Addresses and names are made up.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { asUser } from "../helpers/api";
import { call, signIn, withSession } from "../helpers/auth";
import { freshDb, USER_1 } from "../helpers/db";

const TS = "2026-10-01T00:00:00.000Z";
const CONTENT = "the file contents";

let db: D1Database;
let api: ReturnType<typeof asUser>;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
  await db
    .prepare(
      `INSERT INTO captures (id, kind, author_user_id, r2_key, mime, text, transcript_status, inbox_status, created_at)
       VALUES ('c1', 'email', NULL, 'emails/2026/10/c1.eml', 'message/rfc822', NULL, 'done', 'new', ?),
              ('c2', 'email', NULL, 'emails/2026/10/c2.eml', 'message/rfc822', NULL, 'done', 'new', ?)`,
    )
    .bind(TS, TS)
    .run();
  await env.AUDIO.put("attachments/c1/a1", new TextEncoder().encode(CONTENT), {
    httpMetadata: { contentType: "text/plain" },
  });
  const bytes = new TextEncoder().encode(CONTENT).length;
  await db
    .prepare(
      `INSERT INTO capture_attachments (id, capture_id, filename, mime, size_bytes, r2_key, too_large, created_at) VALUES
         ('a1', 'c1', 'report.txt', 'text/plain', ?, 'attachments/c1/a1', 0, ?),
         ('a2', 'c1', 'huge.bin', 'application/octet-stream', 20000000, NULL, 1, ?),
         ('a3', 'c2', 'other.txt', 'text/plain', 3, 'attachments/c2/a3', 0, ?),
         ('a4', 'c1', 'gone.txt', 'text/plain', 3, 'attachments/c1/a4', 0, ?),
         ('a5', 'c1', 'f"g\nh.txt', 'text/plain', 3, 'attachments/c1/a5', 0, ?)`,
    )
    .bind(bytes, TS, TS, TS, TS, TS)
    .run();
  await env.AUDIO.put("attachments/c1/a5", new TextEncoder().encode("abc"), {
    httpMetadata: { contentType: "text/plain" },
  });
});

describe("attachment downloads", () => {
  it("sends the file with its name, type and length", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/a1", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe(String(CONTENT.length));
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(CONTENT);
  });

  it("carries the headers a stored file needs, through the whole Worker", async () => {
    const session = await signIn();
    const res = await call("/api/captures/c1/attachments/a1", { headers: withSession(session) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(CONTENT);
  });

  it("keeps an odd file name safe in the header", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/a5", {}, env);
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toContain("\n");
    expect(disposition).toBe(`attachment; filename="f_g_h.txt"; filename*=UTF-8''f%22g%0Ah.txt`);
  });

  it("409 for an attachment that was too large to keep", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/a2", {}, env);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("too large");
  });

  it("404 when the attachment belongs to another capture", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/a3", {}, env);
    expect(res.status).toBe(404);
  });

  it("404 for an unknown attachment", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/nope", {}, env);
    expect(res.status).toBe(404);
  });

  it("404 when the stored file is missing", async () => {
    const res = await api.app.request("/api/captures/c1/attachments/a4", {}, env);
    expect(res.status).toBe(404);
  });

  it("401 without a session", async () => {
    const res = await call("/api/captures/c1/attachments/a1");
    expect(res.status).toBe(401);
  });
});
