// Notes and tasks as "items": references, titles, links between them, the
// Link to… search, rebuilding an archived item from its history, and
// checking a typed due date.

import { isLocalDate } from "../../shared/dates";
import { excerpt } from "../../shared/format";
import type { Id, ItemRef, ItemType, Link, NoteView, PlannerEvent, TaskView } from "../../shared/types";

export function itemKey(ref: ItemRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseItemKey(key: string): ItemRef | null {
  const match = /^(note|task):(.+)$/.exec(key);
  if (!match?.[1] || !match[2]) return null;
  return { type: match[1] as ItemType, id: match[2] };
}

export function noteTitle(note: Pick<NoteView, "title" | "body">): string {
  return note.title.trim() || excerpt(note.body, 60) || "Untitled note";
}

export function taskTitle(task: Pick<TaskView, "title">): string {
  return task.title.trim() || "Untitled task";
}

export interface ItemLookup {
  notes: ReadonlyMap<Id, NoteView>;
  tasks: ReadonlyMap<Id, TaskView>;
}

/** The title of a live item, or null when it is not loaded (archived or unknown). */
export function liveTitle(ref: ItemRef, items: ItemLookup): string | null {
  if (ref.type === "note") {
    const note = items.notes.get(ref.id);
    return note ? noteTitle(note) : null;
  }
  const task = items.tasks.get(ref.id);
  return task ? taskTitle(task) : null;
}

export interface LinkedItem {
  link: Link;
  other: ItemRef;
}

/** The links of an item, each with the item at the other end. */
export function linksOf(ref: ItemRef, links: Iterable<Link>): LinkedItem[] {
  const out: LinkedItem[] = [];
  for (const link of links) {
    if (link.a_type === ref.type && link.a_id === ref.id) out.push({ link, other: { type: link.b_type, id: link.b_id } });
    else if (link.b_type === ref.type && link.b_id === ref.id) out.push({ link, other: { type: link.a_type, id: link.a_id } });
  }
  return out;
}

export interface ItemMatch {
  ref: ItemRef;
  title: string;
}

/**
 * Live notes and tasks whose title (or note text) contains every word of
 * the query, leaving out the given items; open tasks before done ones.
 */
export function searchItems(query: string, items: ItemLookup, exclude: ReadonlySet<string>, limit = 20): ItemMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.includes(w));
  const found: (ItemMatch & { rank: number })[] = [];
  for (const note of items.notes.values()) {
    const ref: ItemRef = { type: "note", id: note.id };
    if (exclude.has(itemKey(ref)) || !matches(`${note.title}\n${note.body}`.toLowerCase())) continue;
    found.push({ ref, title: noteTitle(note), rank: 0 });
  }
  for (const task of items.tasks.values()) {
    const ref: ItemRef = { type: "task", id: task.id };
    if (exclude.has(itemKey(ref)) || !matches(task.title.toLowerCase())) continue;
    found.push({ ref, title: taskTitle(task), rank: task.status === "open" ? 0 : 1 });
  }
  found.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  return found.slice(0, limit).map(({ ref, title }) => ({ ref, title }));
}

/**
 * An item's row as of its last event, from its history (oldest first): the
 * creation holds the full row and every later event the fields it changed.
 * Used for items that are not on the board any more (archived).
 */
export function rebuildRow(ref: ItemRef, events: readonly PlannerEvent[]): Record<string, unknown> | null {
  const own = events.filter((e) => e.entity_type === ref.type && e.entity_id === ref.id);
  const start = own.findLastIndex((e) => e.before === null && e.after !== null);
  if (start < 0) return null;
  return own.slice(start).reduce<Record<string, unknown>>((row, e) => Object.assign(row, e.after ?? {}), {});
}

/** A rebuilt note row with the fields the panel needs, or null if it does not look like a note. */
export function asNote(row: Record<string, unknown> | null): NoteView | null {
  if (!row || typeof row.id !== "string" || typeof row.title !== "string" || typeof row.body !== "string") return null;
  return { ...(row as unknown as NoteView), prov: null };
}

/** A rebuilt task row with the fields the panel needs, or null if it does not look like a task. */
export function asTask(row: Record<string, unknown> | null): TaskView | null {
  if (!row || typeof row.id !== "string" || typeof row.title !== "string" || typeof row.status !== "string") return null;
  return { ...(row as unknown as TaskView), prov: null };
}

/** Earliest year a typed due date may have (anything earlier is a typing slip). */
const FIRST_DUE_YEAR = 1900;

/**
 * Why a typed due date cannot be saved, or null. `incomplete` is the date
 * input's validity.badInput: some parts are still empty. An emptied field
 * ("") clears the date.
 */
export function dueDateProblem(text: string, incomplete: boolean): string | null {
  if (incomplete) return "Not saved: finish the day, month and year, or press Clear.";
  if (text === "") return null;
  if (!isLocalDate(text) || Number(text.slice(0, 4)) < FIRST_DUE_YEAR) {
    return `Not saved: type the whole date, with a year from ${FIRST_DUE_YEAR} on.`;
  }
  return null;
}
