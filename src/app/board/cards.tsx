// Canvas cards. Each card reads its own row from the store, so a change to
// one item redraws one card; React Flow only sees ids and positions.

import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { memo, type MouseEvent } from "react";
import { textColourFor } from "../../shared/colour";
import { NOTE_SIZE, resizeNote, setTaskDone, unplaceTask } from "../actions";
import { CloseIcon } from "../components/icons";
import { AssigneeChip, DueChip, FromOutsideNote, ProvenanceLine } from "../components/ui";
import type { NoteNode, TaskNode } from "../lib/board";
import { noteTitle, taskTitle } from "../lib/items";
import { usePlanner } from "../store";

const stop = (e: MouseEvent) => e.stopPropagation();

/** Characters of a note's text drawn on the card; the card clips what does not fit. */
const BODY_EXCERPT = 600;

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
    </>
  );
}

export const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<NoteNode>) {
  const note = usePlanner((s) => s.notes.get(data.id));
  const label = usePlanner((s) => (note?.label_id ? s.labels.get(note.label_id) : undefined));
  if (!note) return null;
  const colours = label ? { background: label.colour_hex, color: textColourFor(label.colour_hex) } : undefined;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={NOTE_SIZE.minWidth}
        minHeight={NOTE_SIZE.minHeight}
        maxWidth={NOTE_SIZE.maxWidth}
        maxHeight={NOTE_SIZE.maxHeight}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_event, params) => void resizeNote(note.id, params)}
      />
      <Handles />
      <article className={`note-card${label ? "" : " note-card--plain"}`} style={colours}>
        <h3 className="note-title">{noteTitle(note)}</h3>
        {note.body && note.title.trim() !== "" && <p className="note-body">{note.body.slice(0, BODY_EXCERPT)}</p>}
        <footer className="card-footer">
          {label && <span className="card-label">{label.name}</span>}
          <ProvenanceLine prov={note.prov} />
        </footer>
      </article>
    </>
  );
});

export const TaskCard = memo(function TaskCard({ data }: NodeProps<TaskNode>) {
  const task = usePlanner((s) => s.tasks.get(data.id));
  const label = usePlanner((s) => (task?.label_id ? s.labels.get(task.label_id) : undefined));
  if (!task) return null;
  const done = task.status === "done";
  const title = taskTitle(task);
  return (
    <>
      <Handles />
      <article
        className={`task-card${done ? " task-card--done" : ""}`}
        style={label ? { borderLeftColor: label.colour_hex } : undefined}
      >
        <label className="task-check nodrag" onClick={stop} title={done ? "Reopen" : "Tick off"}>
          <input
            type="checkbox"
            checked={done}
            aria-label={done ? `Reopen “${title}”` : `Tick off “${title}”`}
            onChange={(e) => void setTaskDone(task.id, e.target.checked)}
          />
        </label>
        <div className="task-main">
          <h3 className="task-title">{title}</h3>
          {task.from_outside !== null && <FromOutsideNote kind={task.from_outside} />}
          <div className="card-meta">
            <AssigneeChip userId={task.assignee_id} />
            <DueChip due={task.due_date} done={done} />
            {label && <span className="card-label">{label.name}</span>}
          </div>
          <ProvenanceLine prov={task.prov} />
        </div>
        <button
          type="button"
          className="card-remove nodrag"
          title="Remove from board"
          aria-label={`Remove “${title}” from the board`}
          onClick={(e) => {
            e.stopPropagation();
            void unplaceTask(task.id);
          }}
        >
          <CloseIcon />
        </button>
      </article>
    </>
  );
});
