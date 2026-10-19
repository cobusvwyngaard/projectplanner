// Reading an email capture's body and attachments from R2 (SPEC 11.3). Tests
// use made-up messages and example.com/example.org addresses only.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_BODY_CHARS, readEmail } from "../../src/worker/email/read";
import { runScheduled } from "../../src/worker/cron";
import { allEvents, eventsFor, freshDb, USER_1 } from "../helpers/db";

const TS = "2026-10-01T00:00:00.000Z";

let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
  env.TRANSCRIBER = "mock";
  env.ELEVENLABS_API_KEY = "placeholder-not-a-real-key";
});

interface StoredCapture {
  text: string | null;
  transcript_status: string;
  transcript_error: string | null;
  transcribe_attempts: number;
}

async function capture(id: string): Promise<StoredCapture | null> {
  return db
    .prepare(`SELECT text, transcript_status, transcript_error, transcribe_attempts FROM captures WHERE id = ?`)
    .bind(id)
    .first<StoredCapture>();
}

async function attachments(id: string) {
  const { results } = await db
    .prepare(
      `SELECT id, capture_id, filename, mime, size_bytes, r2_key, too_large
       FROM capture_attachments WHERE capture_id = ? ORDER BY created_at, id`,
    )
    .bind(id)
    .all<{ id: string; filename: string; mime: string; size_bytes: number; r2_key: string | null; too_large: number }>();
  return results;
}

/** Store a raw message as an email capture would have been stored at receive time. */
async function putEmail(id: string, message: string | Uint8Array): Promise<void> {
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const key = `emails/2026/10/${id}.eml`;
  await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
  await db
    .prepare(
      `INSERT INTO captures (id, kind, author_user_id, r2_key, mime, text, transcript_status, inbox_status, created_at)
       VALUES (?, 'email', NULL, ?, 'message/rfc822', NULL, 'pending', 'new', ?)`,
    )
    .bind(id, key, TS)
    .run();
}

/** A plain message with a text body, ending in CRLF as a delivered message does. */
function textMessage(body = "The body text."): string {
  return [
    "From: sender@example.org",
    "To: reader@example.com",
    "Subject: A note",
    "Message-ID: <note@example.org>",
    "",
    body,
  ].join("\r\n") + "\r\n";
}

interface TestAttachment {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

/** A message whose only content is the parts: a text body and the attachments. */
function attachmentMessage(attachmentsIn: readonly TestAttachment[], body = "The body text."): string {
  const boundary = "BOUNDARY-TEST";
  const lines = [
    "From: sender@example.org",
    "To: reader@example.com",
    "Subject: With files",
    "Message-ID: <files@example.org>",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  for (const a of attachmentsIn) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(base64(a.bytes)),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function wrap76(text: string): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 76) parts.push(text.slice(i, i + 76));
  return parts.join("\r\n");
}

describe("readEmail: the body", () => {
  it("reads a plain-text body and marks the capture done with one system event", async () => {
    await putEmail("c1", textMessage("The body of the note."));
    await readEmail(env, "c1");
    expect(await capture("c1")).toEqual({
      text: "The body of the note.\n",
      transcript_status: "done",
      transcript_error: null,
      transcribe_attempts: 1,
    });
    const events = await eventsFor("capture", "c1");
    expect(events.map((e) => e.action)).toEqual(["update"]);
    expect(events[0]?.actor_kind).toBe("system");
    expect(events[0]?.actor_user_id ?? null).toBeNull();
  });

  it("converts an HTML-only body to text", async () => {
    await putEmail(
      "c2",
      [
        "From: sender@example.org",
        "To: reader@example.com",
        "Subject: A web page",
        "Message-ID: <html@example.org>",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello <b>there</b></p><style>p{color:red}</style><p>Second line</p>",
      ].join("\r\n"),
    );
    await readEmail(env, "c2");
    expect((await capture("c2"))?.text).toBe("Hello there\n\nSecond line");
  });

  it("cuts a body over the limit and says so", async () => {
    await putEmail("c10", textMessage("a".repeat(MAX_BODY_CHARS + 1)));
    await readEmail(env, "c10");
    expect((await capture("c10"))?.text).toBe("a".repeat(MAX_BODY_CHARS) + "\n[…cut: the email is longer]");
  });

  it("leaves a body at exactly the limit unchanged", async () => {
    // The parser turns a simple message's closing CRLF into one newline, so
    // 99 999 typed characters make a body of exactly MAX_BODY_CHARS.
    await putEmail("c11", textMessage("a".repeat(MAX_BODY_CHARS - 1)));
    await readEmail(env, "c11");
    const text = (await capture("c11"))?.text ?? "";
    expect(text.length).toBe(MAX_BODY_CHARS);
    expect(text).toBe("a".repeat(MAX_BODY_CHARS - 1) + "\n");
  });

  it("leaves a capture that is not an email alone", async () => {
    await db
      .prepare(
        `INSERT INTO captures (id, kind, author_user_id, r2_key, mime, text, transcript_status, inbox_status, created_at)
         VALUES ('v1', 'voice', ?, 'captures/2026/10/v1.webm', 'audio/webm', 'hello', 'pending', 'new', ?)`,
      )
      .bind(USER_1, TS)
      .run();
    await readEmail(env, "v1");
    expect(await capture("v1")).toEqual({
      text: "hello",
      transcript_status: "pending",
      transcript_error: null,
      transcribe_attempts: 0,
    });
    expect(await allEvents()).toEqual([]);
  });
});

describe("readEmail: attachments", () => {
  it("stores an attachment in R2 and lists its name, type and size", async () => {
    const content = new TextEncoder().encode("the file contents");
    await putEmail("c3", attachmentMessage([{ filename: "report.txt", mime: "text/plain", bytes: content }]));
    await readEmail(env, "c3");
    const [attachment] = await attachments("c3");
    expect(attachment?.filename).toBe("report.txt");
    expect(attachment?.mime).toBe("text/plain");
    expect(attachment?.size_bytes).toBe(content.length);
    expect(attachment?.too_large).toBe(0);
    expect(attachment?.r2_key).toMatch(/^attachments\/c3\/[0-9A-HJKMNP-TV-Z]{26}$/);
    const object = await env.AUDIO.get(attachment?.r2_key ?? "");
    expect(object?.httpMetadata?.contentType).toBe("text/plain");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(content);
  });

  it("lists an attachment over the size limit but stores nothing for it", async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    await putEmail("c4", attachmentMessage([{ filename: "huge.bin", mime: "application/octet-stream", bytes }]));
    await readEmail(env, "c4");
    const [attachment] = await attachments("c4");
    expect(attachment?.filename).toBe("huge.bin");
    expect(attachment?.size_bytes).toBe(MAX_ATTACHMENT_BYTES + 1);
    expect(attachment?.too_large).toBe(1);
    expect(attachment?.r2_key).toBeNull();
    expect((await env.AUDIO.list({ prefix: "attachments/c4/" })).objects).toEqual([]);
  });

  it("lists at most twenty attachments and ignores the rest", async () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({
      filename: `file-${i + 1}.txt`,
      mime: "text/plain",
      bytes: new TextEncoder().encode(`contents ${i + 1}`),
    }));
    await putEmail("c5", attachmentMessage(many));
    await readEmail(env, "c5");
    const listed = await attachments("c5");
    expect(listed.map((a) => a.filename)).toEqual(many.slice(0, MAX_ATTACHMENTS).map((a) => a.filename));
    expect(listed.every((a) => a.too_large === 0)).toBe(true);
  });
});

describe("readEmail: trouble", () => {
  it("marks a capture whose raw message is missing as failed", async () => {
    await db
      .prepare(
        `INSERT INTO captures (id, kind, author_user_id, r2_key, mime, text, transcript_status, inbox_status, created_at)
         VALUES ('c6', 'email', NULL, 'emails/2026/10/c6.eml', 'message/rfc822', NULL, 'pending', 'new', ?)`,
      )
      .bind(TS)
      .run();
    await readEmail(env, "c6");
    expect(await capture("c6")).toEqual({
      text: null,
      transcript_status: "failed",
      transcript_error: "The email could not be found.",
      transcribe_attempts: 1,
    });
  });

  it("marks a message that cannot be parsed as failed", async () => {
    const parse = vi.spyOn(PostalMime, "parse").mockRejectedValueOnce(new Error("boom"));
    try {
      await putEmail("c7", textMessage());
      await readEmail(env, "c7");
    } finally {
      parse.mockRestore();
    }
    expect(await capture("c7")).toEqual({
      text: null,
      transcript_status: "failed",
      transcript_error: "The email could not be read.",
      transcribe_attempts: 1,
    });
  });

  it("leaves a capture that is already read alone", async () => {
    await putEmail("c8", textMessage());
    await readEmail(env, "c8");
    const eventsBefore = await allEvents();
    await readEmail(env, "c8");
    expect(await allEvents()).toEqual(eventsBefore);
    expect((await capture("c8"))?.transcribe_attempts).toBe(1);
  });
});

describe("readEmail from the cron", () => {
  it("reads a due email capture", async () => {
    await putEmail("c9", textMessage("Cron body."));
    await runScheduled(env);
    expect((await capture("c9"))?.transcript_status).toBe("done");
    expect((await capture("c9"))?.text).toBe("Cron body.\n");
    expect((await capture("c9"))?.text).not.toContain("Mock transcript");
  });
});
