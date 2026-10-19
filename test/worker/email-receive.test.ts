// The email() handler: who may send, what is stored, and what is stored nowhere
// (SPEC 11.1-11.3). Tests use made-up messages and example.com/example.org only.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { MAX_RAW_BYTES } from "../../src/worker/email/receive";
import { allEvents, eventsFor, freshDb, USER_1, USER_2 } from "../helpers/db";

const USER_3 = "00000000000000000000000003";

const CLIENT = "client@example.org";
const TO_ONE = "one@example.com";
const TO_TWO = "two@example.com";
const TO_THREE = "three@example.com";

let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

async function addUser(id: string, displayName: string): Promise<void> {
  await db
    .prepare(`INSERT INTO users (id, email, display_name, initials, created_at) VALUES (?, NULL, ?, ?, ?)`)
    .bind(id, displayName, displayName.slice(0, 2).toUpperCase(), "2026-10-01T00:00:00.000Z")
    .run();
}

async function register(userId: string, address: string): Promise<void> {
  await db
    .prepare(`INSERT INTO user_emails (id, user_id, address, created_at, archived_at) VALUES (?, ?, ?, ?, NULL)`)
    .bind(`email-${address}`, userId, address, "2026-10-01T00:00:00.000Z")
    .run();
}

/** A raw message: headers in order, then a blank line, then the body. */
function rawMessage(headers: readonly (readonly [string, string])[], body = "Hello from the test."): string {
  return `${headers.map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n${body}\r\n`;
}

interface Delivered {
  rejects: string[];
}

async function deliver(raw: string, rawSize?: number): Promise<Delivered> {
  const rejects: string[] = [];
  const pending: Promise<unknown>[] = [];
  const message = {
    from: CLIENT,
    to: "inbox@example.com",
    raw: new Blob([raw]).stream(),
    rawSize: rawSize ?? new TextEncoder().encode(raw).length,
    setReject: (reason: string) => rejects.push(reason),
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
  return { rejects };
}

interface StoredCapture {
  id: string;
  author_user_id: string | null;
  r2_key: string | null;
  text: string | null;
  transcript_status: string;
  email_from: string | null;
  email_subject: string | null;
  email_to_json: string | null;
  email_cc_json: string | null;
  email_participants_json: string | null;
  email_message_id: string | null;
  email_sender_verified: number | null;
}

async function captures(): Promise<StoredCapture[]> {
  const { results } = await db
    .prepare(
      `SELECT id, author_user_id, r2_key, text, transcript_status, email_from, email_subject,
              email_to_json, email_cc_json, email_participants_json, email_message_id, email_sender_verified
       FROM captures ORDER BY created_at, id`,
    )
    .all<StoredCapture>();
  return results;
}

async function nothingStored(): Promise<void> {
  expect(await captures()).toEqual([]);
  expect((await env.AUDIO.list({ prefix: "emails/" })).objects).toEqual([]);
  expect(await allEvents()).toEqual([]);
}

describe("email: accepts", () => {
  it("a registered address in To or Cc, even from an unregistered, unverified sender", async () => {
    await register(USER_2, TO_TWO);
    const { rejects } = await deliver(
      rawMessage([
        ["From", "Stranger <stranger@example.org>"],
        ["To", "nobody@example.org"],
        ["Cc", TO_TWO],
        ["Message-ID", "<cc-accept@example.org>"],
      ]),
    );
    expect(rejects).toEqual([]);
    const [capture] = await captures();
    expect(capture?.email_sender_verified).toBe(0);
    expect(capture?.author_user_id).toBeNull();
    expect(capture?.email_cc_json).toBe(JSON.stringify([TO_TWO]));
  });

  it("a registered, verified sender, even with an unregistered To", async () => {
    await register(USER_2, "sender@example.com");
    const { rejects } = await deliver(
      rawMessage([
        ["From", "Sender <Sender@Example.COM>"],
        ["To", "nobody@example.org"],
        ["Authentication-Results", "mx.cloudflare.net; dmarc=pass header.from=example.com"],
        ["Message-ID", "<verified@example.com>"],
      ]),
    );
    expect(rejects).toEqual([]);
    const [capture] = await captures();
    expect(capture?.email_sender_verified).toBe(1);
    expect(capture?.author_user_id).toBe(USER_2);
  });
});

describe("email: rejects", () => {
  it("when nobody involved is registered", async () => {
    const { rejects } = await deliver(
      rawMessage([
        ["From", "stranger@example.org"],
        ["To", "nobody@example.org"],
        ["Message-ID", "<nobody@example.org>"],
      ]),
    );
    expect(rejects).toEqual(["This address does not accept mail from you."]);
    await nothingStored();
  });

  it("a registered sender failing DMARC when no registered address is in To or Cc", async () => {
    await register(USER_2, "sender@example.com");
    const { rejects } = await deliver(
      rawMessage([
        ["From", "sender@example.com"],
        ["To", "nobody@example.org"],
        ["Authentication-Results", "mx.cloudflare.net; dmarc=fail header.from=example.com"],
        ["Message-ID", "<fail@example.com>"],
      ]),
    );
    expect(rejects).toHaveLength(1);
    await nothingStored();
  });

  it("a message over 25 MiB, without reading it", async () => {
    const { rejects } = await deliver(
      rawMessage([["From", "stranger@example.org"], ["Message-ID", "<huge@example.org>"]]),
      MAX_RAW_BYTES + 1,
    );
    expect(rejects).toEqual(["Message too large."]);
    await nothingStored();
  });

  it("a forged Authentication-Results below the first does not verify", async () => {
    await register(USER_2, "sender@example.com");
    await register(USER_1, TO_ONE);
    const { rejects } = await deliver(
      rawMessage([
        ["From", "sender@example.com"],
        ["To", TO_ONE],
        ["Authentication-Results", "mx.cloudflare.net; dmarc=fail header.from=example.com"],
        ["Authentication-Results", "mx.cloudflare.net; dmarc=pass header.from=example.com"],
        ["Message-ID", "<forged@example.com>"],
      ]),
    );
    expect(rejects).toEqual([]);
    const [capture] = await captures();
    expect(capture?.email_sender_verified).toBe(0);
    expect(capture?.author_user_id).toBeNull();
  });

  it("results from another authserv-id do not verify", async () => {
    await register(USER_2, "sender@example.com");
    await register(USER_1, TO_ONE);
    const { rejects } = await deliver(
      rawMessage([
        ["From", "sender@example.com"],
        ["To", TO_ONE],
        ["Authentication-Results", "example.com; dmarc=pass header.from=example.com"],
        ["Message-ID", "<wrong-authserv@example.com>"],
      ]),
    );
    expect(rejects).toEqual([]);
    const [capture] = await captures();
    expect(capture?.email_sender_verified).toBe(0);
    expect(capture?.author_user_id).toBeNull();
  });
});

describe("email: what is stored", () => {
  it("stores the raw message under the capture id and one create event", async () => {
    await register(USER_2, TO_TWO);
    await deliver(
      rawMessage(
        [
          ["From", "Stranger <stranger@example.org>"],
          ["To", TO_TWO],
          ["Subject", "=?utf-8?Q?caf=C3=A9_meeting?="],
          ["Message-ID", "<stored@example.org>"],
        ],
        "The body of the note.",
      ),
    );
    const [capture] = await captures();
    expect(capture).toBeDefined();
    const key = capture?.r2_key ?? "";
    expect(key).toMatch(/^emails\/\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.eml$/);
    expect(key.endsWith(`/${capture?.id}.eml`)).toBe(true);
    const object = await env.AUDIO.get(key);
    expect(object?.httpMetadata?.contentType).toBe("message/rfc822");
    expect(capture?.email_subject).toBe("café meeting");
    expect(capture?.email_from).toBe("stranger@example.org");
    expect(capture?.email_message_id).toBe("<stored@example.org>");
    expect(capture?.text).toBe("The body of the note.\n");

    const events = await eventsFor("capture", capture?.id ?? "");
    const created = events.find((e) => e.action === "create");
    expect(created?.actor_kind).toBe("system");
    expect(created?.actor_user_id ?? null).toBeNull();
  });

  it("maps every participant to the right person across three users", async () => {
    await addUser(USER_3, "Person 3");
    await register(USER_1, TO_ONE);
    await register(USER_2, TO_TWO);
    await register(USER_3, TO_THREE);
    await deliver(
      rawMessage([
        ["From", "Stranger <stranger@example.org>"],
        ["To", `${TO_ONE}, Two <${TO_TWO}>`],
        ["Cc", TO_THREE],
        ["Message-ID", "<participants@example.org>"],
      ]),
    );
    const [capture] = await captures();
    expect(JSON.parse(capture?.email_to_json ?? "[]")).toEqual([TO_ONE, TO_TWO]);
    expect(JSON.parse(capture?.email_cc_json ?? "[]")).toEqual([TO_THREE]);
    expect(JSON.parse(capture?.email_participants_json ?? "[]")).toEqual([
      { address: "stranger@example.org", name: "Stranger", role: "from", user_id: null },
      { address: TO_ONE, name: "", role: "to", user_id: USER_1 },
      { address: TO_TWO, name: "Two", role: "to", user_id: USER_2 },
      { address: TO_THREE, name: "", role: "cc", user_id: USER_3 },
    ]);
  });

  it("accepts and stores nothing for a duplicate Message-ID", async () => {
    await register(USER_2, TO_TWO);
    const raw = rawMessage([
      ["From", "stranger@example.org"],
      ["To", TO_TWO],
      ["Message-ID", "<duplicate@example.org>"],
    ]);
    await deliver(raw);
    const afterFirst = await captures();
    const eventsAfterFirst = await allEvents();
    const objectsAfterFirst = (await env.AUDIO.list({ prefix: "emails/" })).objects;

    const { rejects } = await deliver(raw);
    expect(rejects).toEqual([]);
    expect(await captures()).toEqual(afterFirst);
    expect(await allEvents()).toEqual(eventsAfterFirst);
    expect((await env.AUDIO.list({ prefix: "emails/" })).objects).toEqual(objectsAfterFirst);
  });

  it("makes its own Message-ID when the message has none", async () => {
    await register(USER_2, TO_TWO);
    await deliver(rawMessage([["From", "stranger@example.org"], ["To", TO_TWO]]));
    const [capture] = await captures();
    expect(capture?.email_message_id).toMatch(/^<[0-9a-f]{64}@no-message-id>$/);
  });
});
