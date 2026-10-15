// Short messages in the corner: API errors and confirmations. Errors never
// clear what the user typed; the field that failed keeps its text.

import { useSyncExternalStore } from "react";
import { ApiError, errorMessage } from "./api";
import { CloseIcon } from "./components/icons";

export type ToastTone = "info" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const SHOW_MS = 6_000;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of [...listeners]) listener();
}

export function dismissToast(id: number): void {
  set(toasts.filter((t) => t.id !== id));
}

export function showToast(message: string, tone: ToastTone = "info"): void {
  const id = nextId++;
  // The same message twice in a row is shown once.
  set([...toasts.filter((t) => t.message !== message), { id, message, tone }].slice(-4));
  window.setTimeout(() => dismissToast(id), SHOW_MS);
}

/** Show an error from the API (or anything else) as a toast. A 401 is already redirecting. */
export function reportError(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) return;
  showToast(errorMessage(err), "error");
}

/** Run an action, reporting a failure as a toast. Resolves to undefined on failure. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

export function Toasts() {
  const list = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span>{toast.message}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
