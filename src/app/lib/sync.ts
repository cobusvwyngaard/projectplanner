// The planner store: holds the PlannerState, applies our own changes and the
// change feed, and polls /api/changes every 5 s while the tab is visible and
// once whenever it becomes visible or the window gains focus (SPEC 4.2).
// It has no DOM or React code; src/app/store.ts wires it to the browser.

import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../shared/api";
import type { Capture, Id, Label, LocalDate, SettingsMap } from "../../shared/types";
import { ApiError, errorMessage } from "../api";
import {
  applyChanges,
  applyMutation,
  fromBootstrap,
  markPending,
  putRow,
  rolledToday,
  rowKey,
  settleChange,
  type PlannerState,
  type RowKind,
  type RowTypes,
} from "./state";

export const POLL_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;
/** Failed polls in a row before the app says it is reconnecting. */
export const TROUBLE_AFTER_FAILURES = 2;

export type LoadStatus = { phase: "loading" } | { phase: "ready" } | { phase: "error"; message: string };

export interface StoreClient {
  bootstrap(): Promise<BootstrapResponse>;
  changes(since: Id | null): Promise<ChangesResponse>;
}

/** What the store needs from the browser. */
export interface StoreHost {
  isVisible(): boolean;
  /** Listen for the tab turning visible or hidden and the window gaining focus; returns a stop function. */
  watch(handlers: { visible: () => void; hidden: () => void; focus: () => void }): () => void;
  /** Run fn after ms; returns a function that cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Today in Africa/Johannesburg by the browser's clock. */
  localToday(): LocalDate;
}

/** Delay before the next poll after `failures` failed polls in a row. */
export function backoffDelay(failures: number): number {
  return failures <= 0 ? POLL_INTERVAL_MS : Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** failures);
}

export class PlannerStore {
  private state: PlannerState | null = null;
  private status: LoadStatus = { phase: "loading" };
  private trouble = false;
  private readonly listeners = new Set<() => void>();
  private cancelTimer: (() => void) | null = null;
  private stopWatching: (() => void) | null = null;
  private polling = false;
  private pollAgain = false;
  private failures = 0;
  private stopped = true;
  private bootDays: { server: LocalDate; local: LocalDate } | null = null;

  constructor(
    private readonly client: StoreClient,
    private readonly host: StoreHost,
  ) {}

  // --- Subscriptions (for useSyncExternalStore) ---------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): PlannerState | null => this.state;
  readonly getStatus = (): LoadStatus => this.status;
  /** True after several failed polls in a row, until one succeeds. */
  readonly getTrouble = (): boolean => this.trouble;

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Replace the state with fn(state); listeners hear about it only if it changed. */
  update(fn: (state: PlannerState) => PlannerState): void {
    if (!this.state) return;
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  // --- Loading and polling ------------------------------------------------

  /** Load the board and start polling. Safe to call again after an error. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!(await this.load())) return;
    if (this.stopped) return;
    this.stopWatching?.();
    this.stopWatching = this.host.watch({
      visible: () => this.pollNow(),
      hidden: () => this.clearTimer(),
      focus: () => this.pollNow(),
    });
    this.schedule(POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.stopWatching?.();
    this.stopWatching = null;
  }

  /** Fetch /api/bootstrap. Returns false (and records the error) when that fails. */
  private async load(): Promise<boolean> {
    try {
      const boot = await this.client.bootstrap();
      const fresh = fromBootstrap(boot);
      // Changes of ours still in flight keep their protection across a reload.
      this.state = this.state ? { ...fresh, pending: this.state.pending } : fresh;
      this.bootDays = { server: boot.today, local: this.host.localToday() };
      this.status = { phase: "ready" };
      this.emit();
      return true;
    } catch (err) {
      if (this.state) throw err;
      this.status = { phase: "error", message: errorMessage(err) };
      this.emit();
      return false;
    }
  }

  /** Poll now (or straight after the poll in progress). */
  pollNow(): void {
    void this.poll();
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (this.stopped || !this.host.isVisible()) return;
    this.cancelTimer = this.host.setTimer(() => {
      this.cancelTimer = null;
      void this.poll();
    }, ms);
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.state) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    this.clearTimer();
    let delay = POLL_INTERVAL_MS;
    try {
      for (;;) {
        this.pollAgain = false;
        const changes = await this.client.changes(this.state.cursor);
        if (changes.reset) {
          await this.load();
        } else {
          this.update((s) => applyChanges(s, changes));
          if (changes.more) continue;
        }
        if (!this.pollAgain) break;
      }
      this.failures = 0;
      this.setTrouble(false);
    } catch (err) {
      // 401: the browser is already on its way to the phrase page.
      if (err instanceof ApiError && err.status === 401) {
        this.stop();
        return;
      }
      // Anything else (offline, a deploy in progress): back off quietly.
      this.failures += 1;
      delay = backoffDelay(this.failures);
      this.setTrouble(this.failures >= TROUBLE_AFTER_FAILURES);
    } finally {
      this.polling = false;
      this.rollToday();
      this.schedule(delay);
    }
  }

  private setTrouble(trouble: boolean): void {
    if (this.trouble === trouble) return;
    this.trouble = trouble;
    this.emit();
  }

  /** Move today on when the local date has rolled over since bootstrap. */
  private rollToday(): void {
    const boot = this.bootDays;
    if (!boot) return;
    const today = rolledToday(boot.server, boot.local, this.host.localToday());
    this.update((s) => (s.today === today ? s : { ...s, today }));
  }

  // --- Our own changes ----------------------------------------------------

  /** The current row of the given kind, if it is loaded (live). */
  row<K extends RowKind>(kind: K, id: Id): RowTypes[K] | undefined {
    const state = this.state;
    if (!state) return undefined;
    const maps: { [Kind in RowKind]: ReadonlyMap<Id, RowTypes[Kind]> } = {
      note: state.notes,
      task: state.tasks,
      link: state.links,
      label: state.labels,
      user: state.users,
    };
    return maps[kind].get(id);
  }

  /** Apply the response of a change made outside change(), e.g. a creation. */
  applyMutation<K extends RowKind>(kind: K, response: MutationResponse<RowTypes[K]>): void {
    this.update((s) => applyMutation(s, kind, response));
  }

  /**
   * Make a change to an existing row. `optimistic` fields show at once; the
   * change feed holds the row back until the request is answered. On failure
   * the row is put back (or replaced by a newer one the feed held back) and
   * the error is rethrown for the caller to report.
   */
  async change<K extends RowKind>(
    kind: K,
    id: Id,
    optimistic: Partial<RowTypes[K]> | null,
    call: () => Promise<MutationResponse<RowTypes[K]>>,
  ): Promise<RowTypes[K]> {
    const key = rowKey(kind, id);
    const before = this.row(kind, id);
    this.update((s) => {
      const marked = markPending(s, key, 1);
      return optimistic && before ? putRow(marked, kind, { ...before, ...optimistic }) : marked;
    });
    try {
      const response = await call();
      this.update((s) => settleChange(s, kind, id, response, undefined));
      return response.row;
    } catch (err) {
      this.update((s) => settleChange(s, kind, id, null, optimistic ? before : undefined));
      this.pollNow();
      throw err;
    }
  }

  /** Labels in their new order (POST /api/labels/reorder). */
  putLabels(labels: readonly Label[]): void {
    this.update((s) => labels.reduce((acc, label) => putRow(acc, "label", label), s));
  }

  setSettings(settings: SettingsMap): void {
    this.update((s) => ({ ...s, settings }));
  }

  /** Merge one capture (from a mutation response) into the live map. */
  putCapture(capture: Capture): void {
    this.update((s) => {
      if (s.captures.get(capture.id) === capture) return s;
      const captures = new Map(s.captures);
      captures.set(capture.id, capture);
      return { ...s, captures };
    });
  }
}
