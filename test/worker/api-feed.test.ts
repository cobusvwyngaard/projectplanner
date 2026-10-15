import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../src/shared/api";
import type { Label, Link, NoteView, TaskView } from "../../src/shared/types";
import { localToday } from "../../src/shared/dates";
import { CHANGES_PAGE_SIZE } from "../../src/worker/board/feed";
import { SYSTEM_ACTOR, claudeActor, humanActor } from "../../src/worker/mutate/actor";
import { mutate, mutateMany, type Mutation } from "../../src/worker/mutate/index";
import { asUser, fails, ok, type TestApi } from "../helpers/api";
import { USER_1, USER_2, allEvents, freshDb, openRun } from "../helpers/db";

let db: D1Database;
let api: TestApi;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
});

const bootstrap = () => ok(api.get<BootstrapResponse>("/api/bootstrap"));
const changes = (since?: string) =>
  ok(api.get<ChangesResponse>(since === undefined ? "/api/changes" : `/api/changes?since=${since}`));

async function createNote(title: string) {
  return (await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title, x: 0, y: 0 }))).row;
}

async function createTask(title: string) {
  return (await ok(api.post<MutationResponse<TaskView>>("/api/tasks", { title }))).row;
}

async function createLabel(name: string) {
  return (await ok(api.post<MutationResponse<Label>>("/api/labels", { name, colour_hex: "#123456" }))).row;
}

/** A cursor after one first event, as an app that loaded a non-empty board holds. */
async function startCursor(): Promise<string> {
  await createNote("Start");
  const { cursor } = await bootstrap();
  if (cursor === null) throw new Error("expected a cursor");
  return cursor;
}

describe("GET /api/bootstrap", () => {
  it("works on an empty board", async () => {
    const body = await bootstrap();
    expect(body.me).toMatchObject({ id: USER_1, display_name: "Person 1", initials: "P1" });
    expect(body.users.map((u) => u.id)).toEqual([USER_1, USER_2]);
    expect(body).toMatchObject({
      labels: [],
      notes: [],
      tasks: [],
      links: [],
      cursor: null,
      settings: { stt_keyterms: [], stt_keyterms_enabled: false, default_label_id: null },
    });
    expect(body.today).toBe(localToday());
  });

  it("returns the open board, every label in order and the newest event as cursor", async () => {
    const work = await createLabel("Work");
    const home = await createLabel("Home");
    const old = await createLabel("Old");
    await ok(api.post(`/api/labels/${old.id}/archive`));
    await ok(api.post("/api/labels/reorder", { ids: [home.id, work.id] }));

    const note = await createNote("Kept");
    const gone = await createNote("Archived");
    await ok(api.post(`/api/notes/${gone.id}/archive`));
    const open = await createTask("Open");
    const done = await createTask("Done");
    await ok(api.post(`/api/tasks/${done.id}/complete`));
    const hidden = await createTask("Archived task");
    await ok(api.post(`/api/tasks/${hidden.id}/archive`));
    const kept = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: note.id }, b: { type: "task", id: open.id } }));
    const removed = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: note.id }, b: { type: "task", id: done.id } }));
    await ok(api.post(`/api/links/${removed.row.id}/unlink`));
    await ok(api.patch(`/api/users/${USER_1}`, { display_name: "Cobus" }));

    const body = await bootstrap();
    expect(body.me.display_name).toBe("Cobus");
    expect(body.labels.map((l) => l.name)).toEqual(["Home", "Work", "Old"]);
    expect(body.labels[2]?.archived_at).not.toBeNull();
    expect(body.notes.map((n) => n.title)).toEqual(["Kept"]);
    expect(body.tasks.map((t) => [t.title, t.status])).toEqual([
      ["Open", "open"],
      ["Done", "done"],
    ]);
    expect(body.links.map((l) => l.id)).toEqual([kept.row.id]);
    expect(body.notes[0]?.prov?.created_by).toEqual({ kind: "human", user_id: USER_1 });
    expect(body.tasks[1]?.prov?.changed_by).toEqual({ kind: "human", user_id: USER_1 });
    const events = await allEvents();
    expect(body.cursor).toBe(events[events.length - 1]?.id);
  });
});

describe("GET /api/changes", () => {
  it("returns nothing new for the latest cursor", async () => {
    await createNote("One");
    const { cursor } = await bootstrap();
    const body = await changes(cursor ?? undefined);
    expect(body).toMatchObject({ events: [], notes: [], cursor, more: false, reset: false, settings: null });
  });

  it("returns newer events oldest first with the current rows they touched", async () => {
    const note = await createNote("Before");
    const { cursor } = await bootstrap();
    const task = await createTask("New task");
    await ok(api.patch(`/api/notes/${note.id}`, { title: "Renamed" }));
    await ok(api.patch(`/api/notes/${note.id}`, { title: "Renamed again" }));
    const link = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: note.id }, b: { type: "task", id: task.id } }));

    const body = await changes(cursor ?? undefined);
    expect(body.reset).toBe(false);
    expect(body.events.map((e) => [e.entity_type, e.action])).toEqual([
      ["task", "create"],
      ["note", "update"],
      ["note", "update"],
      ["link", "link"],
    ]);
    expect(body.events.map((e) => e.seq)).toEqual([...body.events.map((e) => e.seq)].sort((a, b) => a - b));
    // One current row per touched item, not one per event.
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toMatchObject({ id: note.id, title: "Renamed again" });
    expect(body.notes[0]?.prov?.changed_at).toBe(body.events[2]?.ts);
    expect(body.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(body.tasks[0]?.prov).not.toBeNull();
    expect(body.links.map((l) => l.id)).toEqual([link.row.id]);
    expect(body).toMatchObject({ labels: [], users: [], captures: [], settings: null, more: false });
    expect(body.cursor).toBe(body.events[3]?.id);
    // The next poll from the returned cursor is empty.
    expect((await changes(body.cursor ?? undefined)).events).toEqual([]);
  });

  it("includes archived rows so the app can drop them", async () => {
    const note = await createNote("Going");
    const label = await createLabel("Old");
    const { cursor } = await bootstrap();
    await ok(api.post(`/api/notes/${note.id}/archive`));
    await ok(api.post(`/api/labels/${label.id}/archive`));
    const body = await changes(cursor ?? undefined);
    expect(body.notes[0]?.archived_at).not.toBeNull();
    expect(body.labels[0]?.archived_at).not.toBeNull();
  });

  it("includes users and the full settings when they changed", async () => {
    const cursor = await startCursor();
    await ok(api.patch(`/api/users/${USER_2}`, { display_name: "Anna" }));
    await ok(api.put("/api/settings/stt_keyterms_enabled", { value: true }));
    const body = await changes(cursor);
    expect(body.users).toEqual([expect.objectContaining({ id: USER_2, display_name: "Anna" })]);
    expect(body.settings).toEqual({ stt_keyterms: [], stt_keyterms_enabled: true, default_label_id: null });
  });

  it("includes captures without the raw transcript", async () => {
    const cursor = await startCursor();
    const capture = await mutate(db, humanActor(USER_2), {
      entity: "capture",
      action: "create",
      values: { kind: "voice", author_user_id: USER_2, transcript_status: "pending", inbox_status: "new" },
    });
    await mutate(db, SYSTEM_ACTOR, {
      entity: "capture",
      action: "update",
      id: capture.id,
      patch: { text: "Buy paint", transcript_json: '{"secret":"raw"}', transcript_status: "done" },
    });
    const body = await changes(cursor);
    expect(body.events.map((e) => e.actor_kind)).toEqual(["human", "system"]);
    expect(body.captures).toHaveLength(1);
    expect(body.captures[0]).toMatchObject({ id: capture.id, text: "Buy paint", transcript_status: "done" });
    expect(body.captures[0]).not.toHaveProperty("transcript_json");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("includes Claude's changes with the run that made them", async () => {
    const cursor = await startCursor();
    const runId = await openRun(USER_2);
    await mutate(db, claudeActor(USER_2, runId), { entity: "note", action: "create", values: { title: "From Claude" } });
    const body = await changes(cursor);
    expect(body.events[0]).toMatchObject({ actor_kind: "claude", actor_user_id: USER_2, run_id: runId });
    expect(body.notes[0]?.prov?.created_by).toEqual({ kind: "claude", user_id: USER_2 });
  });

  it("pages through more than one page of events", async () => {
    const cursor = await startCursor();
    const total = CHANGES_PAGE_SIZE + 5;
    for (let start = 0; start < total; start += 100) {
      const batch: Mutation[] = [];
      for (let i = start; i < Math.min(start + 100, total); i++) {
        batch.push({ entity: "note", action: "create", values: { title: `Note ${i}` } });
      }
      await mutateMany(db, humanActor(USER_1), batch);
    }
    const first = await changes(cursor);
    expect(first.events).toHaveLength(CHANGES_PAGE_SIZE);
    expect(first.more).toBe(true);
    expect(first.notes).toHaveLength(CHANGES_PAGE_SIZE);
    expect(first.cursor).toBe(first.events[CHANGES_PAGE_SIZE - 1]?.id);
    const second = await changes(first.cursor ?? undefined);
    expect(second.events).toHaveLength(5);
    expect(second.more).toBe(false);
    expect(second.notes.map((n) => n.title)).toEqual(["Note 500", "Note 501", "Note 502", "Note 503", "Note 504"]);
  });

  it("asks the app to reload for an unknown cursor", async () => {
    await createNote("One");
    const body = await changes("NOT-AN-EVENT");
    expect(body).toMatchObject({ events: [], reset: true, more: false, cursor: "NOT-AN-EVENT" });
  });

  it("treats a missing cursor as unknown once events exist", async () => {
    // Nothing has happened yet: an app without a cursor has seen everything.
    expect(await changes()).toMatchObject({ reset: false, events: [], cursor: null });
    expect(await ok(api.get<ChangesResponse>("/api/changes?since="))).toMatchObject({ reset: false });
    await createNote("One");
    expect(await changes()).toMatchObject({ reset: true, events: [], cursor: null });
  });

  it("refuses unknown query parameters", async () => {
    await fails(api.get("/api/changes?after=1"), 400);
  });
});
