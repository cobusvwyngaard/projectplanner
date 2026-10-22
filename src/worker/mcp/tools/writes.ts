// Write tools for the Claude connector (SPEC section 7). Plain functions over
// ToolContext, so they are testable without MCP; agent.ts registers them.
// Every write goes through mutate()/mutateMany() with the claude actor, so
// the run guard (open, this user's, under 2 hours) and the guardrails of
// SPEC section 5 (no archive, no labels/settings/users) apply.

import type { ItemRef } from "../../../shared/types";
import { isLocalDate } from "../../../shared/dates";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { checkAssigneeId, checkLabelId } from "../../board/validation";
import { DEFAULT_NOTE_SIZE, placeNote } from "../../board/placement";
import { getRow } from "../../board/queries";
import { defaultLabelId } from "../../settings";
import { claudeActor } from "../../mutate/actor";
import { findLink, mutate, mutateMany, type Mutation } from "../../mutate/index";
import { ulid } from "../../lib/ulid";
import { iso } from "../../lib/time";
import { parseEmailParticipants } from "./read";
import type { ToolContext } from "../runs";

const DATE_ERROR = "A date must be a real date written as YYYY-MM-DD.";

function toRow(values: Readonly<Record<string, unknown>>): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined) row[field] = value as string | number | null;
  }
  return row;
}

/** Every source capture id must exist. */
async function checkSourceCaptures(db: D1Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT id FROM captures WHERE id IN (${marks})`)
    .bind(...ids)
    .all<{ id: string }>();
  const found = new Set(results.map((r) => r.id));
  const bad = ids.filter((id) => !found.has(id));
  if (bad.length > 0) {
    throw new ValidationError(`These captures do not exist: ${bad.join(", ")}.`, { ids: bad });
  }
}

/** The open row an id names, or an error. */
async function requireOpen<K extends "note" | "task">(db: D1Database, type: K, id: string): Promise<void> {
  const row = await getRow(db, type, id);
  if (!row || row.archived_at !== null) throw new NotFoundError(`No open ${type} with id ${id}.`);
}

const NOT_ON_EMAIL = "That person is not on the source email; leave the task unassigned.";

/**
 * When every source capture is an email and someone is being assigned, the
 * assignee must be a participant of at least one of those emails (SPEC 11.4).
 * The email's text cannot steer a task to a person who was not on the message.
 */
async function checkEmailAssignee(
  db: D1Database,
  assigneeId: string | null,
  sourceIds: readonly string[],
): Promise<void> {
  if (assigneeId === null || sourceIds.length === 0) return;
  const marks = sourceIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT kind, email_participants_json FROM captures WHERE id IN (${marks})`)
    .bind(...sourceIds)
    .all<{ kind: string; email_participants_json: string | null }>();
  if (results.some((c) => c.kind !== "email")) return;
  const onSomeEmail = results.some((c) =>
    parseEmailParticipants(c.email_participants_json).some((p) => p.user_id === assigneeId),
  );
  if (!onSomeEmail) throw new ValidationError(NOT_ON_EMAIL);
}

export async function createNote(
  ctx: ToolContext,
  input: { run_id: string; title: string; body?: string; label_id?: string | null; source_capture_ids: string[] },
): Promise<{ id: string }> {
  const { db, userId, now } = ctx;
  await checkLabelId(db, input.label_id ?? null);
  await checkSourceCaptures(db, input.source_capture_ids);
  const labelId = input.label_id === undefined ? await defaultLabelId(db) : (input.label_id ?? null);
  const size = DEFAULT_NOTE_SIZE;
  const spot = await placeNote(db, size);
  const result = await mutate(
    db,
    claudeActor(userId, input.run_id),
    {
      entity: "note",
      action: "create",
      values: toRow({ title: input.title, body: input.body ?? "", label_id: labelId, x: spot.x, y: spot.y, w: size.w, h: size.h }),
      sourceCaptureIds: input.source_capture_ids,
    },
    { now },
  );
  return { id: result.id };
}

export async function updateNote(
  ctx: ToolContext,
  input: {
    run_id: string;
    id: string;
    patch: { title?: string; body?: string; label_id?: string | null };
    source_capture_ids: string[];
  },
): Promise<{ id: string }> {
  const { db, userId, now } = ctx;
  const note = await getRow(db, "note", input.id);
  if (!note || note.archived_at !== null) throw new NotFoundError("No open note with that id.");
  if (Object.keys(input.patch).length === 0) throw new ValidationError("The patch must not be empty.");
  await checkLabelId(db, input.patch.label_id, note.label_id);
  await checkSourceCaptures(db, input.source_capture_ids);
  const result = await mutate(
    db,
    claudeActor(userId, input.run_id),
    {
      entity: "note",
      action: "update",
      id: input.id,
      patch: toRow(input.patch),
      sourceCaptureIds: input.source_capture_ids,
    },
    { now },
  );
  return { id: result.id };
}

export async function createTask(
  ctx: ToolContext,
  input: {
    run_id: string;
    title: string;
    detail?: string;
    assignee_id?: string | null;
    due_date?: string | null;
    label_id?: string | null;
    link_to?: ItemRef[];
    source_capture_ids: string[];
  },
): Promise<{ id: string; linked: string[] }> {
  const { db, userId, now } = ctx;
  await checkAssigneeId(db, input.assignee_id);
  await checkLabelId(db, input.label_id ?? null);
  if (input.due_date !== undefined && input.due_date !== null && !isLocalDate(input.due_date)) {
    throw new ValidationError(DATE_ERROR, { field: "due_date" });
  }
  await checkSourceCaptures(db, input.source_capture_ids);
  await checkEmailAssignee(db, input.assignee_id ?? null, input.source_capture_ids);
  const labelId = input.label_id === undefined ? await defaultLabelId(db) : (input.label_id ?? null);
  const links = input.link_to ?? [];
  for (const ref of links) await requireOpen(db, ref.type, ref.id);
  // The id is made here so the task and its links commit in one mutateMany.
  const taskId = ulid(now.getTime());
  const mutations: Mutation[] = [
    {
      entity: "task",
      action: "create",
      id: taskId,
      values: toRow({
        title: input.title,
        detail: input.detail ?? "",
        label_id: labelId,
        assignee_id: input.assignee_id ?? null,
        due_date: input.due_date ?? null,
        status: "open",
        x: null,
        y: null,
      }),
      sourceCaptureIds: input.source_capture_ids,
    },
  ];
  for (const ref of links) {
    mutations.push({
      entity: "link",
      action: "link",
      a: { type: "task", id: taskId },
      b: ref,
      sourceCaptureIds: input.source_capture_ids,
    });
  }
  await mutateMany(db, claudeActor(userId, input.run_id), mutations, { now });
  return { id: taskId, linked: links.map((ref) => ref.id) };
}

export async function updateTask(
  ctx: ToolContext,
  input: {
    run_id: string;
    id: string;
    patch: {
      title?: string;
      detail?: string;
      label_id?: string | null;
      assignee_id?: string | null;
      due_date?: string | null;
      status?: "open" | "done";
    };
    source_capture_ids: string[];
  },
): Promise<{ id: string; warnings?: string[] }> {
  const { db, userId, now } = ctx;
  const task = await getRow(db, "task", input.id);
  if (!task || task.archived_at !== null) throw new NotFoundError("No open task with that id.");
  if (Object.keys(input.patch).length === 0) throw new ValidationError("The patch must not be empty.");
  if (input.patch.assignee_id !== undefined && input.patch.assignee_id !== null) {
    await checkAssigneeId(db, input.patch.assignee_id);
  }
  if (input.patch.label_id !== undefined && input.patch.label_id !== null) {
    await checkLabelId(db, input.patch.label_id, task.label_id);
  }
  if (input.patch.due_date !== undefined && input.patch.due_date !== null && !isLocalDate(input.patch.due_date)) {
    throw new ValidationError(DATE_ERROR, { field: "due_date" });
  }
  await checkSourceCaptures(db, input.source_capture_ids);
  await checkEmailAssignee(db, input.patch.assignee_id ?? null, input.source_capture_ids);
  const result = await mutate(
    db,
    claudeActor(userId, input.run_id),
    {
      entity: "task",
      action: "update",
      id: input.id,
      patch: toRow(input.patch),
      sourceCaptureIds: input.source_capture_ids,
    },
    { now },
  );
  // Ticking a task off is never refused, but the person is told what it still
  // waits for.
  return result.warnings.length > 0 ? { id: result.id, warnings: result.warnings } : { id: result.id };
}

export async function linkItems(
  ctx: ToolContext,
  input: {
    run_id: string;
    a: ItemRef;
    b: ItemRef;
    /** "related" for a plain connection, "depends" when a must be done before b */
    kind?: "related" | "depends";
    source_capture_ids?: string[];
  },
): Promise<{ ok: true }> {
  const { db, userId, now } = ctx;
  for (const ref of [input.a, input.b]) await requireOpen(db, ref.type, ref.id);
  await checkSourceCaptures(db, input.source_capture_ids ?? []);
  const sourceCaptureIds = input.source_capture_ids ?? [];
  await mutate(
    db,
    claudeActor(userId, input.run_id),
    input.kind === "depends"
      ? { entity: "link", action: "link", depends: { before: input.a, after: input.b }, sourceCaptureIds }
      : { entity: "link", action: "link", a: input.a, b: input.b, sourceCaptureIds },
    { now },
  );
  return { ok: true };
}

export async function unlinkItems(
  ctx: ToolContext,
  input: { run_id: string; a: ItemRef; b: ItemRef; source_capture_ids?: string[] },
): Promise<{ ok: true }> {
  const { db, userId, now } = ctx;
  for (const ref of [input.a, input.b]) await requireOpen(db, ref.type, ref.id);
  await checkSourceCaptures(db, input.source_capture_ids ?? []);
  const existing = await findLink(db, input.a, input.b);
  if (!existing || existing.archived_at !== null) throw new NotFoundError("Those items are not linked.");
  await mutate(
    db,
    claudeActor(userId, input.run_id),
    {
      entity: "link",
      action: "unlink",
      id: String(existing.id),
      sourceCaptureIds: input.source_capture_ids ?? [],
    },
    { now },
  );
  return { ok: true };
}

export async function markCaptures(
  ctx: ToolContext,
  input: {
    run_id: string;
    capture_ids: string[];
    status: "processed" | "ignored";
    note: string;
    source_capture_ids: string[];
  },
): Promise<{ marked: string[] }> {
  const { db, userId, now } = ctx;
  const ids = input.capture_ids;
  const captures = (
    await db
      .prepare(`SELECT id, claimed_by_run_id FROM captures WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids)
      .all<{ id: string; claimed_by_run_id: string | null }>()
  ).results;
  const byId = new Map(captures.map((c) => [c.id, c]));
  const bad = ids.filter((id) => byId.get(id)?.claimed_by_run_id !== input.run_id);
  if (bad.length > 0) {
    throw new ValidationError(`These captures are not claimed by this run: ${bad.join(", ")}.`, { ids: bad });
  }
  await checkSourceCaptures(db, input.source_capture_ids);
  const ts = iso(now);
  const ops: Mutation[] = ids.map((id) => ({
    entity: "capture",
    action: "update",
    id,
    patch: {
      inbox_status: input.status,
      processed_by_run_id: input.run_id,
      processed_at: ts,
      processing_note: input.note,
      claimed_by_run_id: null,
      claimed_at: null,
    },
    expect: { claimed_by_run_id: input.run_id },
    sourceCaptureIds: input.source_capture_ids,
  }));
  await mutateMany(db, claudeActor(userId, input.run_id), ops, { now });
  return { marked: [...ids] };
}
