// The Claude connector's tools (SPEC sections 5 and 7), tested as plain
// functions: every tool's success and failure paths, the guardrails, the
// attribution of each write, and the concurrency of start_run.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailParticipant } from "../../src/shared/types";
import type { RevertResponse } from "../../src/shared/api";
import { runScheduled } from "../../src/worker/cron";
import { ConflictError, NotFoundError, RunNotOpenError, ValidationError } from "../../src/worker/lib/errors";
import { ulid } from "../../src/worker/lib/ulid";
import { finishRun, getOpenRun, startRun, type ToolContext } from "../../src/worker/mcp/runs";
import { getRow, listUsers } from "../../src/worker/board/queries";
import { getBoard, getHistory, getInbox, getOverview, inboxItem, type InboxItem } from "../../src/worker/mcp/tools/read";
import {
  createNote,
  createTask,
  linkItems,
  markCaptures,
  unlinkItems,
  updateNote,
  updateTask,
} from "../../src/worker/mcp/tools/writes";
import { humanActor } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { asUser, ok } from "../helpers/api";
import { USER_1, USER_2, allEvents, eventsFor, freshDb, openRun } from "../helpers/db";

let db: D1Database;
const now = new Date("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;

beforeEach(async () => {
  db = await freshDb();
});

const ctx = (userId: string = USER_1, at: Date = now): ToolContext => ({ db, userId, now: at });

const human1 = humanActor(USER_1);

async function newNote(title = "Plan the trip"): Promise<string> {
  const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title } });
  return String(row.id);
}

async function newTask(title = "Book flights"): Promise<string> {
  const { row } = await mutate(db, human1, { entity: "task", action: "create", values: { title } });
  return String(row.id);
}

async function newLabel(name = "Travel"): Promise<string> {
  const { row } = await mutate(db, human1, {
    entity: "label",
    action: "create",
    values: { name, colour_hex: "#1d4ed8" },
  });
  return String(row.id);
}

interface CaptureOptions {
  kind?: "text" | "voice";
  transcript?: "pending" | "done" | "failed";
  author?: string;
  text?: string;
  createdAt?: Date;
}

/** A capture in the inbox, as the capture pipeline leaves it. */
async function newCapture(text = "Buy biltong for the trip", options: CaptureOptions = {}): Promise<string> {
  const kind = options.kind ?? "text";
  const at = options.createdAt ?? now;
  const id = ulid(at.getTime());
  await db
    .prepare(
      `INSERT INTO captures (id, kind, author_user_id, text, transcript_status, inbox_status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)`,
    )
    .bind(id, kind, options.author ?? USER_1, text, kind === "text" ? "n/a" : (options.transcript ?? "done"), at.toISOString())
    .run();
  return id;
}

/** Claim captures for a run as a fixture, directly (bypassing the run guard). */
async function claimRows(captureIds: string[], runId: string, at: Date = now): Promise<void> {
  await db.batch(
    captureIds.map((id) =>
      db
        .prepare(`UPDATE captures SET inbox_status = 'claimed', claimed_by_run_id = ?, claimed_at = ? WHERE id = ?`)
        .bind(runId, at.toISOString(), id),
    ),
  );
}

interface EmailOptions {
  author?: string | null;
  subject?: string;
  senderVerified?: boolean;
  participants?: EmailParticipant[];
  text?: string;
  transcript?: "pending" | "done";
  createdAt?: Date;
}

/** An email capture in the inbox, as the email pipeline leaves it once read. */
async function newEmailCapture(options: EmailOptions = {}): Promise<string> {
  const at = options.createdAt ?? now;
  const id = ulid(at.getTime());
  const participants: EmailParticipant[] = options.participants ?? [
    { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1 },
    { address: "two@example.com", name: "Person 2", role: "to", user_id: USER_2 },
  ];
  const roleAddresses = (role: EmailParticipant["role"]): string[] =>
    participants.filter((p) => p.role === role).map((p) => p.address);
  await db
    .prepare(
      `INSERT INTO captures (id, kind, author_user_id, text, transcript_status, inbox_status, created_at,
         email_subject, email_from, email_to_json, email_cc_json, email_participants_json,
         email_message_id, email_sender_verified)
       VALUES (?, 'email', ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      options.author === undefined ? USER_1 : options.author,
      options.text ?? "Please book the flights.",
      options.transcript ?? "done",
      at.toISOString(),
      options.subject ?? "Flights for the trip",
      participants.find((p) => p.role === "from")?.address ?? "nobody@example.org",
      JSON.stringify(roleAddresses("to")),
      JSON.stringify(roleAddresses("cc")),
      JSON.stringify(participants),
      `<${id}@example.com>`,
      options.senderVerified === false ? 0 : 1,
    )
    .run();
  return id;
}

/** An attachment row on an email capture; stored false means no content in R2. */
async function newAttachment(
  captureId: string,
  filename: string,
  options: { size?: number; stored?: boolean } = {},
): Promise<void> {
  const stored = options.stored !== false;
  await db
    .prepare(
      `INSERT INTO capture_attachments (id, capture_id, filename, mime, size_bytes, r2_key, too_large, created_at)
       VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?)`,
    )
    .bind(
      `att-${captureId}-${filename}`,
      captureId,
      filename,
      options.size ?? 512,
      stored ? `attachments/${captureId}/${filename}` : null,
      stored ? 0 : 1,
      now.toISOString(),
    )
    .run();
}

/** One stored capture as Claude's inboxItem sees it. */
async function itemFor(id: string): Promise<InboxItem> {
  const row = await getRow(db, "capture", id);
  if (row === null) throw new Error(`capture ${id} is missing`);
  return inboxItem(row, await listUsers(db));
}

const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

describe("get_overview", () => {
  it("returns the connected user, every user, active labels, counts and today", async () => {
    const label = await newLabel();
    const archived = await newLabel("Old plans");
    await mutate(db, human1, { entity: "label", action: "archive", id: archived });
    await newNote();
    await newTask();
    const overdue = await newTask("Overdue thing");
    await mutate(db, human1, { entity: "task", action: "update", id: overdue, patch: { due_date: "2026-10-18" } });
    const done = await newTask("Done already");
    await mutate(db, human1, { entity: "task", action: "complete", id: done });
    await newCapture();

    const overview = await getOverview(ctx());
    expect(overview.me).toEqual({ id: USER_1, display_name: "Person 1" });
    expect(overview.users).toEqual([
      { id: USER_1, display_name: "Person 1", initials: "P1" },
      { id: USER_2, display_name: "Person 2", initials: "P2" },
    ]);
    expect(overview.labels).toEqual([{ id: label, name: "Travel", colour_hex: "#1d4ed8" }]);
    expect(overview.counts).toEqual({ open_notes: 1, open_tasks: 2, overdue_tasks: 1, inbox_new: 1 });
    expect(overview.today).toBe("2026-10-19");
  });

  it("refuses a user that does not exist", async () => {
    await expect(getOverview(ctx("nobody"))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("get_board", () => {
  it("returns notes, tasks and links between returned items; done tasks are left out", async () => {
    const note = await newNote("The plan");
    const open = await newTask("Open task");
    const done = await newTask("Finished task");
    await mutate(db, human1, { entity: "task", action: "complete", id: done });
    await mutate(db, human1, { entity: "link", action: "link", a: { type: "note", id: note }, b: { type: "task", id: done } });
    await mutate(db, human1, { entity: "link", action: "link", a: { type: "note", id: note }, b: { type: "task", id: open } });

    const board = await getBoard(ctx(), {});
    expect(board.notes).toEqual([{ id: note, title: "The plan", body: "", label_id: null }]);
    expect(board.tasks.map((t) => t.id)).toEqual([open]);
    expect(board.links).toEqual([
      { a: { type: "note", id: note }, b: { type: "task", id: open }, kind: "related", before: null },
    ]);
    expect(board.truncated).toBe(false);

    const withDone = await getBoard(ctx(), { include_done: true });
    expect(withDone.tasks.map((t) => t.id).sort()).toEqual([done, open].sort());
    expect(withDone.links).toHaveLength(2);
    const onlyDone = await getBoard(ctx(), { status: "done" });
    expect(onlyDone.tasks.map((t) => t.id)).toEqual([done]);
  });

  it("filters by label, assignee, unassigned and due range", async () => {
    const label = await newLabel();
    const other = await newLabel("Other");
    const note = await newNote();
    const dated = await newTask("Dated");
    await mutate(db, human1, {
      entity: "task",
      action: "update",
      id: dated,
      patch: { assignee_id: USER_2, due_date: "2026-10-25", label_id: label },
    });
    const plain = await newTask();
    await mutate(db, human1, { entity: "note", action: "update", id: note, patch: { label_id: label } });

    expect((await getBoard(ctx(), { label_id: label })).tasks.map((t) => t.id)).toEqual([dated]);
    expect((await getBoard(ctx(), { label_id: other })).notes).toEqual([]);
    expect((await getBoard(ctx(), { assignee_id: USER_2 })).tasks.map((t) => t.id)).toEqual([dated]);
    expect((await getBoard(ctx(), { unassigned: true })).tasks.map((t) => t.id)).toEqual([plain]);
    expect((await getBoard(ctx(), { due_from: "2026-10-20" })).tasks.map((t) => t.id)).toEqual([dated]);
    expect((await getBoard(ctx(), { due_to: "2026-10-20" })).tasks).toEqual([]);
    expect((await getBoard(ctx(), { due_from: "2026-10-24", due_to: "2026-10-26" })).tasks.map((t) => t.id)).toEqual([dated]);
  });

  it("cuts long text at 2000 characters", async () => {
    const note = await newNote();
    await mutate(db, human1, { entity: "note", action: "update", id: note, patch: { body: "x".repeat(2500) } });
    const board = await getBoard(ctx(), {});
    expect(board.notes[0]?.body).toHaveLength(2000);
  });

  it("caps at 200 notes and 300 tasks, newest first, with truncated", async () => {
    const notes = Array.from({ length: 205 }, (_, i) =>
      db
        .prepare(
          `INSERT INTO notes (id, title, body, x, y, w, h, created_at, updated_at) VALUES (?, ?, '', 0, 0, 240, 160, ?, ?)`,
        )
        .bind(
          `note-${String(i).padStart(4, "0")}`,
          `Note ${i}`,
          new Date(now.getTime() + i * 1000).toISOString(),
          new Date(now.getTime() + i * 1000).toISOString(),
        ),
    );
    const tasks = Array.from({ length: 305 }, (_, i) =>
      db
        .prepare(`INSERT INTO tasks (id, title, detail, status, created_at, updated_at) VALUES (?, ?, '', 'open', ?, ?)`)
        .bind(
          `task-${String(i).padStart(4, "0")}`,
          `Task ${i}`,
          new Date(now.getTime() + i * 1000).toISOString(),
          new Date(now.getTime() + i * 1000).toISOString(),
        ),
    );
    await db.batch([...notes, ...tasks]);

    const board = await getBoard(ctx(), {});
    expect(board.notes).toHaveLength(200);
    expect(board.tasks).toHaveLength(300);
    expect(board.notes[0]?.title).toBe("Note 204");
    expect(board.tasks[0]?.title).toBe("Task 304");
    expect(board.truncated).toBe(true);
  });
});

describe("get_inbox", () => {
  it("returns ready captures oldest first and counts the ones not ready", async () => {
    const first = await newCapture("First thought", { createdAt: new Date(now.getTime() - 1000) });
    const second = await newCapture("Second thought");
    await newCapture("Still transcribing", { kind: "voice", transcript: "pending" });
    await newCapture("Failed", { kind: "voice", transcript: "failed" });
    const claimed = await newCapture("Someone else has this");
    await claimRows([claimed], await openRun(USER_2, { startedAt: now.toISOString() }));

    const inbox = await getInbox(ctx(), {});
    expect(inbox.items.map((i) => i.id)).toEqual([first, second]);
    expect(inbox.items[0]).toMatchObject({
      id: first,
      kind: "text",
      author: { id: USER_1, display_name: "Person 1" },
      text: "First thought",
      text_truncated: false,
    });
    expect(inbox.not_ready).toBe(2);
  });

  it("honours limit and cuts text at 10 000 characters", async () => {
    for (let i = 0; i < 4; i++) await newCapture(`Note ${i}`);
    const limited = await getInbox(ctx(), { limit: 2 });
    expect(limited.items.map((i) => i.text)).toEqual(["Note 0", "Note 1"]);

    const long = await newCapture("y".repeat(10_001));
    const withLong = await getInbox(ctx(), { limit: 50 });
    const item = withLong.items.find((i) => i.id === long);
    expect(item?.text).toHaveLength(10_000);
    expect(item?.text_truncated).toBe(true);
  });

  it("marks an item ready for text and a finished transcript, not while one is pending", async () => {
    const text = await newCapture("Typed thought");
    const done = await newCapture("Said out loud", { kind: "voice", transcript: "done" });
    const pending = await newCapture("Still transcribing", { kind: "voice", transcript: "pending" });

    expect((await itemFor(text)).ready).toBe(true);
    expect((await itemFor(done)).ready).toBe(true);
    expect((await itemFor(pending)).ready).toBe(false);

    // get_inbox lists the ready ones, the same rule start_run claims by.
    const inbox = await getInbox(ctx(), {});
    expect(inbox.items.map((i) => i.id).sort()).toEqual([text, done].sort());
    expect(inbox.not_ready).toBe(1);
  });

  it("has no author for an email whose sender was not verified", async () => {
    const capture = await newEmailCapture({
      author: null,
      senderVerified: false,
      participants: [{ address: "stranger@example.org", name: "", role: "from", user_id: null }],
    });

    const item = await itemFor(capture);
    expect(item.author).toBeNull();
    expect(item.email?.sender_verified).toBe(false);
  });

  it("shows an email's subject, sender and every participant, mapped to a planner person or not", async () => {
    const capture = await newEmailCapture({
      subject: "Cottage for the weekend",
      senderVerified: true,
      participants: [
        { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1 },
        { address: "two@example.com", name: "Person 2", role: "to", user_id: USER_2 },
        { address: "guest@example.org", name: "Guest", role: "cc", user_id: null },
      ],
    });

    const item = await itemFor(capture);
    expect(item.email).toMatchObject({
      subject: "Cottage for the weekend",
      sender_verified: true,
      from: { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1, display_name: "Person 1" },
      attachments: [],
    });
    expect(item.email?.participants).toEqual([
      { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1, display_name: "Person 1" },
      { address: "two@example.com", name: "Person 2", role: "to", user_id: USER_2, display_name: "Person 2" },
      { address: "guest@example.org", name: "Guest", role: "cc", user_id: null, display_name: null },
    ]);
    // Other kinds carry no email block at all.
    expect((await itemFor(await newCapture())).email).toBeUndefined();
  });

  it("lists every attachment of every listed email, stored or not, in one query", async () => {
    const first = await newEmailCapture({ subject: "First" });
    const second = await newEmailCapture({ subject: "Second" });
    await newAttachment(first, "plan.pdf", { size: 2048 });
    await newAttachment(first, "huge.zip", { stored: false });
    await newAttachment(second, "notes.txt", { size: 12 });

    const inbox = await getInbox(ctx(), {});
    const items = new Map(inbox.items.map((i) => [i.id, i]));
    expect(items.get(first)?.email?.attachments).toEqual([
      { name: "huge.zip", mime: "application/pdf", size_bytes: 512, stored: false },
      { name: "plan.pdf", mime: "application/pdf", size_bytes: 2048, stored: true },
    ]);
    expect(items.get(second)?.email?.attachments).toEqual([
      { name: "notes.txt", mime: "application/pdf", size_bytes: 12, stored: true },
    ]);
    // Counting rows, not spying on SQL: the listing carries every attachment
    // row of both captures, which one query over all the ids returns.
    const listed = inbox.items.flatMap((i) => i.email?.attachments ?? []);
    expect(listed).toHaveLength(await count("capture_attachments"));
  });
});

describe("get_history", () => {
  it("shows who did what, oldest first, with the run and the source captures", async () => {
    const note = await newNote();
    const capture = await newCapture();
    const { run_id } = await startRun(ctx(), { intent: "Refine the note", capture_ids: [capture] });
    await updateNote(ctx(), { run_id, id: note, patch: { title: "Plan the whole trip" }, source_capture_ids: [capture] });

    const history = await getHistory(ctx(), { entity_type: "note", entity_id: note });
    expect(history.events.map((e) => e.action)).toEqual(["create", "update"]);
    expect(history.events[0]?.actor).toBe("Person 1");
    expect(history.events[1]?.actor).toBe("Claude (via Person 1)");
    expect(history.events[1]?.run_id).toBe(run_id);
    expect(history.events[1]?.source_capture_ids).toEqual([capture]);
    expect(history.events[1]?.after).toMatchObject({ title: "Plan the whole trip" });
  });

  it("returns at most 100 events", async () => {
    const note = await newNote();
    for (let i = 0; i < 102; i++) {
      await mutate(db, human1, { entity: "note", action: "update", id: note, patch: { title: `Draft ${i}` } });
    }
    const history = await getHistory(ctx(), { entity_type: "note", entity_id: note });
    expect(history.events).toHaveLength(100);
  });

  it("errors for an unknown id", async () => {
    await expect(getHistory(ctx(), { entity_type: "task", entity_id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("start_run", () => {
  it("opens a run and claims its captures in one go", async () => {
    const c1 = await newCapture();
    const c2 = await newCapture("Second");
    const started = await startRun(ctx(), { intent: "Process the inbox", capture_ids: [c1, c2] });
    expect(started.claimed).toEqual([c1, c2]);
    expect(started.expires_at).toBe("2026-10-19T12:00:00.000Z");

    const run = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(started.run_id).first();
    expect(run).toMatchObject({ user_id: USER_1, intent: "Process the inbox", finished_at: null });
    for (const id of [c1, c2]) {
      const capture = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(id).first();
      expect(capture).toMatchObject({
        inbox_status: "claimed",
        claimed_by_run_id: started.run_id,
        claimed_at: now.toISOString(),
      });
    }
    const events = await allEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_kind: "claude",
        actor_user_id: USER_1,
        run_id: started.run_id,
        entity_type: "capture",
        source_capture_ids: [c1, c2],
      });
    }
  });

  it("refuses captures that are missing, claimed or not ready, naming them", async () => {
    const ready = await newCapture();
    const claimed = await newCapture("Taken");
    await claimRows([claimed], await openRun(USER_2, { startedAt: now.toISOString() }));
    const pending = await newCapture("Not ready yet", { kind: "voice", transcript: "pending" });

    const runsBefore = await count("runs");
    const call = startRun(ctx(), { intent: "Try", capture_ids: [ready, claimed, pending, "ghost"] });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(call).rejects.toThrow(`${claimed}, ${pending}, ghost`);
    expect(await count("runs")).toBe(runsBefore);
    expect(await count("events")).toBe(0);
    const row = await db.prepare(`SELECT inbox_status FROM captures WHERE id = ?`).bind(ready).first();
    expect(row).toMatchObject({ inbox_status: "new" });
  });

  it("refuses duplicate capture ids and opens a run for nobody's captures only when they exist", async () => {
    const capture = await newCapture();
    await expect(startRun(ctx(), { intent: "Twice", capture_ids: [capture, capture] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const empty = await startRun(ctx(), { intent: "Nothing to do", capture_ids: [] });
    expect(empty.claimed).toEqual([]);
    expect(await count("runs")).toBe(1);
  });

  it("works for either user, with no assumption about how many there are", async () => {
    const capture = await newCapture("For the second user", { author: USER_1 });
    const started = await startRun(ctx(USER_2), { intent: "My turn", capture_ids: [capture] });
    const run = await db.prepare(`SELECT user_id FROM runs WHERE id = ?`).bind(started.run_id).first();
    expect(run).toMatchObject({ user_id: USER_2 });
  });

  it("calls an unexpected failure what it is, not a claim conflict", async () => {
    const capture = await newCapture();
    // Stand in the way of the claim write with a failure no race can explain.
    await db
      .prepare(
        `CREATE TRIGGER block_claim BEFORE UPDATE ON captures
         WHEN NEW.inbox_status = 'claimed'
         BEGIN SELECT RAISE(ABORT, 'capture update refused'); END`,
      )
      .run();

    const call = startRun(ctx(), { intent: "Try", capture_ids: [capture] });
    await expect(call).rejects.not.toBeInstanceOf(ConflictError);
    await expect(call).rejects.toThrow("capture update refused");
    expect(await count("runs")).toBe(0);
  });
});

describe("start_run concurrency", () => {
  it("two runs racing for the same capture: one succeeds, the other writes nothing", async () => {
    const capture = await newCapture();
    const results = await Promise.allSettled([
      startRun(ctx(), { intent: "First", capture_ids: [capture] }),
      startRun(ctx(), { intent: "Second", capture_ids: [capture] }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.reason).toBeInstanceOf(ConflictError);

    const winner = wins[0] as PromiseFulfilledResult<{ run_id: string }>;
    expect(await count("runs")).toBe(1);
    const row = await db.prepare(`SELECT claimed_by_run_id FROM captures WHERE id = ?`).bind(capture).first();
    expect(row).toMatchObject({ claimed_by_run_id: winner.value.run_id });
    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.run_id).toBe(winner.value.run_id);
  });

  it("two runs overlapping on one capture: exactly one succeeds whole", async () => {
    const c1 = await newCapture("One");
    const c2 = await newCapture("Two");
    const c3 = await newCapture("Three");
    const results = await Promise.allSettled([
      startRun(ctx(), { intent: "A", capture_ids: [c1, c2] }),
      startRun(ctx(), { intent: "B", capture_ids: [c2, c3] }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    expect(wins).toHaveLength(1);
    expect(await count("runs")).toBe(1);
    const winner = wins[0] as PromiseFulfilledResult<{ claimed: string[] }>;
    const loserOnly = winner.value.claimed.includes(c1) ? c3 : c1;
    const claimed = await db.prepare(`SELECT inbox_status FROM captures WHERE id = ?`).bind(loserOnly).first();
    expect(claimed).toMatchObject({ inbox_status: "new" });
    const events = await allEvents();
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.source_capture_ids).toEqual(winner.value.claimed);
  });
});

describe("finish_run", () => {
  it("releases unmarked captures, keeps marked ones and stores the summary", async () => {
    const c1 = await newCapture();
    const c2 = await newCapture("Second");
    const { run_id } = await startRun(ctx(), { intent: "Work", capture_ids: [c1, c2] });
    await markCaptures(ctx(), {
      run_id,
      capture_ids: [c2],
      status: "processed",
      note: "Made a task",
      source_capture_ids: [c2],
    });

    const finished = await finishRun(ctx(), { run_id, summary: "One capture became a task." });
    expect(finished.released).toEqual([c1]);
    const first = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(c1).first();
    expect(first).toMatchObject({ inbox_status: "new", claimed_by_run_id: null, claimed_at: null });
    const second = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(c2).first();
    expect(second).toMatchObject({ inbox_status: "processed", claimed_by_run_id: null });
    const run = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(run_id).first();
    expect(run).toMatchObject({ finished_at: now.toISOString(), summary: "One capture became a task." });
  });

  it("refuses a finished run, another user's run and an unknown run", async () => {
    const finished = await openRun(USER_1, { finished: true });
    await expect(finishRun(ctx(), { run_id: finished, summary: "x" })).rejects.toBeInstanceOf(RunNotOpenError);
    const theirs = await openRun(USER_2, { startedAt: now.toISOString() });
    await expect(finishRun(ctx(), { run_id: theirs, summary: "x" })).rejects.toBeInstanceOf(RunNotOpenError);
    await expect(finishRun(ctx(), { run_id: "ghost", summary: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("run guardrails", () => {
  it("a write with a finished run is rejected and writes nothing", async () => {
    const run = await openRun(USER_1, { finished: true });
    await expect(
      createTask(ctx(), { run_id: run, title: "Sneaky", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await count("tasks")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("a write with a run older than two hours is rejected and writes nothing", async () => {
    const run = await openRun(USER_1, { startedAt: new Date(now.getTime() - 2 * HOUR - 1000).toISOString() });
    await expect(
      createNote(ctx(), { run_id: run, title: "Sneaky", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await count("notes")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("a write with another user's run is rejected and writes nothing", async () => {
    const task = await newTask();
    const eventsBefore = await count("events");
    const run = await openRun(USER_2, { startedAt: now.toISOString() });
    await expect(
      updateTask(ctx(), { run_id: run, id: task, patch: { title: "Sneaky" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await count("events")).toBe(eventsBefore);
  });

  it("getOpenRun refuses a finished run of the right user at the right age", async () => {
    const run = await openRun(USER_1, { startedAt: now.toISOString(), finished: true });
    await expect(getOpenRun(db, USER_1, run, now)).rejects.toBeInstanceOf(RunNotOpenError);
    // The other checks still stand: an open run of this user, young enough, is fine.
    const open = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(getOpenRun(db, USER_1, open, now)).resolves.toMatchObject({ id: open });
  });
});

describe("create_note", () => {
  it("places the note in a free spot and attributes the write", async () => {
    const label = await newLabel();
    await mutate(db, human1, {
      entity: "setting",
      action: "update",
      id: "default_label_id",
      patch: { value_json: JSON.stringify(label) },
    });
    const capture = await newCapture();
    const { run_id } = await startRun(ctx(), { intent: "Notes", capture_ids: [capture] });

    const created = await createNote(ctx(), {
      run_id,
      title: "Packing list",
      body: "Sunscreen, hat",
      source_capture_ids: [capture],
    });
    const note = await db.prepare(`SELECT * FROM notes WHERE id = ?`).bind(created.id).first();
    expect(note).toMatchObject({
      title: "Packing list",
      body: "Sunscreen, hat",
      label_id: label,
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      archived_at: null,
    });
    const events = await eventsFor("note", created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "create",
      actor_kind: "claude",
      actor_user_id: USER_1,
      run_id,
      source_capture_ids: [capture],
    });

    // The next note does not land on top of the first.
    const second = await createNote(ctx(), { run_id, title: "Another", source_capture_ids: [] });
    const placed = await db.prepare(`SELECT x, y FROM notes WHERE id = ?`).bind(second.id).first();
    expect(placed).toMatchObject({ x: 280, y: 0 });
  });

  it("refuses an unknown or archived label, and an unknown source capture", async () => {
    const run = await startRun(ctx(), { intent: "Notes", capture_ids: [] }).then((r) => r.run_id);
    const archived = await newLabel("Old");
    await mutate(db, human1, { entity: "label", action: "archive", id: archived });
    const eventsBefore = await count("events");
    await expect(
      createNote(ctx(), { run_id: run, title: "x", label_id: "ghost", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createNote(ctx(), { run_id: run, title: "x", label_id: archived, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createNote(ctx(), { run_id: run, title: "x", source_capture_ids: ["ghost-capture"] }),
    ).rejects.toThrow("ghost-capture");
    expect(await count("notes")).toBe(0);
    expect(await count("events")).toBe(eventsBefore); // refused writes leave no trace
  });
});

describe("update_note", () => {
  it("applies the patch and records before and after", async () => {
    const note = await newNote();
    const label = await newLabel();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    const updated = await updateNote(ctx(), {
      run_id: run,
      id: note,
      patch: { title: "Plan the whole trip", body: "Longer now", label_id: label },
      source_capture_ids: [],
    });
    expect(updated.id).toBe(note);
    const events = await eventsFor("note", note);
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      action: "update",
      actor_kind: "claude",
      actor_user_id: USER_1,
      run_id: run,
      before: { title: "Plan the trip", body: "", label_id: null },
      after: { title: "Plan the whole trip", body: "Longer now", label_id: label },
    });
  });

  it("refuses an empty patch, unknown ids, archived notes and unknown labels", async () => {
    const note = await newNote();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      updateNote(ctx(), { run_id: run, id: note, patch: {}, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateNote(ctx(), { run_id: run, id: "ghost", patch: { title: "x" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateNote(ctx(), { run_id: run, id: note, patch: { label_id: "ghost" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await mutate(db, human1, { entity: "note", action: "archive", id: note });
    await expect(
      updateNote(ctx(), { run_id: run, id: note, patch: { title: "x" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("create_task", () => {
  it("creates a task in the tray with links, and attributes everything to the run", async () => {
    const note = await newNote("Context for the task");
    const other = await newTask("A related task");
    const capture = await newCapture();
    const { run_id } = await startRun(ctx(), { intent: "Tasks", capture_ids: [capture] });

    const created = await createTask(ctx(), {
      run_id,
      title: "Book the flights",
      detail: "Direct flight to Cape Town",
      assignee_id: USER_2,
      due_date: "2026-10-25",
      link_to: [
        { type: "note", id: note },
        { type: "task", id: other },
      ],
      source_capture_ids: [capture],
    });
    expect(created.linked).toEqual([note, other]);
    const task = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(created.id).first();
    expect(task).toMatchObject({
      title: "Book the flights",
      detail: "Direct flight to Cape Town",
      assignee_id: USER_2,
      due_date: "2026-10-25",
      status: "open",
      x: null,
      y: null,
    });
    const links = await db.prepare(`SELECT COUNT(*) AS n FROM links WHERE archived_at IS NULL`).first<{ n: number }>();
    expect(links?.n).toBe(2);
    const events = await allEvents();
    const writes = events.filter((e) => e.run_id === run_id && e.entity_type !== "capture");
    expect(writes.map((e) => e.action).sort()).toEqual(["create", "link", "link"]);
    for (const event of writes) {
      expect(event).toMatchObject({ actor_kind: "claude", actor_user_id: USER_1, source_capture_ids: [capture] });
    }
  });

  it("refuses an assignee who is not a user, and writes nothing", async () => {
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      createTask(ctx(), { run_id: run, title: "x", assignee_id: "ghost", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await count("tasks")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("refuses a due date that is not a real date", async () => {
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      createTask(ctx(), { run_id: run, title: "x", due_date: "2026-02-30", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createTask(ctx(), { run_id: run, title: "x", due_date: "25 Oct 2026", source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await count("tasks")).toBe(0);
  });

  it("refuses a link to an unknown or archived item, and creates nothing", async () => {
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      createTask(ctx(), { run_id: run, title: "x", link_to: [{ type: "note", id: "ghost" }], source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const note = await newNote();
    await mutate(db, human1, { entity: "note", action: "archive", id: note });
    await expect(
      createTask(ctx(), { run_id: run, title: "x", link_to: [{ type: "note", id: note }], source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await count("tasks")).toBe(0);
  });

  it("refuses an unknown source capture and names it", async () => {
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      createTask(ctx(), { run_id: run, title: "x", source_capture_ids: ["ghost-capture"] }),
    ).rejects.toThrow("ghost-capture");
    expect(await count("tasks")).toBe(0);
  });
});

describe("update_task", () => {
  it("applies the patch; done is recorded as complete, open as reopen", async () => {
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await updateTask(ctx(), {
      run_id: run,
      id: task,
      patch: { title: "Book the flights", assignee_id: USER_2, due_date: "2026-10-25", status: "done" },
      source_capture_ids: [],
    });
    const row = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(task).first();
    expect(row).toMatchObject({
      title: "Book the flights",
      assignee_id: USER_2,
      due_date: "2026-10-25",
      status: "done",
      done_by_user_id: USER_1,
      done_at: now.toISOString(),
    });
    const events = await eventsFor("task", task);
    expect(events.map((e) => e.action)).toEqual(["create", "complete"]);

    await updateTask(ctx(), { run_id: run, id: task, patch: { assignee_id: null, due_date: null, status: "open" }, source_capture_ids: [] });
    const reopened = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(task).first();
    expect(reopened).toMatchObject({ status: "open", assignee_id: null, due_date: null, done_at: null, done_by_user_id: null });
  });

  it("refuses an empty patch, unknown ids, archived tasks, bad assignees and bad dates", async () => {
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(updateTask(ctx(), { run_id: run, id: task, patch: {}, source_capture_ids: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      updateTask(ctx(), { run_id: run, id: "ghost", patch: { title: "x" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateTask(ctx(), { run_id: run, id: task, patch: { assignee_id: "ghost" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateTask(ctx(), { run_id: run, id: task, patch: { due_date: "2026-02-30" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await mutate(db, human1, { entity: "task", action: "archive", id: task });
    await expect(
      updateTask(ctx(), { run_id: run, id: task, patch: { title: "x" }, source_capture_ids: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("assigning tasks whose sources are emails (SPEC 11.4)", () => {
  const PARTICIPANTS: EmailParticipant[] = [
    { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1 },
    { address: "two@example.com", name: "Person 2", role: "cc", user_id: USER_2 },
  ];
  const WITHOUT_TWO: EmailParticipant[] = [
    { address: "one@example.com", name: "Person 1", role: "from", user_id: USER_1 },
    { address: "guest@example.org", name: "Guest", role: "to", user_id: null },
  ];

  it("allows an assignee who is a participant of the source email", async () => {
    const email = await newEmailCapture({ participants: PARTICIPANTS });
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    const created = await createTask(ctx(), {
      run_id: run,
      title: "Book the cottage",
      assignee_id: USER_2,
      source_capture_ids: [email],
    });
    const createdRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(created.id).first();
    expect(createdRow).toMatchObject({ assignee_id: USER_2 });

    await updateTask(ctx(), {
      run_id: run,
      id: task,
      patch: { assignee_id: USER_2 },
      source_capture_ids: [email],
    });
    const updatedRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(task).first();
    expect(updatedRow).toMatchObject({ assignee_id: USER_2 });
  });

  it("refuses an assignee who is not on the source email, and writes nothing", async () => {
    const email = await newEmailCapture({ participants: WITHOUT_TWO });
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    const call = createTask(ctx(), {
      run_id: run,
      title: "Book the cottage",
      assignee_id: USER_2,
      source_capture_ids: [email],
    });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(call).rejects.toThrow("That person is not on the source email; leave the task unassigned.");
    expect(await count("tasks")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("refuses the same on update_task, leaving the task and its history untouched", async () => {
    const email = await newEmailCapture({ participants: WITHOUT_TWO });
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    const eventsBefore = await count("events");

    await expect(
      updateTask(ctx(), { run_id: run, id: task, patch: { assignee_id: USER_2 }, source_capture_ids: [email] }),
    ).rejects.toThrow("That person is not on the source email; leave the task unassigned.");
    const row = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(task).first();
    expect(row).toMatchObject({ assignee_id: null });
    expect(await count("events")).toBe(eventsBefore);
  });

  it("leaves writes alone when the sources are mixed, absent, or nobody is assigned", async () => {
    const email = await newEmailCapture({ participants: WITHOUT_TWO });
    const text = await newCapture("A typed thought");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    // Mixed sources are not held to the participant rule.
    const mixed = await createTask(ctx(), {
      run_id: run,
      title: "Mixed sources",
      assignee_id: USER_2,
      source_capture_ids: [email, text],
    });
    const mixedRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(mixed.id).first();
    expect(mixedRow).toMatchObject({ assignee_id: USER_2 });

    // No email sources at all: unchanged.
    const plain = await createTask(ctx(), {
      run_id: run,
      title: "No email involved",
      assignee_id: USER_2,
      source_capture_ids: [text],
    });
    const plainRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(plain.id).first();
    expect(plainRow).toMatchObject({ assignee_id: USER_2 });

    // All-email sources but nobody assigned: fine.
    const unassigned = await createTask(ctx(), {
      run_id: run,
      title: "Nobody yet",
      source_capture_ids: [email],
    });
    const unassignedRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(unassigned.id).first();
    expect(unassignedRow).toMatchObject({ assignee_id: null });

    // Clearing an assignee from an email-only write is allowed too.
    const task = await newTask();
    await updateTask(ctx(), {
      run_id: run,
      id: task,
      patch: { assignee_id: null },
      source_capture_ids: [email],
    });
    const clearedRow = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(task).first();
    expect(clearedRow).toMatchObject({ assignee_id: null });
  });

  it("allows the assignee when only one of several email sources has them on it", async () => {
    const withTwo = await newEmailCapture({ participants: PARTICIPANTS });
    const withoutTwo = await newEmailCapture({ participants: WITHOUT_TWO });
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    const created = await createTask(ctx(), {
      run_id: run,
      title: "Asked of Person 2 in one email",
      assignee_id: USER_2,
      source_capture_ids: [withoutTwo, withTwo],
    });
    const row = await db.prepare(`SELECT assignee_id FROM tasks WHERE id = ?`).bind(created.id).first();
    expect(row).toMatchObject({ assignee_id: USER_2 });
  });
});

describe("link_items and unlink_items", () => {
  it("links two open items once, and unlinks them again", async () => {
    const note = await newNote();
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    await linkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: task } });
    expect(await count("links")).toBe(1);
    await linkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: task } });
    expect(await count("links")).toBe(1);
    expect(await eventsFor("link", String((await db.prepare(`SELECT id FROM links`).first<{ id: string }>())?.id))).toHaveLength(1);

    await unlinkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: task } });
    const link = await db.prepare(`SELECT archived_at FROM links`).first();
    expect(link?.archived_at).not.toBeNull();
    await expect(
      unlinkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: task } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses unknown or archived endpoints", async () => {
    const note = await newNote();
    const task = await newTask();
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await expect(
      linkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await mutate(db, human1, { entity: "task", action: "archive", id: task });
    await expect(
      linkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: task } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await count("links")).toBe(0);
  });

  it("links two tasks so that one waits for the other", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    await linkItems(ctx(), {
      run_id: run,
      a: { type: "task", id: first },
      b: { type: "task", id: second },
      kind: "depends",
    });
    const link = await db.prepare(`SELECT direction FROM links`).first<{ direction: string }>();
    expect(link?.direction).toBe("a_to_b");
  });

  it("refuses a dependency that is not between two tasks, or that makes a circle", async () => {
    const note = await newNote();
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const third = await newTask("Call the plumber");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });

    await expect(
      linkItems(ctx(), { run_id: run, a: { type: "note", id: note }, b: { type: "task", id: second }, kind: "depends" }),
    ).rejects.toThrow("A dependency can only be between two tasks.");

    await linkItems(ctx(), { run_id: run, a: { type: "task", id: first }, b: { type: "task", id: second }, kind: "depends" });
    await linkItems(ctx(), { run_id: run, a: { type: "task", id: second }, b: { type: "task", id: third }, kind: "depends" });
    await expect(
      linkItems(ctx(), { run_id: run, a: { type: "task", id: third }, b: { type: "task", id: first }, kind: "depends" }),
    ).rejects.toThrow("That would make a circle of tasks waiting for each other.");
    expect(await count("links")).toBe(2);
  });

  it("keeps a dependency when the pair is linked again without a kind, and changes it with one", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    const a = { type: "task" as const, id: first };
    const b = { type: "task" as const, id: second };
    const direction = async () =>
      (await db.prepare(`SELECT direction FROM links`).first<{ direction: string }>())?.direction;

    await linkItems(ctx(), { run_id: run, a, b, kind: "depends" });
    await linkItems(ctx(), { run_id: run, a, b });
    expect(await direction()).toBe("a_to_b");
    await linkItems(ctx(), { run_id: run, a: b, b: a, kind: "depends" });
    expect(await direction()).toBe("b_to_a");
    await linkItems(ctx(), { run_id: run, a, b, kind: "related" });
    expect(await direction()).toBe("none");
    expect(await count("links")).toBe(1);
  });

  it("says which end of a dependency comes first", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await linkItems(ctx(), {
      run_id: run,
      a: { type: "task", id: second },
      b: { type: "task", id: first },
      kind: "depends",
    });
    const board = await getBoard(ctx(), {});
    expect(board.links).toEqual([
      {
        a: { type: "task", id: first },
        b: { type: "task", id: second },
        kind: "depends",
        before: { type: "task", id: second },
      },
    ]);
  });
});

describe("update_task warnings", () => {
  it("says what the task still waits for when it is ticked off", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const run = await openRun(USER_1, { startedAt: now.toISOString() });
    await linkItems(ctx(), {
      run_id: run,
      a: { type: "task", id: first },
      b: { type: "task", id: second },
      kind: "depends",
    });
    const done = await updateTask(ctx(), {
      run_id: run,
      id: second,
      patch: { status: "done" },
      source_capture_ids: [],
    });
    expect(done.warnings).toEqual(['Waits for "Book plumber", which is not done yet.']);

    await updateTask(ctx(), { run_id: run, id: first, patch: { status: "done" }, source_capture_ids: [] });
    const again = await updateTask(ctx(), {
      run_id: run,
      id: second,
      patch: { status: "open" },
      source_capture_ids: [],
    });
    expect(again.warnings).toBeUndefined();
  });
});

describe("mark_captures", () => {
  it("marks this run's captures and clears the claim", async () => {
    const capture = await newCapture();
    const { run_id } = await startRun(ctx(), { intent: "Work", capture_ids: [capture] });
    const marked = await markCaptures(ctx(), {
      run_id,
      capture_ids: [capture],
      status: "ignored",
      note: "Already on the board",
      source_capture_ids: [capture],
    });
    expect(marked.marked).toEqual([capture]);
    const row = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(capture).first();
    expect(row).toMatchObject({
      inbox_status: "ignored",
      processed_by_run_id: run_id,
      processed_at: now.toISOString(),
      processing_note: "Already on the board",
      claimed_by_run_id: null,
      claimed_at: null,
    });
    const events = await eventsFor("capture", capture);
    expect(events[events.length - 1]).toMatchObject({
      action: "update",
      actor_kind: "claude",
      actor_user_id: USER_1,
      run_id,
      source_capture_ids: [capture],
    });
  });

  it("refuses captures not claimed by this run, naming them", async () => {
    const mine = await newCapture("Mine");
    const theirs = await newCapture("Theirs");
    const { run_id } = await startRun(ctx(), { intent: "Work", capture_ids: [mine] });
    const otherRun = await openRun(USER_2, { startedAt: now.toISOString() });
    await claimRows([theirs], otherRun);

    const call = markCaptures(ctx(), {
      run_id,
      capture_ids: [mine, theirs, "ghost"],
      status: "processed",
      note: "All of them",
      source_capture_ids: [],
    });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(call).rejects.toThrow(`${theirs}, ghost`);
    const row = await db.prepare(`SELECT inbox_status FROM captures WHERE id = ?`).bind(mine).first();
    expect(row).toMatchObject({ inbox_status: "claimed" });
    const other = await db.prepare(`SELECT inbox_status FROM captures WHERE id = ?`).bind(theirs).first();
    expect(other).toMatchObject({ inbox_status: "claimed" });
  });
});

describe("closeExpiredRuns, through runScheduled", () => {
  it("closes a run past two hours and sends its captures back to the inbox", async () => {
    const startedAt = new Date(now.getTime() - 3 * HOUR);
    const oldRun = await openRun(USER_1, { startedAt: startedAt.toISOString() });
    const fresh = await openRun(USER_2, { startedAt: now.toISOString() });
    const capture = await newCapture();
    await claimRows([capture], oldRun, startedAt);

    await runScheduled(env, now);

    const row = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(capture).first();
    expect(row).toMatchObject({ inbox_status: "new", claimed_by_run_id: null, claimed_at: null });
    const closed = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(oldRun).first();
    expect(closed).toMatchObject({
      finished_at: now.toISOString(),
      summary: "Closed automatically after 2 hours; its unprocessed captures went back to the inbox.",
    });
    const stillOpen = await db.prepare(`SELECT finished_at FROM runs WHERE id = ?`).bind(fresh).first();
    expect(stillOpen?.finished_at).toBeNull();
  });

  it("keeps a run open when releasing its captures fails, and closes it next time", async () => {
    const startedAt = new Date(now.getTime() - 3 * HOUR);
    const run = await openRun(USER_1, { startedAt: startedAt.toISOString() });
    const capture = await newCapture();
    await claimRows([capture], run, startedAt);
    // Stand in the way of the release: this capture may not go back to 'new'.
    await db
      .prepare(
        `CREATE TRIGGER block_release BEFORE UPDATE ON captures
         WHEN OLD.claimed_by_run_id IS NOT NULL AND NEW.claimed_by_run_id IS NULL
         BEGIN SELECT RAISE(ABORT, 'release blocked'); END`,
      )
      .run();

    await runScheduled(env, now);

    // The run must stay unfinished, or its captures are stranded forever.
    const held = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(capture).first();
    expect(held).toMatchObject({ inbox_status: "claimed", claimed_by_run_id: run });
    const unclosed = await db.prepare(`SELECT finished_at FROM runs WHERE id = ?`).bind(run).first();
    expect(unclosed?.finished_at).toBeNull();

    // The next cron call, with the way clear, finishes the job.
    await db.prepare(`DROP TRIGGER block_release`).run();
    await runScheduled(env, now);

    const closed = await db.prepare(`SELECT finished_at FROM runs WHERE id = ?`).bind(run).first();
    expect(closed?.finished_at).toBe(now.toISOString());
    const freed = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(capture).first();
    expect(freed).toMatchObject({ inbox_status: "new", claimed_by_run_id: null, claimed_at: null });
  });

  it("closes at most 20 expired runs per call", async () => {
    const startedAt = new Date(now.getTime() - 3 * HOUR);
    for (let i = 0; i < 21; i++) {
      const run = await openRun(USER_1, { startedAt: startedAt.toISOString() });
      const capture = await newCapture(`Capture ${i}`);
      await claimRows([capture], run, startedAt);
    }
    await runScheduled(env, now);
    const finished = (await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL`).first<{ n: number }>())
      ?.n;
    expect(finished).toBe(20);
    expect(await count("runs")).toBe(21);
  });
});

describe("reverting a whole run made through the tools", () => {
  it("undoes everything, the capture included", async () => {
    const capture = await newCapture();
    const context = ctx();
    const { run_id } = await startRun(context, { intent: "Process one capture", capture_ids: [capture] });
    const note = await newNote("Context");
    const task = await createTask(context, {
      run_id,
      title: "Book the venue",
      link_to: [{ type: "note", id: note }],
      source_capture_ids: [capture],
    });
    await markCaptures(context, {
      run_id,
      capture_ids: [capture],
      status: "processed",
      note: "Turned into a task",
      source_capture_ids: [capture],
    });
    await finishRun(context, { run_id, summary: "One task created." });

    const api = asUser(USER_1);
    const revert = await ok<RevertResponse>(api.post(`/api/runs/${run_id}/revert`, {}));
    expect(revert.reverted).toBeGreaterThan(0);

    const taskRow = await db.prepare(`SELECT archived_at FROM tasks WHERE id = ?`).bind(task.id).first();
    expect(taskRow?.archived_at).not.toBeNull();
    const link = await db.prepare(`SELECT archived_at FROM links`).first();
    expect(link?.archived_at).not.toBeNull();
    const captureRow = await db.prepare(`SELECT * FROM captures WHERE id = ?`).bind(capture).first();
    expect(captureRow).toMatchObject({
      inbox_status: "new",
      claimed_by_run_id: null,
      claimed_at: null,
      processed_by_run_id: null,
      processed_at: null,
      processing_note: null,
    });
    // History is never rewritten: the run's events stay, revert events are added.
    const reverts = (await allEvents()).filter((e) => e.action === "revert");
    expect(reverts.length).toBe(revert.reverted);
  });
});

describe("attribution", () => {
  it("every Claude write carries the actor, the run and the source captures", async () => {
    const capture = await newCapture();
    const context = ctx(USER_2);
    const { run_id } = await startRun(context, { intent: "Everything", capture_ids: [capture] });
    const note = await createNote(context, { run_id, title: "A note", source_capture_ids: [capture] });
    await updateNote(context, { run_id, id: note.id, patch: { body: "With detail" }, source_capture_ids: [capture] });
    const task = await createTask(context, {
      run_id,
      title: "A task",
      link_to: [{ type: "note", id: note.id }],
      source_capture_ids: [capture],
    });
    await updateTask(context, { run_id, id: task.id, patch: { status: "done" }, source_capture_ids: [capture] });
    await linkItems(context, {
      run_id,
      a: { type: "note", id: note.id },
      b: { type: "task", id: task.id },
      source_capture_ids: [capture],
    });
    await markCaptures(context, {
      run_id,
      capture_ids: [capture],
      status: "processed",
      note: "All done",
      source_capture_ids: [capture],
    });
    await finishRun(context, { run_id, summary: "A note and a task." });

    const events = await allEvents();
    expect(events.length).toBeGreaterThanOrEqual(7);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_kind: "claude",
        actor_user_id: USER_2,
        run_id,
        source_capture_ids: [capture],
      });
    }
  });
});
