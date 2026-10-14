import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, RunNotOpenError, ValidationError } from "../../src/worker/lib/errors";
import { claudeActor, humanActor, SYSTEM_ACTOR } from "../../src/worker/mutate/actor";
import { mutate, mutateMany } from "../../src/worker/mutate/index";
import { USER_1, USER_2, allEvents, eventsFor, freshDb, openRun } from "../helpers/db";

const human1 = humanActor(USER_1);
let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

async function newNote(title = "Plan the trip") {
  return mutate(db, human1, { entity: "note", action: "create", values: { title, x: 10, y: 20 } });
}

async function newTask(title = "Book flights") {
  return mutate(db, human1, { entity: "task", action: "create", values: { title } });
}

describe("create", () => {
  it("inserts the row and an event with the full row in one go", async () => {
    const { row, event } = await newNote();
    expect(row.title).toBe("Plan the trip");
    expect(row.body).toBe("");
    expect(row.w).toBe(240);
    const stored = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(row.id).first();
    expect(stored).toMatchObject({ title: "Plan the trip", x: 10, y: 20, archived_at: null });
    expect(event).toMatchObject({
      action: "create",
      actor_kind: "human",
      actor_user_id: USER_1,
      run_id: null,
      entity_type: "note",
      entity_id: row.id,
      before: null,
    });
    expect(event?.after).toMatchObject({ title: "Plan the trip", body: "", x: 10, y: 20 });
    expect(event?.seq).toBeGreaterThan(0);
    expect(await allEvents()).toHaveLength(1);
  });

  it("rejects unknown fields", async () => {
    await expect(
      mutate(db, human1, { entity: "note", action: "create", values: { title: "x", archived_at: "2026-01-01" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mutate(db, human1, { entity: "note", action: "create", values: { nonsense: 1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await allEvents()).toHaveLength(0);
  });

  it("records who ticked off a task created as done", async () => {
    const { row } = await mutate(db, human1, { entity: "task", action: "create", values: { title: "x", status: "done" } });
    expect(row.done_by_user_id).toBe(USER_1);
    expect(row.done_at).not.toBeNull();
  });
});

describe("update", () => {
  it("stores only the changed fields as before/after", async () => {
    const { row } = await newNote();
    const { event, row: after } = await mutate(db, humanActor(USER_2), {
      entity: "note",
      action: "update",
      id: String(row.id),
      patch: { title: "Plan the holiday", body: "", x: 10 },
    });
    expect(event?.before).toEqual({ title: "Plan the trip" });
    expect(event?.after).toEqual({ title: "Plan the holiday" });
    expect(event?.actor_user_id).toBe(USER_2);
    expect(after.title).toBe("Plan the holiday");
  });

  it("writes no event when nothing changes", async () => {
    const { row } = await newNote();
    const result = await mutate(db, human1, { entity: "note", action: "update", id: String(row.id), patch: { title: "Plan the trip" } });
    expect(result.event).toBeNull();
    expect(await allEvents()).toHaveLength(1);
  });

  it("refuses fields the actor may not write", async () => {
    const { row } = await newTask();
    await expect(
      mutate(db, human1, { entity: "task", action: "update", id: String(row.id), patch: { done_at: "2026-01-01" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mutate(db, human1, { entity: "task", action: "update", id: String(row.id), patch: { created_at: "x" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("reports unknown ids", async () => {
    await expect(
      mutate(db, human1, { entity: "note", action: "update", id: "nope", patch: { title: "x" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("checks expect preconditions", async () => {
    const { row } = await newNote();
    await expect(
      mutate(db, human1, { entity: "note", action: "update", id: String(row.id), patch: { title: "y" }, expect: { title: "other" } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("turns a status change into complete/reopen with who and when", async () => {
    const { row } = await newTask();
    const id = String(row.id);
    const done = await mutate(db, humanActor(USER_2), { entity: "task", action: "update", id, patch: { status: "done" } });
    expect(done.event?.action).toBe("complete");
    expect(done.row).toMatchObject({ status: "done", done_by_user_id: USER_2 });
    expect(done.event?.before).toEqual({ status: "open", done_at: null, done_by_user_id: null });
    const reopened = await mutate(db, human1, { entity: "task", action: "reopen", id });
    expect(reopened.event?.action).toBe("reopen");
    expect(reopened.row).toMatchObject({ status: "open", done_at: null, done_by_user_id: null });
  });
});

describe("archive", () => {
  it("archives and unarchives; archiving twice is a no-op", async () => {
    const { row } = await newNote();
    const id = String(row.id);
    const archived = await mutate(db, human1, { entity: "note", action: "archive", id });
    expect(archived.event?.action).toBe("archive");
    expect(archived.row.archived_at).not.toBeNull();
    expect((await mutate(db, human1, { entity: "note", action: "archive", id })).event).toBeNull();
    const back = await mutate(db, human1, { entity: "note", action: "unarchive", id });
    expect(back.event?.after).toEqual({ archived_at: null });
  });

  it("cannot archive users or settings", async () => {
    await expect(mutate(db, human1, { entity: "user", action: "archive", id: USER_1 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("links", () => {
  it("stores pairs in canonical order, once", async () => {
    const note = await newNote();
    const task = await newTask();
    const a = { type: "task" as const, id: String(task.row.id) };
    const b = { type: "note" as const, id: String(note.row.id) };
    const first = await mutate(db, human1, { entity: "link", action: "link", a, b });
    expect(first.event?.action).toBe("link");
    expect(first.row).toMatchObject({ a_type: "note", b_type: "task" });
    const again = await mutate(db, human1, { entity: "link", action: "link", a: b, b: a });
    expect(again.event).toBeNull();
    expect(again.id).toBe(first.id);
  });

  it("unlinks by archiving and re-links the same row", async () => {
    const n1 = await newNote("one");
    const n2 = await newNote("two");
    const a = { type: "note" as const, id: String(n1.row.id) };
    const b = { type: "note" as const, id: String(n2.row.id) };
    const linked = await mutate(db, human1, { entity: "link", action: "link", a, b });
    const unlinked = await mutate(db, human1, { entity: "link", action: "unlink", id: linked.id });
    expect(unlinked.event?.action).toBe("unlink");
    const relinked = await mutate(db, human1, { entity: "link", action: "link", a, b });
    expect(relinked.id).toBe(linked.id);
    expect(relinked.event?.before).toMatchObject({ archived_at: unlinked.row.archived_at });
    expect(relinked.row.archived_at).toBeNull();
  });

  it("rejects self links and archived or missing endpoints", async () => {
    const n1 = await newNote();
    const ref = { type: "note" as const, id: String(n1.row.id) };
    await expect(mutate(db, human1, { entity: "link", action: "link", a: ref, b: ref })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mutate(db, human1, { entity: "link", action: "link", a: ref, b: { type: "task", id: "missing" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const n2 = await newNote("archived");
    await mutate(db, human1, { entity: "note", action: "archive", id: String(n2.row.id) });
    await expect(
      mutate(db, human1, { entity: "link", action: "link", a: ref, b: { type: "note", id: String(n2.row.id) } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Claude guardrails", () => {
  it("attributes writes to the run and the user, with source captures", async () => {
    const runId = await openRun(USER_2);
    const { event } = await mutate(db, claudeActor(USER_2, runId), {
      entity: "note",
      action: "create",
      values: { title: "From a voice note" },
      sourceCaptureIds: ["CAPTURE1"],
    });
    expect(event).toMatchObject({ actor_kind: "claude", actor_user_id: USER_2, run_id: runId, source_capture_ids: ["CAPTURE1"] });
  });

  it("rejects writes without an open run of that user", async () => {
    const values = { title: "x" };
    await expect(
      mutate(db, claudeActor(USER_1, "NO-SUCH-RUN"), { entity: "note", action: "create", values }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    const otherUsersRun = await openRun(USER_2);
    await expect(
      mutate(db, claudeActor(USER_1, otherUsersRun), { entity: "note", action: "create", values }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    const finished = await openRun(USER_1, { finished: true });
    await expect(
      mutate(db, claudeActor(USER_1, finished), { entity: "note", action: "create", values }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    const expired = await openRun(USER_1, { startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await expect(
      mutate(db, claudeActor(USER_1, expired), { entity: "note", action: "create", values }),
    ).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notes").first("n")).toBe(0);
    expect(await allEvents()).toHaveLength(0);
  });

  it("cannot archive, unarchive or revert", async () => {
    const { row } = await newNote();
    const runId = await openRun(USER_1);
    const claude = claudeActor(USER_1, runId);
    await expect(mutate(db, claude, { entity: "note", action: "archive", id: String(row.id) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mutate(db, claude, { entity: "note", action: "unarchive", id: String(row.id) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      mutate(db, claude, { entity: "note", action: "revert", id: String(row.id), patch: { title: "x" }, revertsEventId: "e" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot change labels, settings or users", async () => {
    const runId = await openRun(USER_1);
    const claude = claudeActor(USER_1, runId);
    await expect(
      mutate(db, claude, { entity: "label", action: "create", values: { name: "x", colour_hex: "#ffffff" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      mutate(db, claude, { entity: "setting", action: "update", id: "stt_keyterms", patch: { value_json: "[]" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      mutate(db, claude, { entity: "user", action: "update", id: USER_1, patch: { display_name: "x" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot edit archived items", async () => {
    const { row } = await newNote();
    await mutate(db, human1, { entity: "note", action: "archive", id: String(row.id) });
    const runId = await openRun(USER_1);
    await expect(
      mutate(db, claudeActor(USER_1, runId), { entity: "note", action: "update", id: String(row.id), patch: { title: "x" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the system cannot create board items", async () => {
    await expect(
      mutate(db, SYSTEM_ACTOR, { entity: "note", action: "create", values: { title: "x" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("atomicity", () => {
  it("D1 batch rolls back the entity write when the event insert fails", async () => {
    const { row } = await newNote();
    await expect(
      db.batch([
        db.prepare("UPDATE notes SET title = 'changed' WHERE id = ?").bind(row.id),
        db.prepare(
          "INSERT INTO events (id, ts, actor_kind, entity_type, entity_id, action) VALUES ('X', 'now', 'robot', 'note', ?, 'update')",
        ).bind(row.id),
      ]),
    ).rejects.toThrow();
    expect(await db.prepare("SELECT title FROM notes WHERE id = ?").bind(row.id).first("title")).toBe("Plan the trip");
  });

  it("aborts and retries when the row changed between read and write", async () => {
    const { row } = await newNote();
    // The prelude runs inside the same transaction, after mutate read the row,
    // so the conditional update always misses and the guard aborts the batch.
    const interfering = db.prepare("UPDATE notes SET title = 'sneaky' WHERE id = ?").bind(row.id);
    await expect(
      mutate(db, human1, { entity: "note", action: "update", id: String(row.id), patch: { title: "mine" } }, { prelude: [interfering] }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await db.prepare("SELECT title FROM notes WHERE id = ?").bind(row.id).first("title")).toBe("Plan the trip");
    expect(await eventsFor("note", String(row.id))).toHaveLength(1);
  });

  it("mutateMany commits all changes or none", async () => {
    const { row } = await newNote();
    await expect(
      mutateMany(db, human1, [
        { entity: "note", action: "update", id: String(row.id), patch: { title: "first" } },
        { entity: "note", action: "update", id: String(row.id), patch: { label_id: "NO-SUCH-LABEL" } },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.prepare("SELECT title FROM notes WHERE id = ?").bind(row.id).first("title")).toBe("Plan the trip");
    expect(await allEvents()).toHaveLength(1);
  });

  it("later changes in one call see earlier ones", async () => {
    const { row } = await newNote();
    const results = await mutateMany(db, human1, [
      { entity: "note", action: "update", id: String(row.id), patch: { title: "A" } },
      { entity: "note", action: "update", id: String(row.id), patch: { title: "B" } },
    ]);
    expect(results[1]?.event?.before).toEqual({ title: "A" });
    expect(await db.prepare("SELECT title FROM notes WHERE id = ?").bind(row.id).first("title")).toBe("B");
  });
});

describe("events table", () => {
  it("is append-only", async () => {
    await newNote();
    await expect(db.prepare("UPDATE events SET action = 'update'").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM events").run()).rejects.toThrow(/append-only/);
    expect(await allEvents()).toHaveLength(1);
  });

  it("has a commit-ordered sequence", async () => {
    await newNote("a");
    await newNote("b");
    const events = await allEvents();
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
  });
});

describe("settings and users", () => {
  it("updates a setting and a user name with events", async () => {
    const s = await mutate(db, human1, { entity: "setting", action: "update", id: "stt_keyterms", patch: { value_json: '["Cobus"]' } });
    expect(s.event?.before).toEqual({ value_json: "[]" });
    const u = await mutate(db, human1, { entity: "user", action: "update", id: USER_2, patch: { display_name: "Anna" } });
    expect(u.event?.after).toEqual({ display_name: "Anna" });
  });
});
