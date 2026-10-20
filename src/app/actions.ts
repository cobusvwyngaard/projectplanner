// Changes the views make to the board: each calls the API, puts the result in
// the store and reports failures as a toast. They resolve to the new row, or
// undefined when the change failed (the caller keeps what the user typed).

import type {
  CreateLabelRequest,
  CreateNoteRequest,
  CreateTaskRequest,
  UpdateLabelRequest,
  UpdateNoteRequest,
  UpdateTaskRequest,
  UpdateUserRequest,
} from "../shared/api";
import type { Id, ItemRef, Label, Link, NoteView, SettingKey, SettingsMap, TaskView, User, UserEmail } from "../shared/types";
import { api } from "./api";
import { roundPosition } from "./lib/board";
import { store } from "./store";
import { attempt, reportError } from "./toast";

/** Note size limits of the API. */
export const NOTE_SIZE = { minWidth: 120, maxWidth: 2000, minHeight: 80, maxHeight: 2000 } as const;
/** Size of a new note (the notes table default). */
export const NEW_NOTE = { w: 240, h: 160 } as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function createNote(body: CreateNoteRequest): Promise<NoteView | undefined> {
  return attempt(async () => {
    const response = await api.createNote(body);
    store.applyMutation("note", response);
    return response.row;
  });
}

export function createTask(body: CreateTaskRequest): Promise<TaskView | undefined> {
  return attempt(async () => {
    const response = await api.createTask(body);
    store.applyMutation("task", response);
    return response.row;
  });
}

export function updateNote(id: Id, patch: UpdateNoteRequest): Promise<NoteView | undefined> {
  return attempt(() => store.change("note", id, patch, () => api.updateNote(id, patch)));
}

export function updateTask(id: Id, patch: UpdateTaskRequest): Promise<TaskView | undefined> {
  return attempt(() => store.change("task", id, patch, () => api.updateTask(id, patch)));
}

/** Tick a task off or reopen it. */
export function setTaskDone(id: Id, done: boolean): Promise<TaskView | undefined> {
  return attempt(() =>
    store.change("task", id, { status: done ? "done" : "open" }, () => (done ? api.completeTask(id) : api.reopenTask(id))),
  );
}

export interface Move {
  ref: ItemRef;
  x: number;
  y: number;
}

/**
 * Save where dragged items ended up: one request per item that actually
 * moved, all sent at drag end. Failures are reported once.
 */
export async function moveItems(moves: readonly Move[]): Promise<void> {
  const requests: Promise<unknown>[] = [];
  for (const move of moves) {
    const { x, y } = roundPosition(move);
    const row = move.ref.type === "note" ? store.row("note", move.ref.id) : store.row("task", move.ref.id);
    if (!row || (row.x === x && row.y === y)) continue;
    requests.push(
      move.ref.type === "note"
        ? store.change("note", move.ref.id, { x, y }, () => api.updateNote(move.ref.id, { x, y }))
        : store.change("task", move.ref.id, { x, y }, () => api.updateTask(move.ref.id, { x, y })),
    );
  }
  const failed = (await Promise.allSettled(requests)).find((r) => r.status === "rejected");
  if (failed) reportError(failed.reason);
}

/** Save a note's new size (and position, when resized from the top or left). */
export function resizeNote(id: Id, rect: { x: number; y: number; width: number; height: number }): Promise<NoteView | undefined> {
  const note = store.row("note", id);
  if (!note) return Promise.resolve(undefined);
  const next = {
    ...roundPosition(rect),
    w: Math.round(clamp(rect.width, NOTE_SIZE.minWidth, NOTE_SIZE.maxWidth)),
    h: Math.round(clamp(rect.height, NOTE_SIZE.minHeight, NOTE_SIZE.maxHeight)),
  };
  const patch: UpdateNoteRequest = {};
  if (next.x !== note.x || next.y !== note.y) Object.assign(patch, { x: next.x, y: next.y });
  if (next.w !== note.w) patch.w = next.w;
  if (next.h !== note.h) patch.h = next.h;
  if (Object.keys(patch).length === 0) return Promise.resolve(note);
  return updateNote(id, patch);
}

/** Put a task from the tray onto the board. */
export function placeTask(id: Id, position: { x: number; y: number }): Promise<TaskView | undefined> {
  return updateTask(id, roundPosition(position));
}

/** Send a task back to the tray. */
export function unplaceTask(id: Id): Promise<TaskView | undefined> {
  return updateTask(id, { x: null, y: null });
}

export function linkItems(a: ItemRef, b: ItemRef): Promise<Link | undefined> {
  return attempt(async () => {
    const response = await api.createLink({ a, b });
    store.applyMutation("link", response);
    return response.row;
  });
}

export function unlink(linkId: Id): Promise<Link | undefined> {
  return attempt(() => store.change("link", linkId, null, () => api.unlink(linkId)));
}

/** Archive or unarchive a note or task. Resolves to the row afterwards. */
export function setArchived(ref: ItemRef, archived: boolean): Promise<NoteView | TaskView | undefined> {
  return attempt(async () => {
    if (ref.type === "note") {
      const response = await (archived ? api.archiveNote(ref.id) : api.unarchiveNote(ref.id));
      store.applyMutation("note", response);
      return response.row;
    }
    const response = await (archived ? api.archiveTask(ref.id) : api.unarchiveTask(ref.id));
    store.applyMutation("task", response);
    return response.row;
  });
}

export function createLabel(body: CreateLabelRequest): Promise<Label | undefined> {
  return attempt(async () => {
    const response = await api.createLabel(body);
    store.applyMutation("label", response);
    return response.row;
  });
}

export function updateLabel(id: Id, patch: UpdateLabelRequest): Promise<Label | undefined> {
  return attempt(() => store.change("label", id, patch, () => api.updateLabel(id, patch)));
}

export function setLabelArchived(id: Id, archived: boolean): Promise<Label | undefined> {
  return attempt(async () => {
    const response = await (archived ? api.archiveLabel(id) : api.unarchiveLabel(id));
    store.applyMutation("label", response);
    // Archiving the default label also clears that setting; the feed brings it.
    store.pollNow();
    return response.row;
  });
}

/** Save a new label order (ids of every active label). */
export function reorderLabels(ids: Id[], optimistic: readonly Label[]): Promise<Label[] | undefined> {
  store.putLabels(optimistic);
  return attempt(async () => {
    try {
      const { labels } = await api.reorderLabels({ ids });
      store.putLabels(labels);
      return labels;
    } catch (err) {
      store.pollNow();
      throw err;
    }
  });
}

export function updateUser(id: Id, patch: UpdateUserRequest): Promise<User | undefined> {
  return attempt(() => store.change("user", id, patch, () => api.updateUser(id, patch)));
}

/**
 * Register an email address for a person (SPEC 11.2). It rethrows a failure,
 * so the caller can show the message under the field it belongs to.
 */
export function createUserEmail(userId: Id, address: string): Promise<UserEmail> {
  return api.createUserEmail(userId, { address }).then((response) => {
    store.applyMutation("user_email", response);
    return response.row;
  });
}

/** Archive a registered email address, freeing it for reuse (SPEC 11.2). */
export function archiveUserEmail(id: Id): Promise<UserEmail | undefined> {
  return attempt(async () => {
    const response = await api.archiveUserEmail(id);
    store.applyMutation("user_email", response);
    return response.row;
  });
}

export function updateSetting<K extends SettingKey>(key: K, value: SettingsMap[K]): Promise<SettingsMap | undefined> {
  return attempt(async () => {
    const { settings } = await api.updateSetting(key, value);
    store.setSettings(settings);
    return settings;
  });
}
