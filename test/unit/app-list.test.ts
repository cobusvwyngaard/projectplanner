import { describe, expect, it } from "vitest";
import { LIST_TABS, notesForList, quickAddAssignee, tabCounts, tasksForTab, type ListContext } from "../../src/app/lib/list";
import { ME, OTHER, note, task } from "./app-fixtures";

// Wednesday 14 Oct 2026; the week runs from Monday 12 to Sunday 18 Oct.
const ctx: ListContext = { me: ME.id, other: OTHER.id, today: "2026-10-14", label: "all" };

const tasks = [
  task({ id: "mine-late", assignee_id: ME.id, due_date: "2026-10-10" }),
  task({ id: "mine-undated", assignee_id: ME.id }),
  task({ id: "mine-today", assignee_id: ME.id, due_date: "2026-10-14", label_id: "LA" }),
  task({ id: "theirs-sunday", assignee_id: OTHER.id, due_date: "2026-10-18" }),
  task({ id: "theirs-next-week", assignee_id: OTHER.id, due_date: "2026-10-19", label_id: "LA" }),
  task({ id: "nobody-monday", due_date: "2026-10-12" }),
  task({ id: "done-early", status: "done", assignee_id: ME.id, due_date: "2026-10-01", done_at: "2026-10-02T08:00:00.000Z" }),
  task({ id: "done-late", status: "done", done_at: "2026-10-13T08:00:00.000Z" }),
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("tasksForTab", () => {
  it("Mine: my open tasks, earliest due first, undated last", () => {
    expect(ids(tasksForTab("mine", tasks, ctx))).toEqual(["mine-late", "mine-today", "mine-undated"]);
  });

  it("Theirs: the other person's open tasks", () => {
    expect(ids(tasksForTab("theirs", tasks, ctx))).toEqual(["theirs-sunday", "theirs-next-week"]);
    expect(tasksForTab("theirs", tasks, { ...ctx, other: null })).toEqual([]);
  });

  it("Overdue: open tasks due before today, whoever has them", () => {
    expect(ids(tasksForTab("overdue", tasks, ctx))).toEqual(["mine-late", "nobody-monday"]);
  });

  it("This week: open tasks due Monday to Sunday", () => {
    expect(ids(tasksForTab("week", tasks, ctx))).toEqual(["nobody-monday", "mine-today", "theirs-sunday"]);
  });

  it("Done: ticked-off tasks, most recent first", () => {
    expect(ids(tasksForTab("done", tasks, ctx))).toEqual(["done-late", "done-early"]);
  });

  it("Unassigned: open tasks without an assignee", () => {
    expect(ids(tasksForTab("unassigned", tasks, ctx))).toEqual(["nobody-monday"]);
  });

  it("filters by label, or by having none", () => {
    expect(ids(tasksForTab("mine", tasks, { ...ctx, label: "LA" }))).toEqual(["mine-today"]);
    expect(ids(tasksForTab("mine", tasks, { ...ctx, label: "none" }))).toEqual(["mine-late", "mine-undated"]);
  });

  it("follows today when the date rolls over", () => {
    expect(ids(tasksForTab("overdue", tasks, { ...ctx, today: "2026-10-15" }))).toEqual(["mine-late", "nobody-monday", "mine-today"]);
    expect(ids(tasksForTab("week", tasks, { ...ctx, today: "2026-10-19" }))).toEqual(["theirs-next-week"]);
  });
});

describe("notesForList and tabCounts", () => {
  const notes = [
    note({ id: "old", updated_at: "2026-10-01T00:00:00.000Z" }),
    note({ id: "new", updated_at: "2026-10-14T00:00:00.000Z", label_id: "LA" }),
  ];

  it("lists notes most recently changed first, filtered by label", () => {
    expect(ids(notesForList(notes, "all"))).toEqual(["new", "old"]);
    expect(ids(notesForList(notes, "LA"))).toEqual(["new"]);
  });

  it("counts every tab", () => {
    expect(tabCounts(tasks, notes, ctx)).toEqual({ mine: 3, theirs: 2, overdue: 2, week: 3, done: 2, unassigned: 1, notes: 2 });
    expect(LIST_TABS.map((t) => t.label)).toEqual(["Mine", "Theirs", "Overdue", "This week", "Done", "Unassigned", "Notes"]);
  });
});

describe("quickAddAssignee", () => {
  it("assigns to me in Mine, to the other person in Theirs, otherwise nobody", () => {
    expect(quickAddAssignee("mine", ctx)).toBe(ME.id);
    expect(quickAddAssignee("theirs", ctx)).toBe(OTHER.id);
    expect(quickAddAssignee("week", ctx)).toBeNull();
  });
});
