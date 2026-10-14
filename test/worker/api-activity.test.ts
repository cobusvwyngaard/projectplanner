import { beforeEach, describe, expect, it } from "vitest";
import type {
  EventsResponse,
  HistoryResponse,
  MutationResponse,
  RevertConflictView,
  RevertResponse,
  RunDetailResponse,
  RunsResponse,
} from "../../src/shared/api";
import type { Label, Link, NoteView, PlannerEvent, TaskView } from "../../src/shared/types";
import { SYSTEM_ACTOR, claudeActor, humanActor } from "../../src/worker/mutate/actor";
import { mutate, type MutationResult } from "../../src/worker/mutate/index";
import { asUser, fails, ok, type TestApi } from "../helpers/api";
import { USER_1, USER_2, freshDb, openRun } from "../helpers/db";

let db: D1Database;
let api: TestApi;
const human1 = humanActor(USER_1);
const human2 = humanActor(USER_2);
const at = (iso: string) => ({ now: new Date(iso) });

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
});

function eventOf(result: MutationResult): PlannerEvent {
  if (!result.event) throw new Error("expected an event");
  return result.event;
}

async function textCapture(text: string, options: { now?: Date } = {}) {
  return mutate(
    db,
    human1,
    {
      entity: "capture",
      action: "create",
      values: { kind: "text", author_user_id: USER_1, text, transcript_status: "n/a", inbox_status: "new" },
    },
    options,
  );
}

const events = (query = "") => ok(api.get<EventsResponse>(`/api/events${query}`));
const ids = (body: EventsResponse) => body.events.map((e) => e.id);

describe("GET /api/events", () => {
  // Africa/Johannesburg is UTC+2: 21:59Z on 1 March is 23:59 local, 22:00Z is midnight on 2 March.
  let e: Record<"noteCreated" | "noteRenamed" | "claudeTask" | "captured" | "transcribed", PlannerEvent>;
  let runId: string;
  let noteId: string;
  let captureId: string;

  beforeEach(async () => {
    const note = await mutate(db, human1, { entity: "note", action: "create", values: { title: "Shopping list" } }, at("2026-03-01T21:59:00.000Z"));
    noteId = note.id;
    const renamed = await mutate(db, human2, { entity: "note", action: "update", id: note.id, patch: { title: "Groceries" } }, at("2026-03-01T22:00:00.000Z"));
    runId = await openRun(USER_2, { startedAt: "2026-03-03T09:30:00.000Z" });
    const task = await mutate(db, claudeActor(USER_2, runId), { entity: "task", action: "create", values: { title: "Buy paint" } }, at("2026-03-03T10:00:00.000Z"));
    const capture = await textCapture("Remember the paint", at("2026-03-04T08:00:00.000Z"));
    captureId = capture.id;
    const transcribed = await mutate(db, SYSTEM_ACTOR, { entity: "capture", action: "update", id: capture.id, patch: { transcript_error: "none" } }, at("2026-03-04T09:00:00.000Z"));
    e = {
      noteCreated: eventOf(note),
      noteRenamed: eventOf(renamed),
      claudeTask: eventOf(task),
      captured: eventOf(capture),
      transcribed: eventOf(transcribed),
    };
  });

  it("lists every event newest first", async () => {
    const body = await events();
    expect(ids(body)).toEqual([e.transcribed.id, e.captured.id, e.claudeTask.id, e.noteRenamed.id, e.noteCreated.id]);
    expect(body.next).toBeNull();
    expect(body.events[0]).toEqual(e.transcribed);
  });

  it("filters to what the humans did, what Claude did and what the system did", async () => {
    expect(ids(await events("?actor=human"))).toEqual([e.captured.id, e.noteRenamed.id, e.noteCreated.id]);
    expect(ids(await events("?actor=claude"))).toEqual([e.claudeTask.id]);
    expect(ids(await events("?actor=system"))).toEqual([e.transcribed.id]);
  });

  it("filters by person, with or without Claude acting for them", async () => {
    expect(ids(await events(`?user_id=${USER_2}`))).toEqual([e.claudeTask.id, e.noteRenamed.id]);
    expect(ids(await events(`?user_id=${USER_2}&actor=human`))).toEqual([e.noteRenamed.id]);
    expect(ids(await events(`?user_id=${USER_1}`))).toEqual([e.captured.id, e.noteCreated.id]);
  });

  it("filters by run and returns the runs the events refer to", async () => {
    const body = await events(`?run_id=${runId}`);
    expect(ids(body)).toEqual([e.claudeTask.id]);
    expect(body.runs).toEqual([
      { id: runId, user_id: USER_2, intent: "test run", summary: null, started_at: "2026-03-03T09:30:00.000Z", finished_at: null },
    ]);
    expect((await events("?actor=human")).runs).toEqual([]);
  });

  it("filters by local dates in Africa/Johannesburg, inclusive", async () => {
    expect(ids(await events("?from=2026-03-01&to=2026-03-01"))).toEqual([e.noteCreated.id]);
    expect(ids(await events("?from=2026-03-02&to=2026-03-02"))).toEqual([e.noteRenamed.id]);
    expect(ids(await events("?from=2026-03-02"))).toEqual([e.transcribed.id, e.captured.id, e.claudeTask.id, e.noteRenamed.id]);
    expect(ids(await events("?to=2026-03-03"))).toEqual([e.claudeTask.id, e.noteRenamed.id, e.noteCreated.id]);
    expect(ids(await events("?from=2026-03-05"))).toEqual([]);
  });

  it("filters by item", async () => {
    expect(ids(await events(`?entity_type=note&entity_id=${noteId}`))).toEqual([e.noteRenamed.id, e.noteCreated.id]);
    expect(ids(await events("?entity_type=capture"))).toEqual([e.transcribed.id, e.captured.id]);
    expect(ids(await events(`?entity_id=${captureId}&actor=human`))).toEqual([e.captured.id]);
  });

  it("pages with before and limit", async () => {
    const first = await events("?limit=2");
    expect(ids(first)).toEqual([e.transcribed.id, e.captured.id]);
    expect(first.next).toBe(e.captured.seq);
    const second = await events(`?limit=2&before=${first.next}`);
    expect(ids(second)).toEqual([e.claudeTask.id, e.noteRenamed.id]);
    const third = await events(`?limit=2&before=${second.next}`);
    expect(ids(third)).toEqual([e.noteCreated.id]);
    expect(third.next).toBeNull();
  });

  it("names the items the events refer to", async () => {
    const body = await events();
    expect(body.titles).toEqual({
      [`note:${noteId}`]: "Groceries",
      [`task:${e.claudeTask.entity_id}`]: "Buy paint",
      [`capture:${captureId}`]: "Remember the paint",
    });
  });

  it.each([
    ["an unknown actor", "?actor=robot", "actor: actor must be human, claude or system."],
    ["a limit of 0", "?limit=0", "limit: Too small: expected number to be >=1"],
    ["a limit over 200", "?limit=201", "limit: Too big: expected number to be <=200"],
    ["a seq that is not a number", "?before=abc", "before: Invalid input: expected number, received NaN"],
    ["an impossible date", "?from=2026-02-30", "from: A date must be a real date written as YYYY-MM-DD."],
    ["dates the wrong way round", "?from=2026-03-02&to=2026-03-01", "from: The start date must be on or before the end date."],
    ["an unknown kind of item", "?entity_type=widget", "entity_type: That is not a kind of item the planner records."],
    ["an unknown parameter", "?colour=red", 'request: Unrecognized key: "colour"'],
  ])("refuses %s", async (_name, query, message) => {
    expect(await fails(api.get(`/api/events${query}`), 400)).toMatchObject({ code: "invalid_request", message });
  });
});

describe("titles", () => {
  it("names links, labels, people, settings, sign-ins and long captures", async () => {
    const note = await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title: "", body: "Ideas  for\nthe garden", x: 0, y: 0 }));
    const task = (await ok(api.post<MutationResponse<TaskView>>("/api/tasks", { title: "Dig beds" }))).row;
    const link = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: note.row.id }, b: { type: "task", id: task.id } }));
    const label = await ok(api.post<MutationResponse<Label>>("/api/labels", { name: "Garden", colour_hex: "#16a34a" }));
    await ok(api.patch(`/api/users/${USER_2}`, { display_name: "Anna" }));
    await ok(api.put("/api/settings/stt_keyterms", { value: ["Cobus"] }));
    const long = await textCapture(`${"word ".repeat(30)}end`);
    await db
      .prepare(
        "INSERT INTO events (id, ts, actor_kind, actor_user_id, entity_type, entity_id, action) VALUES ('LOGIN1', ?, 'human', ?, 'session', 'S1', 'login')",
      )
      .bind(new Date().toISOString(), USER_1)
      .run();

    const { titles } = await events();
    const excerpt = titles[`capture:${long.id}`] ?? "";
    expect(Array.from(excerpt)).toHaveLength(60);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(titles).toMatchObject({
      [`note:${note.row.id}`]: "Ideas for the garden",
      [`task:${task.id}`]: "Dig beds",
      [`link:${link.row.id}`]: "Link: Ideas for the garden ↔ Dig beds",
      [`label:${label.row.id}`]: "Garden",
      [`user:${USER_2}`]: "Anna",
      "setting:stt_keyterms": "stt_keyterms",
      "session:S1": "Browser sign-in",
    });
  });
});

describe("GET /api/history/:type/:id", () => {
  it("shows an item's events and the events of links that involve it, oldest first", async () => {
    const note = await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title: "Trip", x: 0, y: 0 }));
    const task = (await ok(api.post<MutationResponse<TaskView>>("/api/tasks", { title: "Book flights" }))).row;
    const other = (await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title: "Other", x: 500, y: 0 }))).row;
    const link = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: note.row.id }, b: { type: "task", id: task.id } }));
    const unlink = await ok(api.post<MutationResponse<Link>>(`/api/links/${link.row.id}/unlink`));
    const unrelated = await ok(api.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: other.id }, b: { type: "task", id: task.id } }));
    const capture = await textCapture("Book the flights before the end of the month");
    await mutate(db, SYSTEM_ACTOR, { entity: "capture", action: "update", id: capture.id, patch: { transcript_json: '{"raw":true}' } });
    const runId = await openRun(USER_2);
    const claude = await mutate(db, claudeActor(USER_2, runId), {
      entity: "note",
      action: "update",
      id: note.row.id,
      patch: { body: "Flights first" },
      sourceCaptureIds: [capture.id],
    });

    const history = await ok(api.get<HistoryResponse>(`/api/history/note/${note.row.id}`));
    expect(history.events.map((e) => e.id)).toEqual([
      note.event?.id,
      link.event?.id,
      unlink.event?.id,
      claude.event?.id,
    ]);
    expect(history.runs.map((r) => r.id)).toEqual([runId]);
    expect(history.captures).toHaveLength(1);
    expect(history.captures[0]).toMatchObject({ id: capture.id, text: "Book the flights before the end of the month" });
    expect(history.captures[0]).not.toHaveProperty("transcript_json");
    expect(history.titles).toMatchObject({
      [`note:${note.row.id}`]: "Trip",
      [`link:${link.row.id}`]: "Link: Trip ↔ Book flights",
      [`task:${task.id}`]: "Book flights",
    });
    expect(history.titles).not.toHaveProperty(`link:${unrelated.row.id}`);

    const taskHistory = await ok(api.get<HistoryResponse>(`/api/history/task/${task.id}`));
    expect(taskHistory.events.map((e) => e.entity_type)).toEqual(["task", "link", "link", "link"]);
    expect(taskHistory.events.at(-1)?.id).toBe(unrelated.event?.id);
  });

  it("shows label and capture histories", async () => {
    const label = await ok(api.post<MutationResponse<Label>>("/api/labels", { name: "Home", colour_hex: "#000000" }));
    await ok(api.patch(`/api/labels/${label.row.id}`, { name: "House" }));
    const labelHistory = await ok(api.get<HistoryResponse>(`/api/history/label/${label.row.id}`));
    expect(labelHistory.events.map((e) => e.action)).toEqual(["create", "update"]);
    expect(labelHistory.titles).toEqual({ [`label:${label.row.id}`]: "House" });

    const capture = await textCapture("Fix the gate");
    await mutate(db, human2, { entity: "capture", action: "update", id: capture.id, patch: { text: "Fix the gate latch" } });
    const captureHistory = await ok(api.get<HistoryResponse>(`/api/history/capture/${capture.id}`));
    expect(captureHistory.events.map((e) => [e.action, e.actor_user_id])).toEqual([
      ["create", USER_1],
      ["update", USER_2],
    ]);
    expect(captureHistory.titles[`capture:${capture.id}`]).toBe("Fix the gate latch");
  });

  it("refuses other kinds and unknown items", async () => {
    const error = await fails(api.get("/api/history/link/x"), 400);
    expect(error.message).toBe("request: History is kept for notes, tasks, labels and captures.");
    await fails(api.get("/api/history/note/NO-SUCH-NOTE"), 404);
    await fails(api.get("/api/history/capture/NO-SUCH-CAPTURE"), 404);
  });
});

describe("POST /api/events/:id/revert", () => {
  async function noteWithTitles(...titles: string[]) {
    const created = await mutate(db, human1, { entity: "note", action: "create", values: { title: titles[0] ?? "" } });
    const updates: PlannerEvent[] = [];
    for (const title of titles.slice(1)) {
      updates.push(eventOf(await mutate(db, human2, { entity: "note", action: "update", id: created.id, patch: { title } })));
    }
    return { id: created.id, updates };
  }

  const titleOf = (id: string) => db.prepare("SELECT title FROM notes WHERE id = ?").bind(id).first<string>("title");

  it("writes a compensating event as the signed-in person", async () => {
    const note = await noteWithTitles("A", "B");
    const target = note.updates[0]!;
    const body = await ok(api.post<RevertResponse>(`/api/events/${target.id}/revert`));
    expect(body.reverted).toBe(1);
    expect(body.events).toEqual([
      expect.objectContaining({
        action: "revert",
        reverts_event_id: target.id,
        actor_kind: "human",
        actor_user_id: USER_1,
        before: { title: "B" },
        after: { title: "A" },
      }),
    ]);
    expect(await titleOf(note.id)).toBe("A");
    // Reverting again changes nothing (confirm, because the revert itself is a later change).
    const again = await ok(api.post<RevertResponse>(`/api/events/${target.id}/revert`, { confirm: true }));
    expect(again).toEqual({ reverted: 0, events: [] });
  });

  it("answers 409 when later changes touched the same field, then reverts on confirm", async () => {
    const note = await noteWithTitles("A", "B", "C");
    const [first, second] = note.updates;
    const result = await api.post<{ error: { code: string; details: { conflicts: RevertConflictView[] } } }>(
      `/api/events/${first!.id}/revert`,
      { confirm: false },
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("revert_conflict");
    expect(result.body.error.details.conflicts).toEqual([
      { event_id: first!.id, field: "title", later_event: second },
    ]);
    expect(await titleOf(note.id)).toBe("C");
    const confirmed = await ok(api.post<RevertResponse>(`/api/events/${first!.id}/revert`, { confirm: true }));
    expect(confirmed.reverted).toBe(1);
    expect(await titleOf(note.id)).toBe("A");
  });

  it("archives an item whose creation is reverted", async () => {
    const created = await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title: "Oops", x: 0, y: 0 }));
    const body = await ok(api.post<RevertResponse>(`/api/events/${created.event?.id}/revert`, {}));
    expect(body.events[0]?.after).toHaveProperty("archived_at");
    expect(await db.prepare("SELECT archived_at FROM notes WHERE id = ?").bind(created.row.id).first("archived_at")).not.toBeNull();
  });

  it("refuses unknown events, sign-ins and bad bodies", async () => {
    await fails(api.post("/api/events/NO-SUCH-EVENT/revert"), 404);
    await db
      .prepare(
        "INSERT INTO events (id, ts, actor_kind, actor_user_id, entity_type, entity_id, action) VALUES ('LOGIN1', ?, 'human', ?, 'session', 'S1', 'login')",
      )
      .bind(new Date().toISOString(), USER_1)
      .run();
    expect(await fails(api.post("/api/events/LOGIN1/revert"), 400)).toMatchObject({
      message: "This kind of change cannot be reverted.",
    });
    const note = await noteWithTitles("A", "B");
    await fails(api.post(`/api/events/${note.updates[0]!.id}/revert`, "not json"), 400);
    await fails(api.post(`/api/events/${note.updates[0]!.id}/revert`, { confirm: "yes" }), 400);
    await fails(api.post(`/api/events/${note.updates[0]!.id}/revert`, { force: true }), 400);
    expect(await titleOf(note.id)).toBe("B");
  });
});

describe("runs", () => {
  let runs: { first: string; second: string; third: string };
  let captures: { claimed: string; processed: string; source: string; unrelated: string };

  beforeEach(async () => {
    runs = {
      first: await openRun(USER_1, { startedAt: "2026-03-01T08:00:00.000Z", finished: true }),
      second: await openRun(USER_2, { startedAt: "2026-03-02T08:00:00.000Z" }),
      third: await openRun(USER_1, { startedAt: "2026-03-03T08:00:00.000Z" }),
    };
    captures = {
      claimed: (await textCapture("claimed")).id,
      processed: (await textCapture("processed")).id,
      source: (await textCapture("source")).id,
      unrelated: (await textCapture("unrelated")).id,
    };
    const claude = claudeActor(USER_2, runs.second);
    const when = at("2026-03-02T08:30:00.000Z");
    await mutate(db, claude, { entity: "capture", action: "update", id: captures.claimed, patch: { inbox_status: "claimed", claimed_by_run_id: runs.second, claimed_at: "2026-03-02T08:30:00.000Z" } }, when);
    await mutate(db, claude, { entity: "capture", action: "update", id: captures.processed, patch: { inbox_status: "processed", processed_by_run_id: runs.second, processed_at: "2026-03-02T08:31:00.000Z" } }, when);
    await mutate(db, claude, { entity: "note", action: "create", values: { title: "From a capture" }, sourceCaptureIds: [captures.source, "NOT-A-CAPTURE"] }, when);
  });

  it("lists runs newest first with event counts and captures", async () => {
    const { runs: list } = await ok(api.get<RunsResponse>("/api/runs"));
    expect(list.map((r) => r.id)).toEqual([runs.third, runs.second, runs.first]);
    expect(list[1]).toMatchObject({
      id: runs.second,
      user_id: USER_2,
      event_count: 3,
      capture_ids: [captures.claimed, captures.processed, captures.source].sort(),
    });
    expect(list[0]).toMatchObject({ event_count: 0, capture_ids: [] });
    expect(list[2]?.finished_at).not.toBeNull();
  });

  it("pages by started_at", async () => {
    const page = await ok(api.get<RunsResponse>("/api/runs?limit=1"));
    expect(page.runs.map((r) => r.id)).toEqual([runs.third]);
    const next = await ok(api.get<RunsResponse>(`/api/runs?limit=1&before=${page.runs[0]?.started_at}`));
    expect(next.runs.map((r) => r.id)).toEqual([runs.second]);
    const end = await ok(api.get<RunsResponse>("/api/runs?before=2026-03-01T08:00:00.000Z"));
    expect(end.runs).toEqual([]);
    await fails(api.get("/api/runs?before=yesterday"), 400);
    await fails(api.get("/api/runs?limit=0"), 400);
  });

  it("shows one run with its events, captures and titles", async () => {
    const detail = await ok(api.get<RunDetailResponse>(`/api/runs/${runs.second}`));
    expect(detail.run).toMatchObject({ id: runs.second, event_count: 3 });
    expect(detail.events.map((e) => [e.entity_type, e.action])).toEqual([
      ["capture", "update"],
      ["capture", "update"],
      ["note", "create"],
    ]);
    expect(detail.captures.map((c) => c.id).sort()).toEqual([captures.claimed, captures.processed, captures.source].sort());
    for (const capture of detail.captures) expect(capture).not.toHaveProperty("transcript_json");
    expect(detail.titles).toMatchObject({ [`capture:${captures.claimed}`]: "claimed" });
    expect(Object.values(detail.titles)).toContain("From a capture");
    await fails(api.get("/api/runs/NO-SUCH-RUN"), 404);
  });
});

describe("POST /api/runs/:id/revert", () => {
  it("reverts a whole run, asking for confirmation after human edits", async () => {
    const existing = await mutate(db, human1, { entity: "note", action: "create", values: { title: "Human note" } });
    const runId = await openRun(USER_2);
    const claude = claudeActor(USER_2, runId);
    const created = await mutate(db, claude, { entity: "note", action: "create", values: { title: "Claude note" } });
    await mutate(db, claude, { entity: "note", action: "update", id: existing.id, patch: { body: "Claude added this" } });
    await mutate(db, human2, { entity: "note", action: "update", id: created.id, patch: { title: "Fixed by a person" } });

    const conflict = await fails(api.post(`/api/runs/${runId}/revert`), 409);
    expect(conflict.code).toBe("revert_conflict");
    expect((conflict.details as { conflicts: RevertConflictView[] }).conflicts[0]).toMatchObject({
      event_id: created.event?.id,
      field: "title",
    });

    const body = await ok(api.post<RevertResponse>(`/api/runs/${runId}/revert`, { confirm: true }));
    expect(body.reverted).toBe(2);
    expect(body.events.map((e) => [e.entity_id, e.actor_kind, e.actor_user_id])).toEqual([
      [existing.id, "human", USER_1],
      [created.id, "human", USER_1],
    ]);
    const rows = await db.prepare("SELECT id, body, archived_at FROM notes ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: existing.id, body: "", archived_at: null },
      { id: created.id, body: "", archived_at: expect.any(String) },
    ]);
  });

  it("answers 404 for unknown runs", async () => {
    await fails(api.post("/api/runs/NO-SUCH-RUN/revert"), 404);
  });
});
