// The item panel: a drawer on wide screens and a full-screen sheet on phones.
// Edit a note or task, see who made and changed it, manage its links, read
// its full history with field-level diffs, and revert any change.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { HistoryResponse } from "../../shared/api";
import { actorLabel, eventActor } from "../../shared/actors";
import type { ItemRef, NoteView, PlannerEvent, TaskView } from "../../shared/types";
import { setArchived, setTaskDone, unplaceTask, updateNote, updateTask } from "../actions";
import { api, errorMessage } from "../api";
import { EventEntry } from "../components/events";
import { BackIcon, CloseIcon } from "../components/icons";
import { ProvenanceLine, TimeAgo } from "../components/ui";
import { useIsPhone } from "../hooks";
import type { DescribeContext } from "../lib/events";
import { asNote, asTask, completionEvent, linksOf, liveTitle, parseItemKey, rebuildRow } from "../lib/items";
import { closeItem } from "../router";
import { usePlanner } from "../store";
import { AssigneePicker, DueDateField, LabelPicker, TextField } from "./fields";
import { LinksSection } from "./LinksSection";

export function ItemPanel({ itemKey: key }: { itemKey: string }) {
  const item = useMemo(() => parseItemKey(key), [key]);
  return (
    <PanelFrame itemKey={key} title={item?.type === "task" ? "Task" : item?.type === "note" ? "Note" : "Not found"}>
      {item ? <ItemDetails item={item} /> : <p>This link does not point to a note or a task.</p>}
    </PanelFrame>
  );
}

function PanelFrame({ itemKey, title, children }: { itemKey: string; title: string; children: ReactNode }) {
  const phone = useIsPhone();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const frame = useRef<HTMLElement>(null);
  // What had focus when the panel opened (read while rendering, before
  // anything in the panel takes focus): the list row, card or button.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  // When the panel closes with focus inside it, focus falls to <body>; send
  // it back to the opener, or to the item's card on the board if the opener
  // has gone, so keyboard users carry on where they were.
  useEffect(
    () => () => {
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${itemKey}"]`);
      (opener?.isConnected && opener !== document.body ? opener : card)?.focus();
    },
    [opener, itemKey],
  );

  // Focus moves into the panel when it opens, unless a field already took it.
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) heading.current?.focus();
  }, [title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Leaving a field saves it first.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      closeItem();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="panel" role="dialog" aria-labelledby={headingId} ref={frame}>
      <header className="panel-header">
        <button type="button" className="icon-button" aria-label={phone ? "Back" : "Close"} onClick={closeItem}>
          {phone ? <BackIcon /> : <CloseIcon />}
        </button>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          {title}
        </h2>
      </header>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

function ItemDetails({ item }: { item: ItemRef }) {
  const live = usePlanner((s) => (item.type === "note" ? s.notes.get(item.id) : s.tasks.get(item.id)));
  const links = usePlanner((s) => s.links);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [archivedRow, setArchivedRow] = useState<NoteView | TaskView | null>(null);
  const [reloads, setReloads] = useState(0);
  const linkIds = useMemo(() => linksOf(item, links.values()).map((l) => l.link.id).join(","), [links, item]);

  // Reload the history whenever the item or its links change, or after a revert.
  useEffect(() => {
    let current = true;
    api.history(item.type, item.id).then(
      (response) => {
        if (!current) return;
        setHistory(response);
        setHistoryError(null);
      },
      (err: unknown) => {
        if (current) setHistoryError(errorMessage(err));
      },
    );
    return () => {
      current = false;
    };
  }, [item.type, item.id, live?.updated_at, linkIds, reloads]);

  const rebuilt = useMemo(() => {
    if (live || !history) return null;
    const row = rebuildRow(item, history.events);
    return item.type === "note" ? asNote(row) : asTask(row);
  }, [live, history, item]);
  const row: NoteView | TaskView | null = live ?? archivedRow ?? rebuilt;

  if (!row) {
    return historyError ? <p role="alert">{historyError}</p> : <p className="muted">Loading…</p>;
  }
  const archived = row.archived_at !== null;

  const toggleArchived = async () => {
    const result = await setArchived(item, !archived);
    if (result) setArchivedRow(result.archived_at === null ? null : result);
  };

  return (
    <>
      {archived && (
        <div className="banner">
          <span>This {item.type} is archived.</span>
          <button type="button" className="button" onClick={() => void toggleArchived()}>
            Unarchive
          </button>
        </div>
      )}
      {item.type === "task" ? (
        <TaskFields task={row as TaskView} events={history?.events ?? []} disabled={archived} />
      ) : (
        <NoteFields note={row as NoteView} disabled={archived} />
      )}
      <ProvenanceLine prov={live?.prov ?? null} detailed />
      <LinksSection item={item} disabled={archived} titles={history?.titles} />
      <section className="panel-section" aria-labelledby="history-heading">
        <h3 id="history-heading">History</h3>
        {history ? (
          <History item={item} history={history} onReverted={() => setReloads((n) => n + 1)} />
        ) : historyError ? (
          <p role="alert">{historyError}</p>
        ) : (
          <p className="muted">Loading the history…</p>
        )}
      </section>
      {!archived && (
        <div className="panel-footer">
          <button type="button" className="button button--quiet" onClick={() => void toggleArchived()}>
            Archive this {item.type}
          </button>
        </div>
      )}
    </>
  );
}

const required = (what: string) => (value: string) => (value.trim() === "" ? `${what} needs a title.` : null);

function TaskFields({ task, events, disabled }: { task: TaskView; events: readonly PlannerEvent[]; disabled: boolean }) {
  const users = usePlanner((s) => s.users);
  const done = task.status === "done";
  // Named from the event, so Claude's tick reads "Claude (via …)" (SPEC 5).
  const ticked = completionEvent(task, events);
  return (
    <div className="fields">
      <label className="check-row">
        <input type="checkbox" checked={done} disabled={disabled} onChange={(e) => void setTaskDone(task.id, e.target.checked)} />
        <span>
          {done ? (
            <>
              Done
              {ticked && <> · ticked off by {actorLabel(eventActor(ticked), users)}</>}
              {task.done_at && (
                <>
                  {" "}
                  <TimeAgo ts={task.done_at} />
                </>
              )}
            </>
          ) : (
            "Open: tick off when done"
          )}
        </span>
      </label>
      <TextField
        label="Title"
        large
        value={task.title}
        disabled={disabled}
        validate={required("A task")}
        onSave={async (title) => (await updateTask(task.id, { title: title.trim() })) !== undefined}
      />
      <TextField
        label="Details"
        multiline
        value={task.detail}
        disabled={disabled}
        placeholder="Anything that helps get it done"
        onSave={async (detail) => (await updateTask(task.id, { detail })) !== undefined}
      />
      <AssigneePicker value={task.assignee_id} disabled={disabled} onChange={(id) => void updateTask(task.id, { assignee_id: id })} />
      <DueDateField
        value={task.due_date}
        disabled={disabled}
        onSave={async (due) => (await updateTask(task.id, { due_date: due })) !== undefined}
      />
      <LabelPicker value={task.label_id} disabled={disabled} onChange={(id) => void updateTask(task.id, { label_id: id })} />
      <div className="field">
        <span className="field-label">Board</span>
        {task.x === null ? (
          <p className="muted small">Not on the board. Drag it from the tray on the Board to place it.</p>
        ) : (
          <div className="inline-row">
            <span className="small">On the board</span>
            <button type="button" className="button button--small button--quiet" disabled={disabled} onClick={() => void unplaceTask(task.id)}>
              Remove from board
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteFields({ note, disabled }: { note: NoteView; disabled: boolean }) {
  // A note that was just made (nothing in it yet) is ready for typing.
  const [blank] = useState(() => note.title === "" && note.body === "");
  return (
    <div className="fields">
      <TextField
        label="Title"
        large
        autoFocus={blank && !disabled}
        value={note.title}
        disabled={disabled}
        placeholder="Untitled note"
        onSave={async (title) => (await updateNote(note.id, { title: title.trim() })) !== undefined}
      />
      <TextField
        label="Text"
        multiline
        value={note.body}
        disabled={disabled}
        placeholder="Ideas, context, background…"
        onSave={async (body) => (await updateNote(note.id, { body })) !== undefined}
      />
      <LabelPicker value={note.label_id} disabled={disabled} onChange={(id) => void updateNote(note.id, { label_id: id })} />
    </div>
  );
}

function History({ item, history, onReverted }: { item: ItemRef; history: HistoryResponse; onReverted: () => void }) {
  const users = usePlanner((s) => s.users);
  const labels = usePlanner((s) => s.labels);
  const notes = usePlanner((s) => s.notes);
  const tasks = usePlanner((s) => s.tasks);
  const ctx: DescribeContext = useMemo(() => ({ users, labels, titles: history.titles }), [users, labels, history.titles]);
  const extras = useMemo(
    () => ({
      runs: new Map(history.runs.map((r) => [r.id, r])),
      captures: new Map(history.captures.map((c) => [c.id, c])),
    }),
    [history.runs, history.captures],
  );
  const newestFirst = useMemo(() => [...history.events].reverse(), [history.events]);
  if (newestFirst.length === 0) return <p className="muted small">No changes recorded yet.</p>;
  return (
    <ol className="timeline">
      {newestFirst.map((event) => {
        const self = event.entity_type === item.type && event.entity_id === item.id;
        const other: ItemRef | null =
          !self && (event.entity_type === "note" || event.entity_type === "task")
            ? { type: event.entity_type, id: event.entity_id }
            : null;
        const canOpen = other !== null && liveTitle(other, { notes, tasks }) !== null;
        return (
          <EventEntry
            key={event.id}
            event={event}
            ctx={ctx}
            extras={extras}
            self={self}
            open={canOpen && other ? other : undefined}
            onReverted={onReverted}
          />
        );
      })}
    </ol>
  );
}
