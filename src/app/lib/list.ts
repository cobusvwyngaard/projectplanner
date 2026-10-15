// The List view's tabs (SPEC 8: Mine / Theirs / Overdue / This week / Done,
// plus Unassigned and Notes) and its label filter.

import { dueState, weekBounds } from "../../shared/dates";
import type { Id, LocalDate, NoteView, TaskView } from "../../shared/types";

export type ListTab = "mine" | "theirs" | "overdue" | "week" | "done" | "unassigned" | "notes";

export const LIST_TABS: readonly { id: ListTab; label: string }[] = [
  { id: "mine", label: "Mine" },
  { id: "theirs", label: "Theirs" },
  { id: "overdue", label: "Overdue" },
  { id: "week", label: "This week" },
  { id: "done", label: "Done" },
  { id: "unassigned", label: "Unassigned" },
  { id: "notes", label: "Notes" },
];

export function isListTab(value: unknown): value is ListTab {
  return LIST_TABS.some((t) => t.id === value);
}

/** "all", "none" (items without a label) or a label id. */
export type LabelFilter = "all" | "none" | Id;

export interface ListContext {
  me: Id;
  /** The other person, if there is one */
  other: Id | null;
  today: LocalDate;
  label: LabelFilter;
}

function labelMatches(labelId: Id | null, filter: LabelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return labelId === null;
  return labelId === filter;
}

/** Earliest due date first, undated last, then by title. */
export function byDue(a: TaskView, b: TaskView): number {
  if (a.due_date !== b.due_date) {
    if (a.due_date === null) return 1;
    if (b.due_date === null) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}

/** Most recently ticked off first. */
function byDoneAt(a: TaskView, b: TaskView): number {
  return (b.done_at ?? "").localeCompare(a.done_at ?? "");
}

function inTab(task: TaskView, tab: Exclude<ListTab, "notes">, ctx: ListContext): boolean {
  if (tab === "done") return task.status === "done";
  if (task.status !== "open") return false;
  switch (tab) {
    case "mine":
      return task.assignee_id === ctx.me;
    case "theirs":
      return ctx.other !== null && task.assignee_id === ctx.other;
    case "unassigned":
      return task.assignee_id === null;
    case "overdue":
      return dueState(task.due_date, ctx.today) === "overdue";
    case "week": {
      if (task.due_date === null) return false;
      const { start, end } = weekBounds(ctx.today);
      return task.due_date >= start && task.due_date <= end;
    }
  }
}

/** The tasks a tab shows, sorted for it. */
export function tasksForTab(tab: Exclude<ListTab, "notes">, tasks: Iterable<TaskView>, ctx: ListContext): TaskView[] {
  const rows = [...tasks].filter((t) => labelMatches(t.label_id, ctx.label) && inTab(t, tab, ctx));
  return rows.sort(tab === "done" ? byDoneAt : byDue);
}

/** Notes for the Notes tab, most recently changed first. */
export function notesForList(notes: Iterable<NoteView>, label: LabelFilter): NoteView[] {
  return [...notes]
    .filter((n) => labelMatches(n.label_id, label))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** How many items each tab would show. */
export function tabCounts(tasks: Iterable<TaskView>, notes: Iterable<NoteView>, ctx: ListContext): Record<ListTab, number> {
  const all = [...tasks];
  const counts = { notes: notesForList(notes, ctx.label).length } as Record<ListTab, number>;
  for (const { id } of LIST_TABS) {
    if (id !== "notes") counts[id] = tasksForTab(id, all, ctx).length;
  }
  return counts;
}

/** Who a task added from a tab's quick-add field is assigned to. */
export function quickAddAssignee(tab: ListTab, ctx: Pick<ListContext, "me" | "other">): Id | null {
  if (tab === "mine") return ctx.me;
  if (tab === "theirs") return ctx.other;
  return null;
}
