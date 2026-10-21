// Keyboard shortcuts on the board (Phase 5). One table: the key handling,
// the dialog and the tests all read it. Shortcuts only work when focus is on
// the board — never while typing, never with Ctrl, Meta or Alt held, and
// never while a dialog is open.

/** What a shortcut key does on the board. */
export type BoardAction = "new-note" | "new-task" | "fit" | "zoom-in" | "zoom-out" | "zoom-100" | "clear-selection" | "show-shortcuts";

/** One way to press a key: what the browser reports, and how the dialog names it. */
export interface ShortcutKey {
  /** The value of `KeyboardEvent.key` for the press ("n" for N, "Escape" for Esc). */
  readonly event: string;
  /** The key as it reads in the dialog. */
  readonly label: string;
}

/** One row of the shortcuts table. */
export interface ShortcutRow {
  readonly keys: readonly ShortcutKey[];
  /** What the board does with the keys, or nothing for keys React Flow handles itself. */
  readonly action: BoardAction | null;
  readonly description: string;
}

export const SHORTCUTS: readonly ShortcutRow[] = [
  { keys: [{ event: "n", label: "N" }], action: "new-note", description: "Add a note at the free spot in view" },
  { keys: [{ event: "t", label: "T" }], action: "new-task", description: "Ask for a title and add a task" },
  { keys: [{ event: "f", label: "F" }], action: "fit", description: "Fit the view" },
  { keys: [{ event: "+", label: "+" }], action: "zoom-in", description: "Zoom in" },
  { keys: [{ event: "-", label: "-" }], action: "zoom-out", description: "Zoom out" },
  { keys: [{ event: "0", label: "0" }], action: "zoom-100", description: "Zoom to 100%" },
  { keys: [{ event: "Escape", label: "Esc" }], action: "clear-selection", description: "Clear the selection" },
  { keys: [{ event: "?", label: "?" }], action: "show-shortcuts", description: "Show this list" },
  { keys: [{ event: "Enter", label: "Enter" }], action: null, description: "Open the focused card" },
  {
    keys: [
      { event: "ArrowUp", label: "↑" },
      { event: "ArrowDown", label: "↓" },
      { event: "ArrowLeft", label: "←" },
      { event: "ArrowRight", label: "→" },
    ],
    action: null,
    description: "Move the selected card",
  },
  {
    keys: [
      { event: "Delete", label: "Delete" },
      { event: "Backspace", label: "Backspace" },
    ],
    action: null,
    description: "Unlink the selected links",
  },
];

/** Everything a key press carries, as the board sees it. */
export interface ShortcutContext {
  /** The value of `KeyboardEvent.key`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  /** Focus sits in an input, textarea, select or contenteditable. */
  readonly inTextField: boolean;
  readonly dialogOpen: boolean;
}

/** The key behind a single character whatever the Shift state ("n" for "N"). */
function baseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** The action for a key press on the board, or nothing when the press is not one of theirs. */
export function resolveShortcut(context: ShortcutContext): BoardAction | null {
  if (context.ctrl || context.meta || context.alt) return null;
  if (context.inTextField || context.dialogOpen) return null;
  const pressed = baseKey(context.key).toLowerCase();
  for (const row of SHORTCUTS) {
    if (row.action !== null && row.keys.some((k) => k.event.toLowerCase() === pressed)) return row.action;
  }
  return null;
}

/** True when the element is for text, so the key press belongs to it and not to the board. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
