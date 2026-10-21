// The List view (SPEC 8; the default on phones): tabs Mine / Theirs /
// Overdue / This week / Done, plus Unassigned and Notes; a label filter;
// tick off inline; tap a row to open it; quick-add at the top.

import { useMemo, useState, type FormEvent } from "react";
import type { Id, Label, NoteView, TaskView } from "../../shared/types";
import { createNote, createTask, setTaskDone } from "../actions";
import { AssigneeChip, DueChip, FromOutsideNote, ItemLabel, ProvenanceLine } from "../components/ui";
import { useStoredState } from "../hooks";
import { noteTitle, taskTitle } from "../lib/items";
import {
  LIST_TABS,
  isListTab,
  notesForList,
  quickAddAssignee,
  tabCounts,
  tasksForTab,
  type LabelFilter,
  type ListContext,
  type ListTab,
} from "../lib/list";
import { openItem } from "../router";
import { usePlanner } from "../store";

const EMPTY: Record<ListTab, string> = {
  mine: "Nothing assigned to you. Enjoy it.",
  theirs: "Nothing assigned to them.",
  overdue: "Nothing is overdue.",
  week: "Nothing is due this week.",
  done: "Nothing ticked off yet.",
  unassigned: "Every open task has someone on it.",
  notes: "No notes yet.",
};

/** Tabs whose quick-add field makes an item that shows up in that tab. */
const QUICK_ADD_TABS: ReadonlySet<ListTab> = new Set(["mine", "theirs", "unassigned", "notes"]);

function isLabelFilter(value: string, labels: ReadonlyMap<Id, Label>): boolean {
  return value === "all" || value === "none" || labels.has(value);
}

export function ListView() {
  const me = usePlanner((s) => s.me);
  const users = usePlanner((s) => s.users);
  const tasks = usePlanner((s) => s.tasks);
  const notes = usePlanner((s) => s.notes);
  const labels = usePlanner((s) => s.labels);
  const today = usePlanner((s) => s.today);
  const [tab, setTab] = useStoredState<ListTab>("planner.list.tab", "mine", isListTab);
  const [filter, setFilter] = useState<LabelFilter>("all");

  const other = useMemo(() => [...users.values()].find((u) => u.id !== me.id) ?? null, [users, me.id]);
  const label: LabelFilter = isLabelFilter(filter, labels) ? filter : "all";
  const ctx: ListContext = useMemo(() => ({ me: me.id, other: other?.id ?? null, today, label }), [me.id, other, today, label]);
  const counts = useMemo(() => tabCounts(tasks.values(), notes.values(), ctx), [tasks, notes, ctx]);
  const rows = useMemo(
    () => (tab === "notes" ? notesForList(notes.values(), label) : tasksForTab(tab, tasks.values(), ctx)),
    [tab, tasks, notes, label, ctx],
  );
  const activeLabels = useMemo(
    () => [...labels.values()].filter((l) => l.archived_at === null).sort((a, b) => a.sort_order - b.sort_order),
    [labels],
  );

  const tabLabel = (id: ListTab, text: string) => (id === "theirs" && other ? `${text} (${other.display_name})` : text);

  return (
    <div className="list-view">
      <div className="list-tabs" role="tablist" aria-label="Lists">
        {LIST_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="list-panel"
            className={`list-tab${tab === t.id ? " list-tab--active" : ""}${t.id === "overdue" && counts.overdue > 0 ? " list-tab--alert" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {tabLabel(t.id, t.label)} <span className="count">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      <div className="list-tools">
        <label className="inline-label">
          <span>Label</span>
          <select className="input select" aria-label="Label" value={label} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All labels</option>
            <option value="none">No label</option>
            {activeLabels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div id="list-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {QUICK_ADD_TABS.has(tab) && <QuickAdd key={tab} tab={tab} ctx={ctx} otherName={other?.display_name ?? null} />}
        {rows.length === 0 ? (
          <p className="empty">{label === "all" ? EMPTY[tab] : "Nothing with this label here."}</p>
        ) : (
          <ul className="rows">
            {tab === "notes"
              ? (rows as NoteView[]).map((note) => <NoteRow key={note.id} note={note} />)
              : (rows as TaskView[]).map((task) => <TaskRow key={task.id} task={task} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: TaskView }) {
  const done = task.status === "done";
  const title = taskTitle(task);
  return (
    <li className={`row${done ? " row--done" : ""}`}>
      <label className="row-check" title={done ? "Reopen" : "Tick off"}>
        <input
          type="checkbox"
          checked={done}
          aria-label={done ? `Reopen “${title}”` : `Tick off “${title}”`}
          onChange={(e) => void setTaskDone(task.id, e.target.checked)}
        />
      </label>
      <button type="button" className="row-main" onClick={() => openItem({ type: "task", id: task.id })}>
        <span className="row-title">{title}</span>
        <span className="row-meta">
          <ItemLabel labelId={task.label_id} small />
          <AssigneeChip userId={task.assignee_id} />
          <DueChip due={task.due_date} done={done} />
          {task.from_outside !== null && <FromOutsideNote kind={task.from_outside} />}
          <ProvenanceLine prov={task.prov} />
        </span>
      </button>
    </li>
  );
}

function NoteRow({ note }: { note: NoteView }) {
  const colour = usePlanner((s) => (note.label_id ? s.labels.get(note.label_id)?.colour_hex : undefined));
  return (
    <li className="row">
      <span className={`row-swatch${colour ? "" : " row-swatch--plain"}`} style={colour ? { background: colour } : undefined} aria-hidden="true" />
      <button type="button" className="row-main" onClick={() => openItem({ type: "note", id: note.id })}>
        <span className="row-title">{noteTitle(note)}</span>
        {note.title.trim() !== "" && note.body && <span className="row-excerpt">{note.body}</span>}
        <span className="row-meta">
          <ItemLabel labelId={note.label_id} small />
          <ProvenanceLine prov={note.prov} />
        </span>
      </button>
    </li>
  );
}

function QuickAdd({ tab, ctx, otherName }: { tab: ListTab; ctx: ListContext; otherName: string | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const isNote = tab === "notes";
  const placeholder = isNote
    ? "Add a note…"
    : tab === "mine"
      ? "Add a task for yourself…"
      : tab === "theirs" && otherName
        ? `Add a task for ${otherName}…`
        : "Add a task…";
  // A chosen label filter applies to the new item so it shows in this list.
  const labelId = ctx.label === "all" ? undefined : ctx.label === "none" ? null : ctx.label;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    const created = isNote
      ? await createNote({ title, ...(labelId !== undefined && { label_id: labelId }) })
      : await createTask({ title, assignee_id: quickAddAssignee(tab, ctx), ...(labelId !== undefined && { label_id: labelId }) });
    setBusy(false);
    // On failure the text stays in the field.
    if (created) setText("");
  };

  return (
    <form className="quick-add" onSubmit={(e) => void submit(e)}>
      <input
        className="input"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder.replace("…", "")}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="button button--primary" disabled={busy || text.trim() === ""}>
        Add
      </button>
    </form>
  );
}
