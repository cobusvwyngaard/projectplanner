import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../src/shared/api";
import type { NoteView, TaskView } from "../../src/shared/types";
import { noteViews, provenanceFor } from "../../src/worker/board/provenance";
import { getRow, rowsByIds } from "../../src/worker/board/queries";
import { claudeActor, humanActor } from "../../src/worker/mutate/actor";
import { mutate, mutateMany, type Mutation } from "../../src/worker/mutate/index";
import { revertEvent } from "../../src/worker/mutate/revert";
import { asUser, ok } from "../helpers/api";
import { USER_1, USER_2, freshDb, openRun } from "../helpers/db";

let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

describe("provenance badges", () => {
  it("show a person as creator and Claude (via the other person) as the last change", async () => {
    const api = asUser(USER_1);
    const note = await ok(api.post<MutationResponse<NoteView>>("/api/notes", { title: "Trip", x: 0, y: 0 }));
    const task = await ok(api.post<MutationResponse<TaskView>>("/api/tasks", { title: "Book flights" }));
    const { cursor } = await ok(api.get<BootstrapResponse>("/api/bootstrap"));

    const runId = await openRun(USER_2);
    const claude = claudeActor(USER_2, runId);
    const changedNote = await mutate(db, claude, { entity: "note", action: "update", id: note.row.id, patch: { body: "Window seats" } });
    const changedTask = await mutate(db, claude, { entity: "task", action: "complete", id: task.row.id });

    const board = await ok(api.get<BootstrapResponse>("/api/bootstrap"));
    expect(board.notes[0]?.prov).toEqual({
      created_by: { kind: "human", user_id: USER_1 },
      created_at: note.event?.ts,
      changed_by: { kind: "claude", user_id: USER_2 },
      changed_at: changedNote.event?.ts,
    });
    expect(board.tasks[0]?.prov).toEqual({
      created_by: { kind: "human", user_id: USER_1 },
      created_at: task.event?.ts,
      changed_by: { kind: "claude", user_id: USER_2 },
      changed_at: changedTask.event?.ts,
    });
    // Claude ticked it off on behalf of the person whose account it runs in.
    expect(board.tasks[0]?.done_by_user_id).toBe(USER_2);

    // The change feed carries the same badges.
    const feed = await ok(api.get<ChangesResponse>(`/api/changes?since=${cursor}`));
    expect(feed.notes[0]?.prov?.changed_by).toEqual({ kind: "claude", user_id: USER_2 });
    expect(feed.tasks[0]?.prov?.changed_by).toEqual({ kind: "claude", user_id: USER_2 });

    // A person changing it afterwards takes the "last changed" badge back.
    const fixed = await ok(asUser(USER_2).patch<MutationResponse<NoteView>>(`/api/notes/${note.row.id}`, { title: "Holiday" }));
    expect(fixed.row.prov).toMatchObject({
      created_by: { kind: "human", user_id: USER_1 },
      changed_by: { kind: "human", user_id: USER_2 },
    });
  });

  it("show Claude as creator of what it made, and a revert as the last change", async () => {
    const runId = await openRun(USER_1);
    const created = await mutate(db, claudeActor(USER_1, runId), { entity: "note", action: "create", values: { title: "Idea" } });
    const prov = (await provenanceFor(db, "note", [created.id])).get(created.id);
    expect(prov).toEqual({
      created_by: { kind: "claude", user_id: USER_1 },
      created_at: created.event?.ts,
      changed_by: { kind: "claude", user_id: USER_1 },
      changed_at: created.event?.ts,
    });
    const undo = await revertEvent(db, humanActor(USER_2), String(created.event?.id));
    const after = (await provenanceFor(db, "note", [created.id])).get(created.id);
    expect(after?.changed_by).toEqual({ kind: "human", user_id: USER_2 });
    expect(after?.changed_at).toBe(undo.results[0]?.event?.ts);
  });

  it("works across many items, past D1's bound-parameter limit", async () => {
    const mutations: Mutation[] = Array.from({ length: 230 }, (_, i) => ({
      entity: "note",
      action: "create",
      values: { title: `Note ${i}` },
    }));
    const created = [
      ...(await mutateMany(db, humanActor(USER_1), mutations.slice(0, 115))),
      ...(await mutateMany(db, humanActor(USER_2), mutations.slice(115))),
    ];
    const ids = created.map((r) => r.id);
    const prov = await provenanceFor(db, "note", ids);
    expect(prov.size).toBe(230);
    expect(prov.get(ids[0]!)?.created_by.user_id).toBe(USER_1);
    expect(prov.get(ids[229]!)?.created_by.user_id).toBe(USER_2);

    const notes = await rowsByIds(db, "note", ids);
    expect(notes).toHaveLength(230);
    const views = await noteViews(db, notes);
    expect(views.every((v) => v.prov !== null)).toBe(true);
  });

  it("keep notes and tasks apart and are null for rows without events", async () => {
    const note = await mutate(db, humanActor(USER_1), { entity: "note", action: "create", values: { title: "x" } });
    expect((await provenanceFor(db, "task", [note.id])).size).toBe(0);
    // A row written behind mutate()'s back has no events and so no badge.
    await db
      .prepare("INSERT INTO notes (id, title, created_at, updated_at) VALUES ('ROGUE', 'no events', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    const rogue = await getRow(db, "note", "ROGUE");
    expect(rogue).not.toBeNull();
    const [view] = await noteViews(db, [rogue!]);
    expect(view?.prov).toBeNull();
    expect(await provenanceFor(db, "note", [])).toEqual(new Map());
  });
});
