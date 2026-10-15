// Small browser hooks shared by the views.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Phones get the list by default, a bottom tab bar and full-screen sheets. */
export const PHONE_QUERY = "(max-width: 767px)";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

// One shared clock for every relative time on the page.
const CLOCK_MS = 30_000;
let clockNow = new Date();
let clockTimer: number | undefined;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockNow = new Date();
    clockTimer = window.setInterval(() => {
      clockNow = new Date();
      for (const l of [...clockListeners]) l();
    }, CLOCK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** The current time, refreshed every 30 s so relative times ("5 min ago") stay right. */
export function useNow(): Date {
  return useSyncExternalStore(subscribeClock, () => clockNow);
}

function readStored<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * State remembered in this browser (a chosen tab, a collapsed tray). Storage
 * may be unavailable (private windows); the state then simply resets.
 */
export function useStoredState<T>(key: string, fallback: T, valid: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback, valid));
  const update = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Not remembered; the choice still applies until the page reloads.
    }
  };
  return [value, update];
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export interface Draft {
  draft: string;
  change: (next: string) => void;
  commit: () => Promise<void>;
  /** Drop the draft and show the saved value again (after saving it another way). */
  cancel: () => void;
  saving: boolean;
  error: string | null;
}

/**
 * A draft of a saved value. While the user has unsaved typing, changes from
 * elsewhere do not overwrite it; a failed save leaves the draft in place.
 * Typing still unsaved when the field goes away (the panel was closed with
 * Back, which leaves the field without a blur) is saved then, and a failure
 * is reported by the save's own toast.
 */
export function useDraft(value: string, save: (next: string) => Promise<boolean>, validate?: (next: string) => string | null): Draft {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mirrors of the state for handlers that run before a re-render (a change
  // and a commit in one handler) and for the save on unmount.
  const latest = useRef(draft);
  const dirtyNow = useRef(false);
  const savingNow = useRef(false);
  const props = useRef({ value, save, validate });
  useEffect(() => {
    props.current = { value, save, validate };
  });

  const setDirty = (next: boolean) => {
    dirtyNow.current = next;
    setDirtyState(next);
  };

  useEffect(() => {
    if (!dirty) {
      setDraft(value);
      latest.current = value;
    }
  }, [value, dirty]);

  useEffect(
    () => () => {
      const { value: saved, save: persist, validate: check } = props.current;
      const text = latest.current;
      if (!dirtyNow.current || savingNow.current || text === saved || check?.(text)) return;
      void persist(text);
    },
    [],
  );

  const change = (next: string) => {
    latest.current = next;
    setDraft(next);
    setDirty(true);
    setError(null);
  };

  const commit = async () => {
    if (!dirtyNow.current || savingNow.current) return;
    const text = latest.current;
    if (text === value) {
      setDirty(false);
      return;
    }
    const problem = validate?.(text) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    savingNow.current = true;
    setSaving(true);
    const ok = await save(text);
    savingNow.current = false;
    setSaving(false);
    if (!ok) setError("Not saved yet. Your text is still here; try again.");
    // Typing that arrived while saving stays a draft.
    else if (latest.current === text) setDirty(false);
  };

  const cancel = () => {
    setDirty(false);
    setError(null);
  };

  return { draft, change, commit, cancel, saving, error };
}
