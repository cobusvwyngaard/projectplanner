// The side tray: open tasks that are not on the board. Drag one onto the
// canvas to place it, or use Place to put it in the middle of the view.

import { useMemo } from "react";
import { CloseIcon } from "../components/icons";
import { AssigneeChip, DueChip, FromOutsideNote, ItemLabel } from "../components/ui";
import { taskTitle } from "../lib/items";
import { trayTasks } from "../lib/list";
import { openItem } from "../router";
import { usePlanner } from "../store";

/** Drag-and-drop type carrying a task id from the tray to the canvas. */
export const TRAY_MIME = "application/x-planner-task";

export function Tray({ onClose, onPlace }: { onClose: () => void; onPlace: (taskId: string) => void }) {
  const tasks = usePlanner((s) => s.tasks);
  const labels = usePlanner((s) => s.labels);
  const unplaced = useMemo(() => trayTasks(tasks.values()), [tasks]);
  return (
    <aside className="tray" aria-labelledby="tray-heading">
      <header className="tray-header">
        <h2 id="tray-heading">
          Not on the board <span className="count">{unplaced.length}</span>
        </h2>
        <button type="button" className="icon-button" aria-label="Hide the tray" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {unplaced.length === 0 ? (
        <p className="muted small tray-hint">Every open task is on the board.</p>
      ) : (
        <>
          <p className="muted small tray-hint">Drag a task onto the board to place it.</p>
          <ul className="tray-list">
            {unplaced.map((task) => (
              <li
                key={task.id}
                className="tray-item"
                style={task.label_id ? { borderLeftColor: labels.get(task.label_id)?.colour_hex } : undefined}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TRAY_MIME, task.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
                <button type="button" className="link-button tray-title" onClick={() => openItem({ type: "task", id: task.id })}>
                  {taskTitle(task)}
                </button>
                {task.from_outside !== null && <FromOutsideNote kind={task.from_outside} />}
                <div className="card-meta">
                  <ItemLabel labelId={task.label_id} small />
                  <AssigneeChip userId={task.assignee_id} />
                  <DueChip due={task.due_date} done={false} />
                  <button type="button" className="button button--small tray-place" onClick={() => onPlace(task.id)}>
                    Place
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
