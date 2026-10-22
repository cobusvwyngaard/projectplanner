// Directed links between tasks (docs/testing-findings.md, item 2).
//
// A link keeps the two ends in the canonical order it has always had and
// gains a direction: 'none' for a plain connection, 'a_to_b' or 'b_to_a' for a
// dependency. The Worker refuses a dependency that is not between two tasks
// and one that would make a circle of tasks waiting for each other.

import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/worker/lib/errors";
import { humanActor } from "../../src/worker/mutate/actor";
import { mutate, mutateMany } from "../../src/worker/mutate/index";
import { revertEvent } from "../../src/worker/mutate/revert";
import { USER_1, allEvents, eventsFor, freshDb } from "../helpers/db";

const human1 = humanActor(USER_1);
let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

async function newTask(title: string) {
  const { row } = await mutate(db, human1, { entity: "task", action: "create", values: { title } });
  return { type: "task" as const, id: String(row.id) };
}

async function newNote(title: string) {
  const { row } = await mutate(db, human1, { entity: "note", action: "create", values: { title } });
  return { type: "note" as const, id: String(row.id) };
}

describe("the direction column", () => {
  it("starts every link as a plain connection", async () => {
    const columns = await db.prepare("PRAGMA table_info(links)").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toContain("direction");
    const note = await newNote("Plan the trip");
    const task = await newTask("Book flights");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: note, b: task });
    expect(linked.row.direction).toBe("none");
    const stored = await db.prepare("SELECT direction FROM links WHERE id = ?").bind(linked.id).first();
    expect(stored).toEqual({ direction: "none" });
  });

  it("only allows the three known directions", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO links (id, a_type, a_id, b_type, b_id, direction, created_at, archived_at)
           VALUES ('L1', 'task', 'T1', 'task', 'T2', 'sideways', '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).rejects.toThrow();
  });
});

describe("dependencies", () => {
  it("says which end comes first, whichever order it was asked in", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const forward = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: first, after: second },
    });
    expect(forward.row).toMatchObject({
      a_type: "task",
      a_id: first.id,
      b_type: "task",
      b_id: second.id,
      direction: "a_to_b",
    });
    expect(forward.event?.action).toBe("link");
    expect(forward.event?.after).toMatchObject({ direction: "a_to_b" });

    const other = await newTask("Call the plumber");
    const backward = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: other, after: first },
    });
    expect(backward.row).toMatchObject({ a_id: first.id, b_id: other.id, direction: "b_to_a" });
  });

  it("keeps a plain connection plain", async () => {
    const note = await newNote("Plan the trip");
    const task = await newTask("Book flights");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: note, b: task });
    expect(linked.row.direction).toBe("none");
  });

  it("refuses a dependency that is not between two tasks", async () => {
    const note = await newNote("Plan the trip");
    const task = await newTask("Book flights");
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: note, after: task } }),
    ).rejects.toThrow("A dependency can only be between two tasks.");
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: task, after: note } }),
    ).rejects.toThrow("A dependency can only be between two tasks.");
    expect(await allEvents()).toHaveLength(2);
  });

  it("refuses a circle of tasks waiting for each other", async () => {
    const one = await newTask("one");
    const two = await newTask("two");
    const three = await newTask("three");
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: one, after: two } });
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: two, after: three } });
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: three, after: one } }),
    ).rejects.toThrow("That would make a circle of tasks waiting for each other.");
    const links = await db.prepare("SELECT id FROM links").all();
    expect(links.results).toHaveLength(2);
  });

  it("refuses a circle made in one batch", async () => {
    const one = await newTask("one");
    const two = await newTask("two");
    const three = await newTask("three");
    await expect(
      mutateMany(db, human1, [
        { entity: "link", action: "link", depends: { before: one, after: two } },
        { entity: "link", action: "link", depends: { before: two, after: three } },
        { entity: "link", action: "link", depends: { before: three, after: one } },
      ]),
    ).rejects.toThrow("That would make a circle of tasks waiting for each other.");
    const links = await db.prepare("SELECT id FROM links").all();
    expect(links.results).toHaveLength(0);
  });

  it("allows a dependency to be turned around", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: first, after: second },
    });
    const turned = await mutate(db, human1, {
      entity: "link",
      action: "relink",
      id: linked.id,
      depends: { before: second, after: first },
    });
    expect(turned.row.direction).toBe("b_to_a");
    expect(turned.event?.action).toBe("update");
    expect(turned.event?.before).toEqual({ direction: "a_to_b" });
    expect(turned.event?.after).toEqual({ direction: "b_to_a" });
  });
});

describe("changing a link", () => {
  it("records the direction it had and the one it has now", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: first, b: second });
    expect(linked.row.direction).toBe("none");
    const changed = await mutate(db, human1, {
      entity: "link",
      action: "relink",
      id: linked.id,
      depends: { before: first, after: second },
    });
    expect(changed.row.direction).toBe("a_to_b");
    expect(changed.event?.action).toBe("update");
    expect(changed.event?.before).toEqual({ direction: "none" });
    expect(changed.event?.after).toEqual({ direction: "a_to_b" });
    const events = await eventsFor("link", linked.id);
    expect(events.map((e) => e.action)).toEqual(["link", "update"]);
  });

  it("turns a dependency back into a plain connection", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: first, after: second },
    });
    const plain = await mutate(db, human1, { entity: "link", action: "relink", id: linked.id, related: true });
    expect(plain.row.direction).toBe("none");
    expect(plain.event?.before).toEqual({ direction: "a_to_b" });
  });

  it("only changes a link between the two items it joins", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const third = await newTask("Call the plumber");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: first, b: second });
    await expect(
      mutate(db, human1, { entity: "link", action: "relink", id: linked.id, depends: { before: first, after: third } }),
    ).rejects.toThrow("A link can only be changed between the two items it joins.");
    expect(linked.row.direction).toBe("none");
  });

  it("writes nothing when the direction is already right", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: first, after: second },
    });
    const again = await mutate(db, human1, {
      entity: "link",
      action: "relink",
      id: linked.id,
      depends: { before: first, after: second },
    });
    expect(again.event).toBeNull();
    expect(again.row.direction).toBe("a_to_b");
  });

  it("re-links an unlinked pair with the direction asked for", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: first, after: second },
    });
    await mutate(db, human1, { entity: "link", action: "unlink", id: linked.id });
    const again = await mutate(db, human1, { entity: "link", action: "link", a: first, b: second });
    expect(again.id).toBe(linked.id);
    expect(again.row.direction).toBe("none");
    expect(again.row.archived_at).toBeNull();
    expect(again.event?.action).toBe("link");
    expect(again.event?.before).toMatchObject({ direction: "a_to_b" });
  });

  it("puts the direction back when the change is reverted", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: first, b: second });
    const changed = await mutate(db, human1, {
      entity: "link",
      action: "relink",
      id: linked.id,
      depends: { before: first, after: second },
    });
    expect(changed.event).not.toBeNull();
    await revertEvent(db, human1, String(changed.event?.id));
    const stored = await db.prepare("SELECT direction FROM links WHERE id = ?").bind(linked.id).first();
    expect(stored).toEqual({ direction: "none" });
  });
});

describe("the rules hold on every path", () => {
  it("refuses to re-link an unlinked note and task as a dependency", async () => {
    const note = await newNote("Plan the trip");
    const task = await newTask("Book flights");
    const linked = await mutate(db, human1, { entity: "link", action: "link", a: note, b: task });
    await mutate(db, human1, { entity: "link", action: "unlink", id: linked.id });
    const before = (await allEvents(db)).length;
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: note, after: task } }),
    ).rejects.toThrow("A dependency can only be between two tasks.");
    expect((await allEvents(db)).length).toBe(before);
  });

  it("refuses to re-link an unlinked pair where it would make a circle", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const third = await newTask("Pay the plumber");
    const plain = await mutate(db, human1, { entity: "link", action: "link", a: third, b: first });
    await mutate(db, human1, { entity: "link", action: "unlink", id: plain.id });
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: first, after: second } });
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: second, after: third } });
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: third, after: first } }),
    ).rejects.toThrow("That would make a circle of tasks waiting for each other.");
    const stored = await db.prepare("SELECT direction, archived_at FROM links WHERE id = ?").bind(plain.id).first();
    expect(stored).toMatchObject({ direction: "none" });
    expect(stored?.archived_at).not.toBeNull();
  });

  it("keeps a dependency when the pair is linked again without a kind", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: first, after: second } });
    const again = await mutate(db, human1, { entity: "link", action: "link", a: second, b: first });
    expect(again.event).toBeNull();
    expect(again.row.direction).not.toBe("none");
    const plain = await mutate(db, human1, { entity: "link", action: "link", a: second, b: first, related: true });
    expect(plain.row.direction).toBe("none");
    expect(plain.event?.action).toBe("update");
  });

  it("refuses to revert an unlink when the dependency would now close a circle", async () => {
    const first = await newTask("Book plumber");
    const second = await newTask("Fix the sink");
    const third = await newTask("Pay the plumber");
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: first, after: second } });
    const middle = await mutate(db, human1, {
      entity: "link",
      action: "link",
      depends: { before: second, after: third },
    });
    const unlinked = await mutate(db, human1, { entity: "link", action: "unlink", id: middle.id });
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: third, after: first } });
    await expect(revertEvent(db, human1, String(unlinked.event?.id))).rejects.toThrow(
      "That would make a circle of tasks waiting for each other.",
    );
    const stored = await db.prepare("SELECT archived_at FROM links WHERE id = ?").bind(middle.id).first();
    expect(stored?.archived_at).not.toBeNull();
  });
});

describe("finishing a task that still waits for another", () => {
  it("warns about the task it waits for", async () => {
    const plumber = await newTask("Book plumber");
    const sink = await newTask("Fix the sink");
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: plumber, after: sink } });
    const done = await mutate(db, human1, { entity: "task", action: "complete", id: sink.id });
    expect(done.row.status).toBe("done");
    expect(done.warnings).toEqual(['Waits for "Book plumber", which is not done yet.']);
  });

  it("says nothing when the task it waits for is done", async () => {
    const plumber = await newTask("Book plumber");
    const sink = await newTask("Fix the sink");
    await mutate(db, human1, { entity: "link", action: "link", depends: { before: plumber, after: sink } });
    await mutate(db, human1, { entity: "task", action: "complete", id: plumber.id });
    const done = await mutate(db, human1, { entity: "task", action: "complete", id: sink.id });
    expect(done.warnings).toEqual([]);
  });

  it("says nothing about tasks that do not wait for anything", async () => {
    const task = await newTask("Book plumber");
    const done = await mutate(db, human1, { entity: "task", action: "complete", id: task.id });
    expect(done.warnings).toEqual([]);
  });
});

describe("guards", () => {
  it("refuses a link that changes a direction it does not join", async () => {
    const note = await newNote("Plan the trip");
    const task = await newTask("Book flights");
    await expect(
      mutate(db, human1, { entity: "link", action: "relink", id: "nope", related: true }),
    ).rejects.toThrow("No link with id nope.");
    await expect(
      mutate(db, human1, { entity: "link", action: "link", depends: { before: note, after: task } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
