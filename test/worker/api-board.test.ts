import { beforeEach, describe, expect, it } from "vitest";
import type { MutationResponse } from "../../src/shared/api";
import type { Label, Link, NoteView, TaskView } from "../../src/shared/types";
import { GAP } from "../../src/shared/placement";
import { asUser, fails, ok, type TestApi } from "../helpers/api";
import { USER_1, USER_2, allEvents, eventsFor, freshDb } from "../helpers/db";

let db: D1Database;
let api: TestApi;
let api2: TestApi;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
  api2 = asUser(USER_2);
});

async function createNote(body: Record<string, unknown> = { title: "Plan the trip", x: 10, y: 20 }) {
  return ok(api.post<MutationResponse<NoteView>>("/api/notes", body));
}

async function createTask(body: Record<string, unknown> = { title: "Book flights" }) {
  return ok(api.post<MutationResponse<TaskView>>("/api/tasks", body));
}

async function createLabel(name = "Home", colour_hex = "#1D4ED8") {
  return ok(api.post<MutationResponse<Label>>("/api/labels", { name, colour_hex }));
}

describe("POST /api/notes", () => {
  it("creates a note with an event and provenance, answering 201", async () => {
    const result = await api.post<MutationResponse<NoteView>>("/api/notes", {
      title: "  Plan the trip  ",
      body: "Flights, car, places to stay",
      x: 10,
      y: -20.5,
      w: 300,
      h: 200,
    });
    expect(result.status).toBe(201);
    const { row, event } = result.body;
    expect(row).toMatchObject({
      title: "Plan the trip",
      body: "Flights, car, places to stay",
      label_id: null,
      x: 10,
      y: -20.5,
      w: 300,
      h: 200,
      archived_at: null,
    });
    expect(row.created_at).toBe(row.updated_at);
    expect(event).toMatchObject({
      action: "create",
      entity_type: "note",
      entity_id: row.id,
      actor_kind: "human",
      actor_user_id: USER_1,
      run_id: null,
      before: null,
    });
    expect(event?.seq).toBeGreaterThan(0);
    expect(row.prov).toEqual({
      created_by: { kind: "human", user_id: USER_1 },
      created_at: event?.ts,
      changed_by: { kind: "human", user_id: USER_1 },
      changed_at: event?.ts,
    });
    const stored = await db.prepare("SELECT title, x, y, w, h FROM notes WHERE id = ?").bind(row.id).first();
    expect(stored).toEqual({ title: "Plan the trip", x: 10, y: -20.5, w: 300, h: 200 });
  });

  it("allows an empty note and uses the default size", async () => {
    const { row } = await createNote({});
    expect(row).toMatchObject({ title: "", body: "", w: 240, h: 160 });
  });

  it("places a note without a position in a free spot", async () => {
    const first = await createNote({ title: "first" });
    expect(first.row).toMatchObject({ x: 0, y: 0 });
    const second = await createNote({ title: "second" });
    expect(second.row).toMatchObject({ x: 240 + GAP, y: 0 });
    // A task placed in the next free cell pushes the third note further along.
    await createTask({ title: "placed", x: 2 * (240 + GAP), y: 0 });
    const third = await createNote({ title: "third" });
    expect(third.row).toMatchObject({ x: 3 * (240 + GAP), y: 0 });
  });

  it("accepts an existing label and refuses missing or archived ones", async () => {
    const label = await createLabel();
    const { row } = await createNote({ title: "Labelled", label_id: label.row.id });
    expect(row.label_id).toBe(label.row.id);

    const missing = await fails(api.post("/api/notes", { label_id: "NO-SUCH-LABEL" }), 400);
    expect(missing).toMatchObject({ code: "invalid_request", message: "That label does not exist." });
    await ok(api.post(`/api/labels/${label.row.id}/archive`));
    const archived = await fails(api.post("/api/notes", { label_id: label.row.id }), 400);
    expect(archived.message).toMatch(/archived/);
  });

  it.each([
    ["a title that is too long", { title: "x".repeat(201) }, "title: A title can be at most 200 characters."],
    ["a body that is too long", { body: "x".repeat(20_001) }, "body: The text can be at most 20 000 characters."],
    ["a note that is too narrow", { w: 119 }, "w: A note must be at least 120 pixels wide."],
    ["a note that is too high", { h: 2001 }, "h: A note can be at most 2000 pixels high."],
    ["a position far off the board", { x: 1_000_001, y: 0 }, "x: That position is too far from the centre of the board."],
    ["only one coordinate", { x: 5 }, "x: Give both x and y, or neither to let the board find a free spot."],
    ["a coordinate that is not a number", { x: "5", y: 5 }, "x: Invalid input: expected number, received string"],
    ["an unknown field", { title: "x", colour: "red" }, 'request: Unrecognized key: "colour"'],
    ["a field only the server sets", { archived_at: "2026-01-01T00:00:00.000Z" }, 'request: Unrecognized key: "archived_at"'],
  ])("refuses %s", async (_name, body, message) => {
    const error = await fails(api.post("/api/notes", body), 400);
    expect(error).toMatchObject({ code: "invalid_request", message });
    expect(await allEvents()).toHaveLength(0);
  });

  it("refuses a body that is not JSON", async () => {
    const error = await fails(api.post("/api/notes", "{not json"), 400);
    expect(error.message).toBe("The request body must be JSON.");
  });
});

describe("the default label", () => {
  it("is given to new notes and tasks that name no label", async () => {
    const home = await createLabel("Home");
    const work = await createLabel("Work");
    await ok(api.put("/api/settings/default_label_id", { value: home.row.id }));
    expect((await createNote({ title: "Defaulted" })).row.label_id).toBe(home.row.id);
    expect((await createTask({ title: "Defaulted" })).row.label_id).toBe(home.row.id);
    expect((await createNote({ title: "Chosen", label_id: work.row.id })).row.label_id).toBe(work.row.id);
    expect((await createTask({ title: "None", label_id: null })).row.label_id).toBeNull();
  });

  it("is ignored once that label is archived", async () => {
    const home = await createLabel("Home");
    await ok(api.put("/api/settings/default_label_id", { value: home.row.id }));
    // Archive the label behind the API's back (the archive route also clears the setting).
    await db.prepare("UPDATE labels SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").bind(home.row.id).run();
    expect((await createNote({ title: "x" })).row.label_id).toBeNull();
    expect((await createTask({ title: "x" })).row.label_id).toBeNull();
  });
});

describe("PATCH /api/notes/:id", () => {
  it("records only the changed fields and who changed them", async () => {
    const created = await createNote();
    const { row, event } = await ok(
      api2.patch<MutationResponse<NoteView>>(`/api/notes/${created.row.id}`, {
        title: "Plan the holiday",
        body: "",
        x: 10,
      }),
    );
    expect(row.title).toBe("Plan the holiday");
    expect(event).toMatchObject({
      action: "update",
      actor_user_id: USER_2,
      before: { title: "Plan the trip" },
      after: { title: "Plan the holiday" },
    });
    expect(row.prov).toMatchObject({
      created_by: { kind: "human", user_id: USER_1 },
      changed_by: { kind: "human", user_id: USER_2 },
      changed_at: event?.ts,
    });
  });

  it("moves and resizes a note", async () => {
    const created = await createNote();
    const { row } = await ok(
      api.patch<MutationResponse<NoteView>>(`/api/notes/${created.row.id}`, { x: 500, y: 600, w: 400, h: 300 }),
    );
    expect(row).toMatchObject({ x: 500, y: 600, w: 400, h: 300 });
  });

  it("returns a null event when nothing changed", async () => {
    const created = await createNote();
    const result = await ok(api.patch<MutationResponse<NoteView>>(`/api/notes/${created.row.id}`, { title: "Plan the trip" }));
    expect(result.event).toBeNull();
    expect(result.row.title).toBe("Plan the trip");
    expect(await allEvents()).toHaveLength(1);
  });

  it("lets a note keep a label that was archived later", async () => {
    const label = await createLabel();
    const other = await createLabel("Work");
    const created = await createNote({ label_id: label.row.id });
    await ok(api.post(`/api/labels/${label.row.id}/archive`));
    await ok(api.patch(`/api/notes/${created.row.id}`, { label_id: label.row.id, title: "Still labelled" }));
    await ok(api.patch(`/api/notes/${created.row.id}`, { label_id: other.row.id }));
    const error = await fails(api.patch(`/api/notes/${created.row.id}`, { label_id: label.row.id }), 400);
    expect(error.message).toMatch(/archived/);
    await ok(api.patch(`/api/notes/${created.row.id}`, { label_id: null }));
  });

  it("answers 404 for an unknown note and 400 for bad fields", async () => {
    const missing = await fails(api.patch("/api/notes/NO-SUCH-NOTE", { title: "x" }), 404);
    expect(missing).toMatchObject({ code: "not_found", message: "No note with id NO-SUCH-NOTE." });
    const created = await createNote();
    await fails(api.patch(`/api/notes/${created.row.id}`, { created_at: "2020-01-01" }), 400);
    await fails(api.patch(`/api/notes/${created.row.id}`, { w: 5000 }), 400);
    await fails(api.patch(`/api/notes/${created.row.id}`, { y: Number.MAX_SAFE_INTEGER }), 400);
  });
});

describe("archiving notes", () => {
  it("archives and unarchives, with events", async () => {
    const created = await createNote();
    const archived = await ok(api.post<MutationResponse<NoteView>>(`/api/notes/${created.row.id}/archive`));
    expect(archived.event?.action).toBe("archive");
    expect(archived.row.archived_at).not.toBeNull();
    expect(archived.row.prov?.changed_at).toBe(archived.event?.ts);
    const again = await ok(api.post<MutationResponse<NoteView>>(`/api/notes/${created.row.id}/archive`));
    expect(again.event).toBeNull();
    const back = await ok(api.post<MutationResponse<NoteView>>(`/api/notes/${created.row.id}/unarchive`));
    expect(back.event).toMatchObject({ action: "unarchive", after: { archived_at: null } });
    expect(back.row.archived_at).toBeNull();
  });

  it("answers 404 for unknown notes", async () => {
    await fails(api.post("/api/notes/NOPE/archive"), 404);
    await fails(api.post("/api/notes/NOPE/unarchive"), 404);
  });
});

describe("POST /api/tasks", () => {
  it("creates a task in the tray by default", async () => {
    const result = await api.post<MutationResponse<TaskView>>("/api/tasks", { title: " Book flights " });
    expect(result.status).toBe(201);
    expect(result.body.row).toMatchObject({
      title: "Book flights",
      detail: "",
      status: "open",
      assignee_id: null,
      due_date: null,
      x: null,
      y: null,
      done_at: null,
      done_by_user_id: null,
    });
    expect(result.body.row.prov?.created_by).toEqual({ kind: "human", user_id: USER_1 });
  });

  it("creates a placed, assigned, dated and labelled task", async () => {
    const label = await createLabel();
    const { row, event } = await createTask({
      title: "Renew licence",
      detail: "Take the old one along",
      label_id: label.row.id,
      assignee_id: USER_2,
      due_date: "2026-11-30",
      x: 100,
      y: 200,
    });
    expect(row).toMatchObject({
      label_id: label.row.id,
      assignee_id: USER_2,
      due_date: "2026-11-30",
      x: 100,
      y: 200,
    });
    expect(event?.after).toMatchObject({ assignee_id: USER_2, due_date: "2026-11-30" });
  });

  it.each([
    ["a missing title", {}, "title: Invalid input: expected string, received undefined"],
    ["a blank title", { title: "   " }, "title: Give the task a title."],
    ["a title that is too long", { title: "x".repeat(201) }, "title: A title can be at most 200 characters."],
    ["detail that is too long", { title: "t", detail: "x".repeat(20_001) }, "detail: The text can be at most 20 000 characters."],
    ["an impossible due date", { title: "t", due_date: "2026-02-30" }, "due_date: A date must be a real date written as YYYY-MM-DD."],
    ["a due date in another format", { title: "t", due_date: "30/11/2026" }, "due_date: A date must be a real date written as YYYY-MM-DD."],
    ["only x", { title: "t", x: 1 }, "x: Give x and y together: both numbers to place the task, or both null to put it in the tray."],
    ["x without y as null", { title: "t", x: 1, y: null }, "x: Give x and y together: both numbers to place the task, or both null to put it in the tray."],
    ["a status on create", { title: "t", status: "done" }, 'request: Unrecognized key: "status"'],
    ["an unknown assignee", { title: "t", assignee_id: "SOMEONE-ELSE" }, "A task can only be assigned to one of the two people."],
    ["an unknown label", { title: "t", label_id: "NO-SUCH-LABEL" }, "That label does not exist."],
  ])("refuses %s", async (_name, body, message) => {
    const error = await fails(api.post("/api/tasks", body), 400);
    expect(error).toMatchObject({ code: "invalid_request", message });
    expect(await allEvents()).toHaveLength(0);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("records a status change as complete or reopen, with who and when", async () => {
    const created = await createTask();
    const done = await ok(api2.patch<MutationResponse<TaskView>>(`/api/tasks/${created.row.id}`, { status: "done" }));
    expect(done.event?.action).toBe("complete");
    expect(done.row).toMatchObject({ status: "done", done_by_user_id: USER_2 });
    expect(done.row.done_at).toBe(done.event?.ts);
    const reopened = await ok(api.patch<MutationResponse<TaskView>>(`/api/tasks/${created.row.id}`, { status: "open" }));
    expect(reopened.event?.action).toBe("reopen");
    expect(reopened.row).toMatchObject({ status: "open", done_at: null, done_by_user_id: null });
  });

  it("assigns, dates, places and moves a task back to the tray", async () => {
    const created = await createTask();
    const id = created.row.id;
    const assigned = await ok(
      api.patch<MutationResponse<TaskView>>(`/api/tasks/${id}`, { assignee_id: USER_2, due_date: "2026-10-31" }),
    );
    expect(assigned.event).toMatchObject({
      action: "update",
      before: { assignee_id: null, due_date: null },
      after: { assignee_id: USER_2, due_date: "2026-10-31" },
    });
    const placed = await ok(api.patch<MutationResponse<TaskView>>(`/api/tasks/${id}`, { x: 40, y: 50 }));
    expect(placed.row).toMatchObject({ x: 40, y: 50 });
    const tray = await ok(api.patch<MutationResponse<TaskView>>(`/api/tasks/${id}`, { x: null, y: null }));
    expect(tray.row).toMatchObject({ x: null, y: null });
    const cleared = await ok(api.patch<MutationResponse<TaskView>>(`/api/tasks/${id}`, { assignee_id: null, due_date: null }));
    expect(cleared.row).toMatchObject({ assignee_id: null, due_date: null });
  });

  it("refuses bad values and unknown tasks", async () => {
    const created = await createTask();
    const id = created.row.id;
    await fails(api.patch(`/api/tasks/${id}`, { title: "" }), 400);
    await fails(api.patch(`/api/tasks/${id}`, { status: "cancelled" }), 400);
    await fails(api.patch(`/api/tasks/${id}`, { x: 5 }), 400);
    await fails(api.patch(`/api/tasks/${id}`, { done_by_user_id: USER_1 }), 400);
    await fails(api.patch(`/api/tasks/${id}`, { assignee_id: "nobody" }), 400);
    await fails(api.patch(`/api/tasks/${id}`, { due_date: "2026-13-01" }), 400);
    await fails(api.patch("/api/tasks/NO-SUCH-TASK", { title: "x" }), 404);
    expect(await eventsFor("task", id)).toHaveLength(1);
  });
});

describe("task actions", () => {
  it("completes, reopens, archives and unarchives", async () => {
    const created = await createTask();
    const id = created.row.id;
    const done = await ok(api2.post<MutationResponse<TaskView>>(`/api/tasks/${id}/complete`));
    expect(done.event?.action).toBe("complete");
    expect(done.row).toMatchObject({ status: "done", done_by_user_id: USER_2 });
    expect(done.row.prov?.changed_by).toEqual({ kind: "human", user_id: USER_2 });
    const twice = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${id}/complete`));
    expect(twice.event).toBeNull();
    expect(twice.row.done_by_user_id).toBe(USER_2);
    const reopened = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${id}/reopen`));
    expect(reopened.event?.action).toBe("reopen");
    const archived = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${id}/archive`));
    expect(archived.row.archived_at).not.toBeNull();
    const back = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${id}/unarchive`));
    expect(back.row.archived_at).toBeNull();
    expect((await eventsFor("task", id)).map((e) => e.action)).toEqual([
      "create",
      "complete",
      "reopen",
      "archive",
      "unarchive",
    ]);
  });

  it("answers 404 for unknown tasks", async () => {
    for (const action of ["complete", "reopen", "archive", "unarchive"]) {
      const error = await fails(api.post(`/api/tasks/NOPE/${action}`), 404);
      expect(error.code).toBe("not_found");
    }
  });
});

describe("links", () => {
  it("links a task and a note once, in canonical order", async () => {
    const note = await createNote();
    const task = await createTask();
    const first = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        a: { type: "task", id: task.row.id },
        b: { type: "note", id: note.row.id },
      }),
    );
    expect(first.row).toMatchObject({
      a_type: "note",
      a_id: note.row.id,
      b_type: "task",
      b_id: task.row.id,
      archived_at: null,
    });
    expect(first.event).toMatchObject({ action: "link", entity_type: "link", entity_id: first.row.id, before: null });
    const again = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        a: { type: "note", id: note.row.id },
        b: { type: "task", id: task.row.id },
      }),
    );
    expect(again.event).toBeNull();
    expect(again.row.id).toBe(first.row.id);
  });

  it("unlinks and links the same pair again on the same row", async () => {
    const one = await createNote({ title: "one" });
    const two = await createNote({ title: "two" });
    const body = { a: { type: "note", id: one.row.id }, b: { type: "note", id: two.row.id } };
    const linked = await ok(api.post<MutationResponse<Link>>("/api/links", body));
    const unlinked = await ok(api.post<MutationResponse<Link>>(`/api/links/${linked.row.id}/unlink`));
    expect(unlinked.event?.action).toBe("unlink");
    expect(unlinked.row.archived_at).not.toBeNull();
    const twice = await ok(api.post<MutationResponse<Link>>(`/api/links/${linked.row.id}/unlink`));
    expect(twice.event).toBeNull();
    const relinked = await ok(api.post<MutationResponse<Link>>("/api/links", body));
    expect(relinked.row.id).toBe(linked.row.id);
    expect(relinked.row.archived_at).toBeNull();
    expect(relinked.event).toMatchObject({ action: "link", after: { archived_at: null } });
  });

  it("refuses self links, bad types, missing and archived items", async () => {
    const note = await createNote();
    const ref = { type: "note", id: note.row.id };
    const self = await fails(api.post("/api/links", { a: ref, b: ref }), 400);
    expect(self.message).toBe("An item cannot be linked to itself.");
    const badType = await fails(api.post("/api/links", { a: ref, b: { type: "label", id: "x" } }), 400);
    expect(badType.message).toBe("b.type: An item is either a note or a task.");
    await fails(api.post("/api/links", { a: ref }), 400);
    await fails(api.post("/api/links", { a: ref, b: { type: "task", id: "x", extra: 1 } }), 400);
    const missing = await fails(api.post("/api/links", { a: ref, b: { type: "task", id: "NO-SUCH-TASK" } }), 404);
    expect(missing.message).toBe("No open task with id NO-SUCH-TASK.");
    const archived = await createNote({ title: "gone" });
    await ok(api.post(`/api/notes/${archived.row.id}/archive`));
    await fails(api.post("/api/links", { a: ref, b: { type: "note", id: archived.row.id } }), 404);
    await fails(api.post("/api/links/NO-SUCH-LINK/unlink"), 404);
    expect((await allEvents()).filter((e) => e.entity_type === "link")).toHaveLength(0);
  });
});

describe("dependencies between tasks", () => {
  it("links two tasks so that one waits for the other", async () => {
    const first = await createTask({ title: "Book plumber" });
    const second = await createTask({ title: "Fix the sink" });
    const linked = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        depends: { before: { type: "task", id: first.row.id }, after: { type: "task", id: second.row.id } },
      }),
    );
    expect(linked.row.direction).toBe("a_to_b");
    expect(linked.event).toMatchObject({ action: "link", after: { direction: "a_to_b" } });
  });

  it("says which end waits, whichever order the dependency was asked in", async () => {
    const first = await createTask({ title: "Book plumber" });
    const second = await createTask({ title: "Fix the sink" });
    const linked = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        depends: { before: { type: "task", id: second.row.id }, after: { type: "task", id: first.row.id } },
      }),
    );
    expect(linked.row).toMatchObject({
      a_type: "task",
      a_id: first.row.id,
      b_type: "task",
      b_id: second.row.id,
      direction: "b_to_a",
    });
  });

  it("refuses a dependency that is not between two tasks", async () => {
    const note = await createNote();
    const task = await createTask();
    const error = await fails(
      api.post("/api/links", {
        depends: { before: { type: "note", id: note.row.id }, after: { type: "task", id: task.row.id } },
      }),
      400,
    );
    expect(error.message).toBe("A dependency can only be between two tasks.");
  });

  it("refuses a circle of tasks waiting for each other", async () => {
    const one = await createTask({ title: "one" });
    const two = await createTask({ title: "two" });
    const three = await createTask({ title: "three" });
    await ok(
      api.post("/api/links", {
        depends: { before: { type: "task", id: one.row.id }, after: { type: "task", id: two.row.id } },
      }),
    );
    await ok(
      api.post("/api/links", {
        depends: { before: { type: "task", id: two.row.id }, after: { type: "task", id: three.row.id } },
      }),
    );
    const error = await fails(
      api.post("/api/links", {
        depends: { before: { type: "task", id: three.row.id }, after: { type: "task", id: one.row.id } },
      }),
      400,
    );
    expect(error.message).toBe("That would make a circle of tasks waiting for each other.");
  });

  it("changes the direction of a link", async () => {
    const first = await createTask({ title: "Book plumber" });
    const second = await createTask({ title: "Fix the sink" });
    const linked = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        a: { type: "task", id: first.row.id },
        b: { type: "task", id: second.row.id },
      }),
    );
    expect(linked.row.direction).toBe("none");
    const changed = await ok(
      api.patch<MutationResponse<Link>>(`/api/links/${linked.row.id}`, {
        depends: { before: { type: "task", id: first.row.id }, after: { type: "task", id: second.row.id } },
      }),
    );
    expect(changed.row.direction).toBe("a_to_b");
    expect(changed.event).toMatchObject({ action: "update", before: { direction: "none" }, after: { direction: "a_to_b" } });
  });

  it("turns a dependency back into a plain connection", async () => {
    const first = await createTask({ title: "Book plumber" });
    const second = await createTask({ title: "Fix the sink" });
    const linked = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        depends: { before: { type: "task", id: first.row.id }, after: { type: "task", id: second.row.id } },
      }),
    );
    const plain = await ok(api.patch<MutationResponse<Link>>(`/api/links/${linked.row.id}`, { direction: "none" }));
    expect(plain.row.direction).toBe("none");
    expect(plain.event).toMatchObject({ action: "update", before: { direction: "a_to_b" }, after: { direction: "none" } });
  });

  it("refuses a link that does not join the two items", async () => {
    const first = await createTask({ title: "Book plumber" });
    const second = await createTask({ title: "Fix the sink" });
    const third = await createTask({ title: "Call the plumber" });
    const linked = await ok(
      api.post<MutationResponse<Link>>("/api/links", {
        a: { type: "task", id: first.row.id },
        b: { type: "task", id: second.row.id },
      }),
    );
    const error = await fails(
      api.patch(`/api/links/${linked.row.id}`, {
        depends: { before: { type: "task", id: first.row.id }, after: { type: "task", id: third.row.id } },
      }),
      400,
    );
    expect(error.message).toBe("A link can only be changed between the two items it joins.");
    await fails(api.patch("/api/links/NO-SUCH-LINK", { direction: "none" }), 404);
  });

  it("tells the person what a task still waits for when it is ticked off", async () => {
    const plumber = await createTask({ title: "Book plumber" });
    const sink = await createTask({ title: "Fix the sink" });
    await ok(
      api.post("/api/links", {
        depends: { before: { type: "task", id: plumber.row.id }, after: { type: "task", id: sink.row.id } },
      }),
    );
    const done = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${sink.row.id}/complete`));
    expect(done.warnings).toEqual(['Waits for "Book plumber", which is not done yet.']);
    await ok(api.post(`/api/tasks/${plumber.row.id}/complete`));
    const again = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${sink.row.id}/complete`));
    expect(again.warnings).toBeUndefined();
  });

  it("says nothing when there is nothing to say", async () => {
    const task = await createTask({ title: "Book flights" });
    const done = await ok(api.post<MutationResponse<TaskView>>(`/api/tasks/${task.row.id}/complete`));
    expect(done.warnings).toBeUndefined();
  });
});
