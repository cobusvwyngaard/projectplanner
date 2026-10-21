// Tasks whose source captures include an email from outside stand out
// (docs/testing-findings.md item 1). The Worker works the flag out from the
// task's source_capture_ids; the app never guesses.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../src/shared/api";
import type { TaskView } from "../../src/shared/types";
import worker from "../../src/worker/index";
import { fromOutsideFor, taskViews } from "../../src/worker/board/provenance";
import { getRow, openTasks, rowsByIds } from "../../src/worker/board/queries";
import { getBoard } from "../../src/worker/mcp/tools/read";
import { claudeActor, SYSTEM_ACTOR } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { asUser, ok } from "../helpers/api";
import { USER_1, USER_2, freshDb, openRun } from "../helpers/db";

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

/** Register an address; an address already registered stays with its owner. */
async function register(userId: string, address: string): Promise<void> {
  const known = await db.prepare(`SELECT id FROM user_emails WHERE address = ?`).bind(address).first<{ id: string }>();
  if (known) return;
  await db
    .prepare(`INSERT INTO user_emails (id, user_id, address, created_at, archived_at) VALUES (?, ?, ?, ?, NULL)`)
    .bind(`email-${address}`, userId, address, "2026-10-01T00:00:00.000Z")
    .run();
}

/** A raw message: headers in order, then a blank line, then the body. */
function rawMessage(headers: readonly (readonly [string, string])[], body = "Hello from the test."): string {
  return `${headers.map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** Hand a message to the Worker's email() handler, as the mail service does. */
async function deliver(raw: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const message = {
    from: CLIENT,
    to: "inbox@example.com",
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

/** The id of the capture stored last, so a task can name it as its source. */
async function newestCaptureId(): Promise<string> {
  const row = await db
    .prepare(`SELECT id FROM captures ORDER BY created_at DESC, id DESC LIMIT 1`)
    .first<{ id: string }>();
  if (!row) throw new Error("no capture was stored");
  return row.id;
}

/** A typed capture, written directly as a person's upload does. */
async function typedCapture(title: string): Promise<string> {
  const id = `01TYPED${title.replace(/\W/g, "").toUpperCase().padEnd(20, "0")}`.slice(0, 26);
  await db
    .prepare(
      `INSERT INTO captures (id, kind, author_user_id, text, transcript_status, inbox_status, created_at)
       VALUES (?, 'text', ?, ?, 'n/a', 'processed', ?)`,
    )
    .bind(id, USER_1, title, "2026-10-01T00:00:00.000Z")
    .run();
  const row = await getRow(db, "capture", id);
  if (!row) throw new Error("the capture was not stored");
  return id;
}

/** Build a task whose only source capture is the one with this id. */
async function taskFromCapture(captureId: string, title = "Book the venue"): Promise<string> {
  const runId = await openRun(USER_1);
  const created = await mutate(db, claudeActor(USER_1, runId), {
    entity: "task",
    action: "create",
    values: { title },
    sourceCaptureIds: [captureId],
  });
  return created.id;
}

/** An email from a registered, verified planner address. */
async function verifiedFrom(sender: { userId: string; address: string }, to: string): Promise<string> {
  await register(sender.userId, sender.address);
  await register(USER_2, to);
  await deliver(
    rawMessage([
      ["From", sender.address],
      ["To", to],
      ["Authentication-Results", "mx.cloudflare.net; dmarc=pass header.from=example.com"],
      ["Message-ID", `<ok-${sender.address}-${to}@example.org>`],
    ]),
  );
  return newestCaptureId();
}

/** An email from a registered planner address whose domain failed authentication. */
async function unverifiedFrom(sender: { userId: string; address: string }, to: string): Promise<string> {
  await register(sender.userId, sender.address);
  await register(USER_2, to);
  await deliver(
    rawMessage([
      ["From", sender.address],
      ["To", to],
      ["Authentication-Results", "mx.cloudflare.net; dmarc=fail header.from=example.com"],
      ["Message-ID", `<fail-${sender.address}-${to}@example.org>`],
    ]),
  );
  return newestCaptureId();
}

/** An email from nobody in the planner, cc'd to a registered address. */
async function unregisteredFrom(to: string): Promise<string> {
  await register(USER_2, to);
  await deliver(
    rawMessage([
      ["From", "Stranger <stranger@example.org>"],
      ["To", to],
      ["Message-ID", `<stranger-${to}@example.org>`],
    ]),
  );
  return newestCaptureId();
}

async function flagOf(taskId: string): Promise<string | null> {
  const task = await getRow(db, "task", taskId);
  if (!task) throw new Error("no such task");
  const [view] = await taskViews(db, [task]);
  return view?.from_outside ?? null;
}

describe("tasks from outside senders", () => {
  it("flags an email whose sender is not a planner address", async () => {
    const captureId = await unregisteredFrom(TO_TWO);
    const taskId = await taskFromCapture(captureId);
    expect(await flagOf(taskId)).toBe("unregistered");
  });

  it("flags an email from a planner address whose sender is not verified", async () => {
    const captureId = await unverifiedFrom({ userId: USER_1, address: TO_ONE }, TO_TWO);
    const taskId = await taskFromCapture(captureId);
    expect(await flagOf(taskId)).toBe("unverified");
  });

  it("flags a verified planner sender as no outside", async () => {
    const captureId = await verifiedFrom({ userId: USER_1, address: TO_ONE }, TO_TWO);
    const taskId = await taskFromCapture(captureId);
    expect(await flagOf(taskId)).toBeNull();
  });

  it("leaves a task sourced from a typed or spoken capture alone", async () => {
    const captureId = await typedCapture("Voice memo");
    const taskId = await taskFromCapture(captureId);
    expect(await flagOf(taskId)).toBeNull();
  });

  it("leaves a task with no sources alone", async () => {
    const created = await mutate(db, claudeActor(USER_1, await openRun(USER_1)), {
      entity: "task",
      action: "create",
      values: { title: "Written by hand" },
    });
    expect(await flagOf(created.id)).toBeNull();
    expect(await fromOutsideFor(db, [created.id])).toEqual(new Map());
  });

  it("puts unregistered above unverified when a task has both kinds of source", async () => {
    await addUser(USER_3, "Person 3");
    const unverified = await unverifiedFrom({ userId: USER_3, address: TO_THREE }, TO_TWO);
    const unregistered = await unregisteredFrom(TO_ONE);
    const runId = await openRun(USER_1);
    const created = await mutate(db, claudeActor(USER_1, runId), {
      entity: "task",
      action: "create",
      values: { title: "Two sources" },
      sourceCaptureIds: [unverified, unregistered],
    });
    expect(await flagOf(created.id)).toBe("unregistered");
  });

  it("flags a task when Claude adds an outside source in a later update", async () => {
    const runId = await openRun(USER_1);
    const acted = claudeActor(USER_1, runId);
    const created = await mutate(db, acted, { entity: "task", action: "create", values: { title: "Follow up" } });
    expect(await flagOf(created.id)).toBeNull();

    const captureId = await unregisteredFrom(TO_TWO);
    await mutate(db, acted, {
      entity: "task",
      action: "update",
      id: created.id,
      patch: { detail: "Asked by a stranger" },
      sourceCaptureIds: [captureId],
    });
    expect(await flagOf(created.id)).toBe("unregistered");
  });

  it("carries the flag in the bootstrap, the change feed and a mutation response", async () => {
    const api = asUser(USER_1);
    const captureId = await unregisteredFrom(TO_TWO);
    const taskId = await taskFromCapture(captureId);

    const board = await ok(api.get<BootstrapResponse>("/api/bootstrap"));
    expect(board.tasks.find((t) => t.id === taskId)?.from_outside).toBe("unregistered");

    // The change feed sends the task with its flag, from the event before it.
    const captureEvent = await db
      .prepare(`SELECT id FROM events WHERE entity_type = 'capture' ORDER BY seq LIMIT 1`)
      .first<{ id: string }>();
    const feed = await ok(api.get<ChangesResponse>(`/api/changes?since=${captureEvent?.id}`));
    expect(feed.tasks.find((t) => t.id === taskId)?.from_outside).toBe("unregistered");

    // A change to the source capture itself reaches the task it sourced.
    await mutate(db, SYSTEM_ACTOR, {
      entity: "capture",
      action: "update",
      id: captureId,
      patch: { text: "Re-read by the inbox." },
    });
    const taskEvent = await db
      .prepare(`SELECT id FROM events WHERE entity_type = 'task' ORDER BY seq LIMIT 1`)
      .first<{ id: string }>();
    const resourced = await ok(api.get<ChangesResponse>(`/api/changes?since=${taskEvent?.id}`));
    expect(resourced.events.some((e) => e.entity_type === "capture")).toBe(true);
    expect(resourced.tasks.some((t) => t.id === taskId && t.from_outside === "unregistered")).toBe(true);

    const updated = await ok(
      asUser(USER_1).patch<MutationResponse<TaskView>>(`/api/tasks/${taskId}`, { title: "Book the venue now" }),
    );
    expect(updated.row.from_outside).toBe("unregistered");
  });

  it("flags each of three planner people exactly by their own verification", async () => {
    await addUser(USER_3, "Person 3");
    const verified = await verifiedFrom({ userId: USER_2, address: TO_TWO }, TO_ONE);
    const unverified = await unverifiedFrom({ userId: USER_3, address: TO_THREE }, TO_ONE);
    const unregistered = await unregisteredFrom(TO_TWO);
    const verifiedTask = await taskFromCapture(verified, "Verified");
    const unverifiedTask = await taskFromCapture(unverified, "Unverified");
    const unregisteredTask = await taskFromCapture(unregistered, "Unregistered");

    // Task views carry the flag, and one query covers every task.
    const flags = await fromOutsideFor(db, (await openTasks(db)).map((t) => t.id));
    expect(flags.get(verifiedTask) ?? null).toBeNull();
    expect(flags.get(unverifiedTask)).toBe("unverified");
    expect(flags.get(unregisteredTask)).toBe("unregistered");

    // The same holds past D1's bound-parameter limit, with missing ids in between.
    const plain = await mutate(db, claudeActor(USER_1, await openRun(USER_1)), {
      entity: "task",
      action: "create",
      values: { title: "Nothing from outside" },
    });
    const rows = await rowsByIds(db, "task", Array.from({ length: 120 }, (_, i) => `00MISSING${i}`).concat(plain.id));
    expect(rows).toHaveLength(1);
    expect((await fromOutsideFor(db, rows.map((r) => r.id))).size).toBe(0);
  });

  it("tells Claude the flag in get_board", async () => {
    const captureId = await unregisteredFrom(TO_TWO);
    const taskId = await taskFromCapture(captureId);
    const plainId = await typedCapture("Typed").then((id) => taskFromCapture(id, "Typed"));
    const board = await getBoard({ db, userId: USER_1, now: new Date() }, {});
    expect(board.tasks.find((t) => t.id === taskId)?.from_outside).toBe("unregistered");
    expect(board.tasks.find((t) => t.id === plainId)?.from_outside).toBeNull();
  });
});
