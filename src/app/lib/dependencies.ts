// Pure helpers for task dependencies: derive before/after from link direction,
// group linked items into waits for / needed for / related, and format waiting
// text for cards, the tray and the List view.

import type { Id, ItemRef, Link, TaskView } from "../../shared/types";
import { itemKey } from "./items";

export interface DependencyEnds {
  before: ItemRef;
  after: ItemRef;
}

export type LinkRelation = DependencyEnds | "related";

/** The two ends of a link in the order the row stores them. */
export function linkEnds(link: Pick<Link, "a_type" | "a_id" | "b_type" | "b_id">): [ItemRef, ItemRef] {
  return [
    { type: link.a_type, id: link.a_id },
    { type: link.b_type, id: link.b_id },
  ];
}

/**
 * Turn a link's stored direction into before/after, or "related". The ends are
 * stored sorted, so "before" always comes from the direction, never from the
 * a/b order.
 */
export function linkRelation(link: Pick<Link, "a_type" | "a_id" | "b_type" | "b_id" | "direction">): LinkRelation {
  if (link.direction === "none") return "related";
  const [a, b] = linkEnds(link);
  return link.direction === "a_to_b" ? { before: a, after: b } : { before: b, after: a };
}

/** The end that comes first in a dependency, or null for a plain connection. */
export function dependencyBefore(link: Pick<Link, "a_type" | "a_id" | "b_type" | "b_id" | "direction">): ItemRef | null {
  const rel = linkRelation(link);
  return rel === "related" ? null : rel.before;
}

export interface LinkedItem {
  link: Link;
  other: ItemRef;
}

export interface TaskDependencies {
  /** Open dependencies where this task is the one that waits */
  waitsFor: LinkedItem[];
  /** Open dependencies where this task must be done first */
  neededFor: LinkedItem[];
  /** Plain connections */
  related: LinkedItem[];
}

/** The end of a link that is not the given item, or null when it is not an end. */
function otherEnd(link: Link, item: ItemRef): ItemRef | null {
  if (link.a_type === item.type && link.a_id === item.id) return { type: link.b_type, id: link.b_id };
  if (link.b_type === item.type && link.b_id === item.id) return { type: link.a_type, id: link.a_id };
  return null;
}

export function taskDependencies(item: ItemRef, links: Iterable<Link>): TaskDependencies {
  const waitsFor: LinkedItem[] = [];
  const neededFor: LinkedItem[] = [];
  const related: LinkedItem[] = [];
  for (const link of links) {
    const other = otherEnd(link, item);
    if (!other) continue;
    const rel = linkRelation(link);
    if (rel === "related") {
      related.push({ link, other });
      continue;
    }
    if (itemKey(rel.before) === itemKey(item)) neededFor.push({ link, other });
    else if (itemKey(rel.after) === itemKey(item)) waitsFor.push({ link, other });
  }
  return { waitsFor, neededFor, related };
}

/** Open prerequisites of a task: the tasks it waits for that are not done yet. */
export function openPrerequisiteIds(task: ItemRef, links: Iterable<Link>, tasks: ReadonlyMap<Id, TaskView>): Id[] {
  const ids: Id[] = [];
  for (const { other } of taskDependencies(task, links).waitsFor) {
    if (other.type !== "task") continue;
    const row = tasks.get(other.id);
    if (!row || row.archived_at !== null || row.status === "done") continue;
    if (!ids.includes(other.id)) ids.push(other.id);
  }
  return ids;
}

/**
 * "Waiting for "Book plumber"" for an open task with one open prerequisite, or
 * "Waiting for 2 tasks"; null when nothing is waiting.
 */
export function waitingForText(task: ItemRef, links: Iterable<Link>, tasks: ReadonlyMap<Id, TaskView>): string | null {
  const open = openPrerequisiteIds(task, links, tasks);
  if (open.length === 0) return null;
  if (open.length > 1) return `Waiting for ${open.length} tasks`;
  const [id] = open;
  if (id === undefined) return null;
  const row: TaskView | undefined = tasks.get(id);
  const title = row?.title.trim() || "an unnamed task";
  return `Waiting for "${title}"`;
}

/** True when the link is a dependency (its direction is not "none"). */
export function isDependencyLink(link: Pick<Link, "direction">): boolean {
  return link.direction !== "none";
}
