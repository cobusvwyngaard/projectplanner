// SPEC 4.1 and 5: every change to board data is an event. After a scripted
// scenario through the API (and Claude writing through mutate, as the MCP
// tools do), replaying each row's events must rebuild the row exactly, and
// every row must have at least one event. If any write had happened without
// an event, the replay would differ from the stored row.

import { beforeEach, describe, expect, it } from "vitest";
import type { MutationResponse, RevertResponse } from "../../src/shared/api";
import type { Label, Link, NoteView, TaskView } from "../../src/shared/types";
import { claudeActor } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { asUser, ok, type TestApi } from "../helpers/api";
import { USER_1, USER_2, allEvents, eventsFor, freshDb, openRun } from "../helpers/db";

const BOARD_TABLES = [
  ["note", "notes"],
  ["task", "tasks"],
  ["link", "links"],
  ["label", "labels"],
] as const;

type Stored = Record<string, unknown>;

let db: D1Database;
let anna: TestApi;
let ben: TestApi;

beforeEach(async () => {
  db = await freshDb();
  anna = asUser(USER_1);
  ben = asUser(USER_2);
});

/** A row's fields as a canonical string, leaving out updated_at (never in event diffs). */
function canonical(row: Stored): string {
  const fields = Object.keys(row)
    .filter((k) => k !== "updated_at")
    .sort()
    .map((k) => [k, row[k] ?? null]);
  return JSON.stringify(fields);
}

/** Rows whose events do not rebuild them, or that have no events at all. */
async function replayProblems(): Promise<string[]> {
  const problems: string[] = [];
  for (const [type, table] of BOARD_TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all<Stored>();
    for (const row of results) {
      const id = String(row.id);
      const [first, ...rest] = await eventsFor(type, id);
      if (!first) {
        problems.push(`${type} ${id} has no events`);
        continue;
      }
      const creation = type === "link" ? "link" : "create";
      if (first.action !== creation || first.before !== null) {
        problems.push(`${type} ${id} starts with ${first.action}, not a creation`);
        continue;
      }
      const replayed: Stored = { ...first.after };
      for (const event of rest) Object.assign(replayed, event.after ?? {});
      if (canonical(replayed) !== canonical(row)) {
        problems.push(`${type} ${id}: replay ${canonical(replayed)} differs from stored ${canonical(row)}`);
      }
    }
  }
  return problems;
}

async function count(table: string): Promise<number> {
  return Number(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"));
}

/** Runs a busy day on the board through the API. */
async function scenario(): Promise<void> {
  // People and labels.
  await ok(anna.patch(`/api/users/${USER_1}`, { display_name: "Anna", initials: "an" }));
  await ok(ben.patch(`/api/users/${USER_2}`, { display_name: "Ben", initials: "B" }));
  const home = (await ok(anna.post<MutationResponse<Label>>("/api/labels", { name: "Home", colour_hex: "#F59E0B" }))).row;
  const work = (await ok(anna.post<MutationResponse<Label>>("/api/labels", { name: "Work", colour_hex: "#2563EB" }))).row;
  const urgent = (await ok(ben.post<MutationResponse<Label>>("/api/labels", { name: "Urgent", colour_hex: "#DC2626" }))).row;
  const renamed = await ok(ben.patch<MutationResponse<Label>>(`/api/labels/${work.id}`, { name: "Office", colour_hex: "#1D4ED8" }));
  await ok(anna.post("/api/labels/reorder", { ids: [urgent.id, home.id, work.id] }));
  await ok(anna.put("/api/settings/default_label_id", { value: home.id }));
  await ok(anna.post(`/api/labels/${urgent.id}/archive`));
  await ok(ben.post(`/api/labels/${urgent.id}/unarchive`));

  // Notes: create, edit, move, resize, archive and bring back.
  const trip = (await ok(anna.post<MutationResponse<NoteView>>("/api/notes", { title: "Trip", body: "Coast in December", label_id: home.id, x: 10, y: 10 }))).row;
  const ideas = (await ok(ben.post<MutationResponse<NoteView>>("/api/notes", { title: "Ideas" }))).row;
  const titleChange = await ok(ben.patch<MutationResponse<NoteView>>(`/api/notes/${trip.id}`, { title: "Trip to the coast" }));
  await ok(anna.patch(`/api/notes/${trip.id}`, { x: 400, y: 120 }));
  await ok(anna.patch(`/api/notes/${ideas.id}`, { w: 320, h: 240, label_id: work.id }));
  await ok(ben.post(`/api/notes/${ideas.id}/archive`));
  await ok(anna.post(`/api/notes/${ideas.id}/unarchive`));

  // Tasks: create, assign, date, place, tick off, reopen, move to the tray, archive.
  const flights = (await ok(anna.post<MutationResponse<TaskView>>("/api/tasks", { title: "Book flights" }))).row;
  const car = (await ok(ben.post<MutationResponse<TaskView>>("/api/tasks", { title: "Hire a car", assignee_id: USER_2, due_date: "2026-11-30", x: 50, y: 300 }))).row;
  const spare = (await ok(ben.post<MutationResponse<TaskView>>("/api/tasks", { title: "Spare task", label_id: urgent.id }))).row;
  await ok(anna.patch(`/api/tasks/${flights.id}`, { assignee_id: USER_1, due_date: "2026-11-15", x: 600, y: 40 }));
  await ok(ben.patch(`/api/tasks/${flights.id}`, { status: "done" }));
  await ok(anna.post(`/api/tasks/${flights.id}/reopen`));
  await ok(ben.post(`/api/tasks/${car.id}/complete`));
  await ok(anna.patch(`/api/tasks/${car.id}`, { x: null, y: null, detail: "Automatic, please" }));
  await ok(anna.post(`/api/tasks/${spare.id}/archive`));

  // Links: link, unlink, link the same pair again.
  const tripFlights = (await ok(anna.post<MutationResponse<Link>>("/api/links", { a: { type: "task", id: flights.id }, b: { type: "note", id: trip.id } }))).row;
  const tripIdeas = (await ok(ben.post<MutationResponse<Link>>("/api/links", { a: { type: "note", id: trip.id }, b: { type: "note", id: ideas.id } }))).row;
  await ok(anna.post<MutationResponse<Link>>("/api/links", { a: { type: "task", id: flights.id }, b: { type: "task", id: car.id } }));
  const unlinked = await ok(ben.post<MutationResponse<Link>>(`/api/links/${tripIdeas.id}/unlink`));
  await ok(anna.post("/api/links", { a: { type: "note", id: ideas.id }, b: { type: "note", id: trip.id } }));
  await ok(ben.post(`/api/links/${tripFlights.id}/unlink`));

  // Claude, in Ben's account, organises a capture.
  const runId = await openRun(USER_2);
  const claude = claudeActor(USER_2, runId);
  const fromClaude = await mutate(db, claude, { entity: "note", action: "create", values: { title: "Packing list", body: "Hats, sunscreen" } });
  await mutate(db, claude, { entity: "task", action: "update", id: flights.id, patch: { title: "Book flights to George" } });
  await mutate(db, claude, { entity: "link", action: "link", a: { type: "note", id: fromClaude.id }, b: { type: "task", id: car.id } });
  await mutate(db, claude, { entity: "task", action: "complete", id: flights.id });
  // A person edits Claude's note before anyone reverts the run.
  await ok(anna.patch(`/api/notes/${fromClaude.id}`, { body: "Hats, sunscreen, towels" }));

  // Reverts: single events (a title change, an unlink, a label rename) and Claude's whole run.
  await ok(anna.post<RevertResponse>(`/api/events/${titleChange.event?.id}/revert`, { confirm: true }));
  await ok(anna.post<RevertResponse>(`/api/events/${unlinked.event?.id}/revert`, { confirm: true }));
  await ok(ben.post<RevertResponse>(`/api/events/${renamed.event?.id}/revert`));
  const run = await ok(anna.post<RevertResponse>(`/api/runs/${runId}/revert`, { confirm: true }));
  expect(run.reverted).toBe(4);

  // Archiving the default label clears the setting in the same transaction.
  await ok(anna.post(`/api/labels/${home.id}/archive`));
}

describe("event log invariant", () => {
  it("rebuilds every note, task, link and label from its events after a busy scenario", async () => {
    await scenario();
    expect(await count("notes")).toBe(3);
    expect(await count("tasks")).toBe(3);
    expect(await count("links")).toBe(4);
    expect(await count("labels")).toBe(3);
    expect(await replayProblems()).toEqual([]);

    // Every event of these tables points at a row that exists.
    for (const event of await allEvents()) {
      const table = BOARD_TABLES.find(([type]) => type === event.entity_type)?.[1];
      if (!table) continue;
      const exists = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(event.entity_id).first();
      expect(exists, `${event.entity_type} ${event.entity_id}`).not.toBeNull();
    }
  });

  it("notices a write that bypassed mutate", async () => {
    await scenario();
    const { id } = (await db.prepare("SELECT id FROM tasks ORDER BY id LIMIT 1").first<{ id: string }>()) ?? { id: "" };
    await db.prepare("UPDATE tasks SET detail = 'changed behind the log' WHERE id = ?").bind(id).run();
    await db
      .prepare("INSERT INTO labels (id, name, colour_hex, created_at) VALUES ('ROGUE', 'Rogue', '#000000', '2026-01-01T00:00:00.000Z')")
      .run();
    const problems = await replayProblems();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(new RegExp(`^task ${id}: replay`));
    expect(problems[1]).toBe("label ROGUE has no events");
  });
});
