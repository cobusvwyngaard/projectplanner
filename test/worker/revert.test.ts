import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/worker/lib/errors";
import { claudeActor, humanActor } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { RevertConflictError, revertEvent, revertRun } from "../../src/worker/mutate/revert";
import { USER_1, USER_2, eventsFor, freshDb, openRun } from "../helpers/db";

const human1 = humanActor(USER_1);
const human2 = humanActor(USER_2);
let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

async function title(id: string) {
  return db.prepare("SELECT title FROM notes WHERE id = ?").bind(id).first<string>("title");
}

describe("revert one event", () => {
  it("writes a compensating event and restores the old values", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A", body: "x" } });
    const id = String(row.id);
    const change = await mutate(db, human2, { entity: "note", action: "update", id, patch: { title: "B" } });
    const outcome = await revertEvent(db, human1, String(change.event?.id));
    expect(outcome.reverted).toBe(1);
    expect(await title(id)).toBe("A");
    const events = await eventsFor("note", id);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      action: "revert",
      reverts_event_id: change.event?.id,
      actor_user_id: USER_1,
      before: { title: "B" },
      after: { title: "A" },
    });
    // History is never rewritten.
    expect(events[1]).toMatchObject({ action: "update", after: { title: "B" } });
  });

  it("archives an item when its creation is reverted", async () => {
    const created = await mutate(db, human1, { entity: "task", action: "create", values: { title: "T" } });
    await revertEvent(db, human1, String(created.event?.id));
    const row = await db.prepare("SELECT archived_at FROM tasks WHERE id = ?").bind(created.id).first();
    expect(row?.archived_at).not.toBeNull();
  });

  it("restores status and who ticked it off when a completion is reverted", async () => {
    const created = await mutate(db, human1, { entity: "task", action: "create", values: { title: "T" } });
    const done = await mutate(db, human2, { entity: "task", action: "complete", id: created.id });
    await revertEvent(db, human1, String(done.event?.id));
    const row = await db.prepare("SELECT status, done_at, done_by_user_id FROM tasks WHERE id = ?").bind(created.id).first();
    expect(row).toEqual({ status: "open", done_at: null, done_by_user_id: null });
  });

  it("warns when a later event touched the same field, and proceeds on confirm", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const first = await mutate(db, human1, { entity: "note", action: "update", id, patch: { title: "B" } });
    await mutate(db, human2, { entity: "note", action: "update", id, patch: { title: "C" } });
    const error = await revertEvent(db, human1, String(first.event?.id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevertConflictError);
    expect((error as RevertConflictError).conflicts[0]).toMatchObject({ field: "title" });
    expect(await title(id)).toBe("C");
    await revertEvent(db, human1, String(first.event?.id), { confirm: true });
    expect(await title(id)).toBe("A");
  });

  it("does not warn when later events touched other fields", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const first = await mutate(db, human1, { entity: "note", action: "update", id, patch: { title: "B" } });
    await mutate(db, human2, { entity: "note", action: "update", id, patch: { body: "notes" } });
    await revertEvent(db, human1, String(first.event?.id));
    expect(await title(id)).toBe("A");
  });

  it("can revert a revert", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const change = await mutate(db, human1, { entity: "note", action: "update", id, patch: { title: "B" } });
    const undo = await revertEvent(db, human1, String(change.event?.id));
    await revertEvent(db, human1, String(undo.results[0]?.event?.id));
    expect(await title(id)).toBe("B");
  });

  it("is a no-op when the values are already back", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const change = await mutate(db, human1, { entity: "note", action: "update", id, patch: { title: "B" } });
    await revertEvent(db, human1, String(change.event?.id));
    const again = await revertEvent(db, human1, String(change.event?.id), { confirm: true });
    expect(again.reverted).toBe(0);
  });

  it("refuses unknown events and sign-in events", async () => {
    await expect(revertEvent(db, human1, "missing")).rejects.toBeInstanceOf(NotFoundError);
    await db
      .prepare(
        "INSERT INTO events (id, ts, actor_kind, actor_user_id, entity_type, entity_id, action) VALUES ('LOGIN1', ?, 'human', ?, 'session', 'S1', 'login')",
      )
      .bind(new Date().toISOString(), USER_1)
      .run();
    await expect(revertEvent(db, human1, "LOGIN1")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("revert a whole run", () => {
  it("reverts every event of the run, newest first, in one go", async () => {
    const existing = await mutate(db, human1, { entity: "note", action: "create", values: { title: "Human note" } });
    const runId = await openRun(USER_2);
    const claude = claudeActor(USER_2, runId);
    const note = await mutate(db, claude, { entity: "note", action: "create", values: { title: "Claude note" } });
    const task = await mutate(db, claude, { entity: "task", action: "create", values: { title: "Claude task" } });
    await mutate(db, claude, { entity: "task", action: "update", id: task.id, patch: { title: "Renamed by Claude" } });
    await mutate(db, claude, { entity: "note", action: "update", id: existing.id, patch: { body: "Claude added this" } });
    const link = await mutate(db, claude, {
      entity: "link",
      action: "link",
      a: { type: "note", id: note.id },
      b: { type: "task", id: task.id },
    });

    const outcome = await revertRun(db, human1, runId);
    expect(outcome.reverted).toBe(5);
    const noteRow = await db.prepare("SELECT archived_at FROM notes WHERE id = ?").bind(note.id).first();
    const taskRow = await db.prepare("SELECT title, archived_at FROM tasks WHERE id = ?").bind(task.id).first();
    const linkRow = await db.prepare("SELECT archived_at FROM links WHERE id = ?").bind(link.id).first();
    const existingRow = await db.prepare("SELECT body, archived_at FROM notes WHERE id = ?").bind(existing.id).first();
    expect(noteRow?.archived_at).not.toBeNull();
    expect(taskRow).toMatchObject({ title: "Claude task" });
    expect(taskRow?.archived_at).not.toBeNull();
    expect(linkRow?.archived_at).not.toBeNull();
    expect(existingRow).toEqual({ body: "", archived_at: null });
  });

  it("warns about human changes made after the run, per field", async () => {
    const runId = await openRun(USER_2);
    const note = await mutate(db, claudeActor(USER_2, runId), { entity: "note", action: "create", values: { title: "Claude note" } });
    await mutate(db, human1, { entity: "note", action: "update", id: note.id, patch: { title: "Fixed by a person" } });
    await expect(revertRun(db, human1, runId)).rejects.toBeInstanceOf(RevertConflictError);
    await revertRun(db, human1, runId, { confirm: true });
    const row = await db.prepare("SELECT archived_at FROM notes WHERE id = ?").bind(note.id).first();
    expect(row?.archived_at).not.toBeNull();
  });

  it("does not count a person's earlier revert of a run event as a conflict", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const runId = await openRun(USER_2);
    const change = await mutate(db, claudeActor(USER_2, runId), { entity: "note", action: "update", id: String(row.id), patch: { title: "B" } });
    await revertEvent(db, human1, String(change.event?.id));
    const outcome = await revertRun(db, human1, runId);
    expect(outcome.reverted).toBe(0);
  });

  it("reports unknown runs", async () => {
    await expect(revertRun(db, human1, "missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * The database with another person's change slipped in while a revert is
 * under way: just before the revert's batch commits ("batch"), or between its
 * conflict check and mutate reading the note ("read"). `times` limits how
 * often it happens.
 */
function racingDb(at: "batch" | "read", interfere: () => Promise<unknown>, times = 1): D1Database {
  let left = times;
  const fire = async () => {
    if (left <= 0) return;
    left--;
    await interfere();
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch" && at === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await fire();
          return target.batch(statements);
        };
      }
      if (prop === "prepare" && at === "read") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/ FROM notes WHERE id = \?$/.test(sql)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                first: async () => {
                  await fire();
                  return bound.first();
                },
              };
            },
          } as unknown as D1PreparedStatement;
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("revert while someone else is changing the same item", () => {
  async function renamedNote() {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const change = await mutate(db, human1, { entity: "note", action: "update", id, patch: { title: "B" } });
    return { id, eventId: String(change.event?.id) };
  }

  it("reports a rename committed just before the revert's batch as a conflict", async () => {
    const { id, eventId } = await renamedNote();
    const racing = racingDb("batch", () => mutate(db, human2, { entity: "note", action: "update", id, patch: { title: "C" } }));
    const error = await revertEvent(racing, human1, eventId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevertConflictError);
    expect((error as RevertConflictError).conflicts[0]).toMatchObject({ field: "title", later_event: { actor_user_id: USER_2 } });
    expect(await title(id)).toBe("C");
    expect((await eventsFor("note", id)).map((e) => e.action)).toEqual(["create", "update", "update"]);
  });

  it("reports a rename committed between the conflict check and the read as a conflict", async () => {
    const { id, eventId } = await renamedNote();
    const racing = racingDb("read", () => mutate(db, human2, { entity: "note", action: "update", id, patch: { title: "C" } }));
    await expect(revertEvent(racing, human1, eventId)).rejects.toBeInstanceOf(RevertConflictError);
    expect(await title(id)).toBe("C");
  });

  it("goes ahead when the change at the same moment touched other fields", async () => {
    const { id, eventId } = await renamedNote();
    const racing = racingDb("batch", () => mutate(db, human2, { entity: "note", action: "update", id, patch: { body: "Mine" } }));
    const outcome = await revertEvent(racing, human1, eventId);
    expect(outcome.reverted).toBe(1);
    const row = await db.prepare("SELECT title, body FROM notes WHERE id = ?").bind(id).first();
    expect(row).toEqual({ title: "A", body: "Mine" });
  });

  it("asks to try again after three attempts when changes keep arriving", async () => {
    const { id, eventId } = await renamedNote();
    let n = 0;
    const racing = racingDb(
      "batch",
      () => mutate(db, human2, { entity: "note", action: "update", id, patch: { body: `Edit ${++n}` } }),
      Number.POSITIVE_INFINITY,
    );
    const error = await revertEvent(racing, human1, eventId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(RevertConflictError);
    expect((error as ConflictError).message).toMatch(/at the same moment/);
    expect(n).toBe(3);
    expect(await title(id)).toBe("B");
  });

  it("reports a rename made during a whole-run revert as a conflict", async () => {
    const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title: "A" } });
    const id = String(row.id);
    const runId = await openRun(USER_2);
    await mutate(db, claudeActor(USER_2, runId), { entity: "note", action: "update", id, patch: { title: "B" } });
    const racing = racingDb("batch", () => mutate(db, human2, { entity: "note", action: "update", id, patch: { title: "C" } }));
    await expect(revertRun(racing, human1, runId)).rejects.toBeInstanceOf(RevertConflictError);
    expect(await title(id)).toBe("C");
  });
});
