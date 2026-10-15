// The one planner store of the app, wired to the browser, and the hooks
// components read it with. Selectors must return values already in the state
// (a map, a row, a setting) rather than build new arrays or objects; derive
// lists with useMemo in the component instead.

import { useSyncExternalStore } from "react";
import { localToday } from "../shared/dates";
import { api } from "./api";
import type { PlannerState } from "./lib/state";
import { PlannerStore, type LoadStatus, type StoreHost } from "./lib/sync";

const browserHost: StoreHost = {
  isVisible: () => document.visibilityState === "visible",
  watch({ visible, hidden, focus }) {
    const onVisibility = () => (document.visibilityState === "visible" ? visible() : hidden());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", focus);
    };
  },
  setTimer(fn, ms) {
    const handle = window.setTimeout(fn, ms);
    return () => window.clearTimeout(handle);
  },
  localToday: () => localToday(),
};

export const store = new PlannerStore(api, browserHost);

function loadedState(): PlannerState {
  const state = store.getState();
  if (!state) throw new Error("The planner has not loaded yet.");
  return state;
}

/** Read part of the loaded planner state; re-renders when that part changes. */
export function usePlanner<T>(selector: (state: PlannerState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(loadedState()));
}

export function useLoadStatus(): LoadStatus {
  return useSyncExternalStore(store.subscribe, store.getStatus);
}

/** True while polls keep failing (offline, or the Worker is unreachable). */
export function useSyncTrouble(): boolean {
  return useSyncExternalStore(store.subscribe, store.getTrouble);
}
