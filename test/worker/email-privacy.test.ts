// Nothing private may reach the logs on the whole receive-and-read path: no
// address, subject, body, file name or header value (SPEC 11, privacy note).
// The message is made up and uses example.com/example.org addresses only.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { freshDb, USER_2 } from "../helpers/db";

const REGISTERED = "person.secret@example.com";

/** Values that appear only inside the message and must never be logged. */
const SECRETS = [
  "sender.secret@example.org",
  "person.secret@example.com",
  "Project Bluebird launch",
  "The secret body of the message.",
  "secret-attachment.txt",
  "header-value-42",
];

let db: D1Database;
let lines: string[];

beforeEach(async () => {
  db = await freshDb();
  lines = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "info").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(console, "debug").mockImplementation(record);
  await db
    .prepare(`INSERT INTO user_emails (id, user_id, address, created_at, archived_at) VALUES (?, ?, ?, ?, NULL)`)
    .bind("email-1", USER_2, REGISTERED, "2026-10-01T00:00:00.000Z")
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A multipart message carrying every secret, with a file to be stored in R2. */
function rawMessage(): string {
  const boundary = "BOUNDARY-PRIVACY";
  return [
    "From: Sender <sender.secret@example.org>",
    `To: ${REGISTERED}`,
    "Subject: Project Bluebird launch",
    "Message-ID: <privacy@example.org>",
    // From a domain Cloudflare does not record results for, so the handler logs
    // its one auth line: it must name only the authserv-id and result words.
    "Authentication-Results: example.org; dmarc=pass spf=pass",
    "X-Secret-Header: header-value-42",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The secret body of the message.",
    `--${boundary}`,
    'Content-Type: text/plain; name="secret-attachment.txt"',
    'Content-Disposition: attachment; filename="secret-attachment.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("the file contents"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function deliver(raw: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const message = {
    from: "sender.secret@example.org",
    to: REGISTERED,
    raw: new Blob([raw]).stream(),
    rawSize: new TextEncoder().encode(raw).length,
    setReject: () => {},
    forward: () => Promise.reject(new Error("forward is not used")),
    reply: () => Promise.reject(new Error("reply is not used")),
  } as unknown as ForwardableEmailMessage;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
  await worker.email(message, env, ctx);
  await Promise.allSettled(pending);
}

describe("email privacy", () => {
  it("logs nothing private while a message is received and read", async () => {
    await deliver(rawMessage());

    // The path really ran: the capture is read and the attachment is stored.
    const capture = await db
      .prepare(`SELECT id, text FROM captures ORDER BY created_at, id LIMIT 1`)
      .first<{ id: string; text: string | null }>();
    expect(capture?.text).toBe("The secret body of the message.");
    const attachment = await db
      .prepare(`SELECT r2_key FROM capture_attachments WHERE capture_id = ?`)
      .bind(capture?.id ?? "")
      .first<{ r2_key: string | null }>();
    expect(attachment?.r2_key).not.toBeNull();
    expect(await env.AUDIO.get(attachment?.r2_key ?? "")).not.toBeNull();

    // The one log line is present, so the check is not vacuous.
    const logged = lines.join("\n");
    expect(logged).toContain("email auth: authserv-id=example.org");
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
    }
  });
});
