// The app's view of the planner and the pure functions that change it. The
// store (src/app/store.ts) holds one PlannerState and swaps it for the result
// of these functions, so components can compare collections by identity.

import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../shared/api";
import { addDays, daysBetween } from "../../shared/dates";
import type { Capture, Id, Label, Link, LocalDate, NoteView, SettingsMap, TaskView, User } from "../../shared/types";

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
  captures: ReadonlyMap<Id, Capture>;
  settings: SettingsMap;
  /** Newest event seen through bootstrap or the change feed */
  cursor: Id | null;
  /** Today in Africa/Johannesburg */
  today: LocalDate;
  /** Highest event seq applied to a row ("task:<id>") by this browser's own changes */
  seen: ReadonlyMap<string, number>;
  /** Rows with a change of ours still in flight; the change feed leaves them alone */
  pending: ReadonlyMap<string, number>;
  /** The newest row the change feed brought for a pending key, applied once the change settles */
  held: ReadonlyMap<string, HeldRow>;
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
    captures: new Map(),
    settings: boot.settings,
    cursor: boot.cursor,
    today: boot.today,
    seen: new Map(),
    pending: new Map(),
    held: new Map(),
  };
}

/** A row together with its kind, so a switch on the kind narrows the row. */
type KindedRow = { [K in RowKind]: { kind: K; row: RowTypes[K] } }[RowKind];

/** A row the change feed skipped, with the highest event seq of its poll. */
export type HeldRow = KindedRow & { reach: number };

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

/**
 * Apply the result of one of our own changes. A row that another change of
 * ours already moved past (a higher seq) is left as it is.
 */
export function applyMutation<K extends RowKind>(
  state: PlannerState,
  kind: K,
  response: MutationResponse<RowTypes[K]>,
): PlannerState {
  const key = rowKey(kind, response.row.id);
  if (response.event && (state.seen.get(key) ?? 0) > response.event.seq) return state;
  const next = putRow(state, kind, response.row);
  if (!response.event) return next;
  if ((next.seen.get(key) ?? 0) >= response.event.seq) return next;
  const seen = new Map(next.seen);
  seen.set(key, response.event.seq);
  return { ...next, seen };
}

/**
 * Finish a change of ours to a row: apply `response` when it succeeded, or
 * put `restore` back when it failed (the row as it was, if the change showed
 * early). Once no change of ours to the row is in flight, a row the change
 * feed held back meanwhile takes over unless our own change committed after
 * that poll: it is the newest state the server has shown, and later polls
 * start past it.
 */
export function settleChange<K extends RowKind>(
  state: PlannerState,
  kind: K,
  id: Id,
  response: MutationResponse<RowTypes[K]> | null,
  restore: RowTypes[K] | undefined,
): PlannerState {
  const key = rowKey(kind, id);
  let next = markPending(state, key, -1);
  if (response) next = applyMutation(next, kind, response);
  else if (restore) next = putRow(next, kind, restore);
  const held = next.held.get(key);
  if (!held || next.pending.has(key)) return next;
  const rest = new Map(next.held);
  rest.delete(key);
  next = { ...next, held: rest };
  if ((next.seen.get(key) ?? 0) > held.reach) return next;
  const seen = new Map(next.seen);
  seen.delete(key);
  return putRow({ ...next, seen }, held.kind, held.row);
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
 * is in flight (and held until that change settles, see settleChange), or
 * when our own change already gave it a newer state than these events reach
 * (the poll was answered before our change committed).
 */
export function applyChanges(state: PlannerState, changes: ChangesResponse): PlannerState {
  const reach = changes.events.reduce((max, e) => Math.max(max, e.seq), 0);
  let next: PlannerState = { ...state, cursor: changes.cursor };
  const seen = new Map(state.seen);
  const held = new Map(state.held);
  const apply = <K extends RowKind>(kind: K, rows: readonly RowTypes[K][]) => {
    for (const row of rows) {
      const key = rowKey(kind, row.id);
      if (state.pending.has(key)) {
        held.set(key, { kind, row, reach } as HeldRow);
        continue;
      }
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
  // Captures are not optimistic board rows, but the change feed carries their
  // current state, so the Inbox can update without reloading.
  let captures: Map<Id, Capture> | null = null;
  for (const row of changes.captures) {
    const base = captures ?? state.captures;
    if (base.get(row.id) === row) continue;
    if (!captures) captures = new Map(state.captures);
    captures.set(row.id, row);
  }
  if (captures) next.captures = captures;
  if (changes.settings) next.settings = changes.settings;
  next.seen = seen;
  next.held = held;
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
