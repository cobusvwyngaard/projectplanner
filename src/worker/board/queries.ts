// Shared readers for board data. The app API and the MCP tools read rows
// through these so every caller sees the same columns and order.
//
// Writes never happen here: they go through src/worker/mutate.

import type { Capture, Id, Label, Link, Note, PlannerEvent, Run, Task, User } from "../../shared/types";
import { ENTITIES } from "../mutate/entities";
import { EVENT_COLUMNS, parseEventRow, type EventRow } from "../mutate/events";

/** D1 allows at most 100 bound parameters per statement; stay well under it. */
export const MAX_PARAMS = 90;

/** Rows by kind, as the API sends them. */
export interface RowTypes {
  note: Note;
  task: Task;
  link: Link;
  label: Label;
  user: User;
  capture: Capture;
  run: Run;
}

export type RowKind = keyof RowTypes;

const visibleColumns = (entity: keyof typeof ENTITIES): string =>
  ENTITIES[entity].columns.filter((c) => !ENTITIES[entity].hidden.includes(c)).join(", ");

/** Table, selected columns and list order of each kind. captures.transcript_json is never selected. */
const TABLES: Readonly<Record<RowKind, { table: string; columns: string; order: string }>> = {
  note: { table: "notes", columns: visibleColumns("note"), order: "id" },
  task: { table: "tasks", columns: visibleColumns("task"), order: "id" },
  link: { table: "links", columns: visibleColumns("link"), order: "id" },
  label: { table: "labels", columns: visibleColumns("label"), order: "sort_order, created_at, id" },
  user: { table: "users", columns: visibleColumns("user"), order: "id" },
  capture: { table: "captures", columns: visibleColumns("capture"), order: "id" },
  run: { table: "runs", columns: "id, user_id, intent, summary, started_at, finished_at", order: "started_at, id" },
};

/** "?, ?, ?" for n parameters. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Split a list into pieces of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run one statement per chunk of distinct ids, all in a single round trip,
 * and concatenate the rows. `perChunk` is how many ids one statement may
 * bind, so a statement that repeats the id list binds fewer per chunk.
 */
export async function selectInChunks<T>(
  db: D1Database,
  ids: Iterable<string>,
  statement: (ids: string[], marks: string) => D1PreparedStatement,
  perChunk: number = MAX_PARAMS,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const statements = chunk(unique, perChunk).map((part) => statement(part, placeholders(part.length)));
  const results = await db.batch<T>(statements);
  return results.flatMap((r) => r.results);
}

/** One row by id, or null. */
export async function getRow<K extends RowKind>(db: D1Database, kind: K, id: Id): Promise<RowTypes[K] | null> {
  const t = TABLES[kind];
  return db.prepare(`SELECT ${t.columns} FROM ${t.table} WHERE id = ?`).bind(id).first<RowTypes[K]>();
}

/** Rows with the given ids (missing ids are skipped), in list order. */
export async function rowsByIds<K extends RowKind>(
  db: D1Database,
  kind: K,
  ids: Iterable<Id>,
): Promise<RowTypes[K][]> {
  const t = TABLES[kind];
  return selectInChunks<RowTypes[K]>(db, ids, (part, marks) =>
    db.prepare(`SELECT ${t.columns} FROM ${t.table} WHERE id IN (${marks}) ORDER BY ${t.order}`).bind(...part),
  );
}

async function list<K extends RowKind>(db: D1Database, kind: K, where: string): Promise<RowTypes[K][]> {
  const t = TABLES[kind];
  const { results } = await db
    .prepare(`SELECT ${t.columns} FROM ${t.table} ${where} ORDER BY ${t.order}`)
    .all<RowTypes[K]>();
  return results;
}

/** Both users. */
export function listUsers(db: D1Database): Promise<User[]> {
  return list(db, "user", "");
}

/** Every label, archived ones included, in the order people arranged them. */
export function listLabels(db: D1Database): Promise<Label[]> {
  return list(db, "label", "");
}

/** Labels that are not archived, in order. */
export function activeLabels(db: D1Database): Promise<Label[]> {
  return list(db, "label", "WHERE archived_at IS NULL");
}

/** Notes that are not archived. */
export function openNotes(db: D1Database): Promise<Note[]> {
  return list(db, "note", "WHERE archived_at IS NULL");
}

/** Tasks that are not archived, open and done. */
export function openTasks(db: D1Database): Promise<Task[]> {
  return list(db, "task", "WHERE archived_at IS NULL");
}

/** Links that are not archived. */
export function activeLinks(db: D1Database): Promise<Link[]> {
  return list(db, "link", "WHERE archived_at IS NULL");
}

/** Id and seq of the newest event, or null when nothing has happened yet. */
export async function newestEvent(db: D1Database): Promise<{ id: Id; seq: number } | null> {
  return db.prepare(`SELECT id, seq FROM events ORDER BY seq DESC LIMIT 1`).first<{ id: Id; seq: number }>();
}

/** Run a SELECT over events and parse the rows. */
export async function selectEvents(statement: D1PreparedStatement): Promise<PlannerEvent[]> {
  const { results } = await statement.all<EventRow>();
  return results.map(parseEventRow);
}

/** Events of one Claude run, oldest first. */
export function runEvents(db: D1Database, runId: Id): Promise<PlannerEvent[]> {
  return selectEvents(db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE run_id = ? ORDER BY seq`).bind(runId));
}

/** The distinct capture ids that events name as their sources. */
export function sourceCaptureIds(events: readonly PlannerEvent[]): Id[] {
  return [...new Set(events.flatMap((e) => e.source_capture_ids ?? []))];
}

/** The distinct run ids of events. */
export function eventRunIds(events: readonly PlannerEvent[]): Id[] {
  return [...new Set(events.flatMap((e) => (e.run_id === null ? [] : [e.run_id])))];
}
