// The app's view of the planner and the pure functions that change it. The
// store (src/app/store.ts) holds one PlannerState and swaps it for the result
// of these functions, so components can compare collections by identity.

import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../shared/api";
import { addDays, daysBetween } from "../../shared/dates";
import type { Id, Label, Link, LocalDate, NoteView, SettingsMap, TaskView, User } from "../../shared/types";

export interface RowTypes {
  note: NoteView;
  task: TaskView;
  link: Link;
  label: Label;
  user: User;
}
export type RowKind = keyof RowTypes;

export interface PlannerState {
  me: User;
  users: ReadonlyMap<Id, User>;
  /** Every label, archived ones included, so items keep their colour */
  labels: ReadonlyMap<Id, Label>;
  /** Notes, tasks and links that are not archived */
  notes: ReadonlyMap<Id, NoteView>;
  tasks: ReadonlyMap<Id, TaskView>;
  links: ReadonlyMap<Id, Link>;
  settings: SettingsMap;
  /** Newest event seen through bootstrap or the change feed */
  cursor: Id | null;
  /** Today in Africa/Johannesburg */
  today: LocalDate;
  /** Highest event seq applied to a row ("task:<id>") by this browser's own changes */
  seen: ReadonlyMap<string, number>;
  /** Rows with a change of ours still in flight; the change feed leaves them alone */
  pending: ReadonlyMap<string, number>;
}

export function rowKey(kind: RowKind, id: Id): string {
  return `${kind}:${id}`;
}

function byId<T extends { id: Id }>(rows: readonly T[]): Map<Id, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function fromBootstrap(boot: BootstrapResponse): PlannerState {
  return {
    me: boot.me,
    users: byId(boot.users),
    labels: byId(boot.labels),
    notes: byId(boot.notes.filter((n) => n.archived_at === null)),
    tasks: byId(boot.tasks.filter((t) => t.archived_at === null)),
    links: byId(boot.links.filter((l) => l.archived_at === null)),
    settings: boot.settings,
    cursor: boot.cursor,
    today: boot.today,
    seen: new Map(),
    pending: new Map(),
  };
}

/** A row together with its kind, so a switch on the kind narrows the row. */
type KindedRow = { [K in RowKind]: { kind: K; row: RowTypes[K] } }[RowKind];

/** The map with the row put in (or taken out); the same map when nothing changes. */
function replaced<T extends { id: Id }>(map: ReadonlyMap<Id, T>, row: T, remove: boolean): ReadonlyMap<Id, T> {
  if (remove ? !map.has(row.id) : map.get(row.id) === row) return map;
  const next = new Map(map);
  if (remove) next.delete(row.id);
  else next.set(row.id, row);
  return next;
}

/**
 * Put the current version of a row into the state. Archived notes, tasks and
 * links are removed; labels stay (with archived_at set); a change to the
 * signed-in person also updates `me`.
 */
export function putRow<K extends RowKind>(state: PlannerState, kind: K, row: RowTypes[K]): PlannerState {
  const item = { kind, row } as KindedRow;
  switch (item.kind) {
    case "note": {
      const notes = replaced(state.notes, item.row, item.row.archived_at !== null);
      return notes === state.notes ? state : { ...state, notes };
    }
    case "task": {
      const tasks = replaced(state.tasks, item.row, item.row.archived_at !== null);
      return tasks === state.tasks ? state : { ...state, tasks };
    }
    case "link": {
      const links = replaced(state.links, item.row, item.row.archived_at !== null);
      return links === state.links ? state : { ...state, links };
    }
    case "label": {
      const labels = replaced(state.labels, item.row, false);
      return labels === state.labels ? state : { ...state, labels };
    }
    case "user": {
      const users = replaced(state.users, item.row, false);
      if (users === state.users) return state;
      return { ...state, users, me: item.row.id === state.me.id ? item.row : state.me };
    }
  }
}

/** Apply the result of one of our own changes. */
export function applyMutation<K extends RowKind>(
  state: PlannerState,
  kind: K,
  response: MutationResponse<RowTypes[K]>,
): PlannerState {
  const next = putRow(state, kind, response.row);
  if (!response.event) return next;
  const key = rowKey(kind, response.row.id);
  if ((next.seen.get(key) ?? 0) >= response.event.seq) return next;
  const seen = new Map(next.seen);
  seen.set(key, response.event.seq);
  return { ...next, seen };
}

/** Count a change of ours to a row as started (+1) or finished (-1). */
export function markPending(state: PlannerState, key: string, delta: 1 | -1): PlannerState {
  const pending = new Map(state.pending);
  const count = (pending.get(key) ?? 0) + delta;
  if (count > 0) pending.set(key, count);
  else pending.delete(key);
  return { ...state, pending };
}

/**
 * Apply a /api/changes result. A row is skipped while a change of ours to it
 * is in flight, or when our own change already gave it a newer state than
 * these events reach (the poll was answered before our change committed).
 */
export function applyChanges(state: PlannerState, changes: ChangesResponse): PlannerState {
  const reach = changes.events.reduce((max, e) => Math.max(max, e.seq), 0);
  let next: PlannerState = { ...state, cursor: changes.cursor };
  const seen = new Map(state.seen);
  const apply = <K extends RowKind>(kind: K, rows: readonly RowTypes[K][]) => {
    for (const row of rows) {
      const key = rowKey(kind, row.id);
      if (state.pending.has(key)) continue;
      const ours = seen.get(key);
      if (ours !== undefined && ours > reach) continue;
      seen.delete(key);
      next = putRow(next, kind, row);
    }
  };
  apply("user", changes.users);
  apply("label", changes.labels);
  apply("note", changes.notes);
  apply("task", changes.tasks);
  apply("link", changes.links);
  if (changes.settings) next.settings = changes.settings;
  next.seen = seen;
  return next;
}

/**
 * Today, moved on by however many local days have passed since bootstrap.
 * The server's date stays the reference; the browser's clock only counts
 * the days that went by.
 */
export function rolledToday(serverToday: LocalDate, localAtBoot: LocalDate, localNow: LocalDate): LocalDate {
  const passed = daysBetween(localAtBoot, localNow);
  return passed > 0 ? addDays(serverToday, passed) : serverToday;
}
