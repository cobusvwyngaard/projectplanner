// The store's poller: 5-second polls while visible, once on focus or when the
// tab becomes visible, never two at once, quiet back-off on network errors.

import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/app/api";
import { POLL_INTERVAL_MS, PlannerStore, backoffDelay, type StoreClient, type StoreHost } from "../../src/app/lib/sync";
import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../src/shared/api";
import type { NoteView } from "../../src/shared/types";
import { bootstrap, changes, event, note } from "./app-fixtures";

/** Let every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(boot: BootstrapResponse = bootstrap()) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let handlers: Parameters<StoreHost["watch"]>[0] | null = null;
  const env = { visible: true, today: "2026-10-14" };
  const host: StoreHost = {
    isVisible: () => env.visible,
    watch(h) {
      handlers = h;
      return () => {
        handlers = null;
      };
    },
    setTimer(fn, ms) {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    localToday: () => env.today,
  };
  const calls: (string | null)[] = [];
  const answers: Deferred<ChangesResponse>[] = [];
  let boots = 0;
  const client: StoreClient = {
    bootstrap: async () => {
      boots += 1;
      return boot;
    },
    changes: (since) => {
      calls.push(since);
      const answer = deferred<ChangesResponse>();
      answers.push(answer);
      return answer.promise;
    },
  };
  const store = new PlannerStore(client, host);
  const live = () => timers.filter((t) => t.live);
  return {
    store,
    env,
    calls,
    answers,
    boots: () => boots,
    live,
    handlers: () => handlers,
    /** Fire the one scheduled timer. */
    fire() {
      const [timer] = live();
      if (!timer) throw new Error("no timer scheduled");
      timer.live = false;
      timer.fn();
    },
  };
}

describe("PlannerStore loading", () => {
  it("loads the board, reports ready and schedules the first poll", async () => {
    const t = setup(bootstrap({ notes: [note({ id: "N1" })] }));
    expect(t.store.getStatus()).toEqual({ phase: "loading" });
    await t.store.start();
    expect(t.store.getStatus()).toEqual({ phase: "ready" });
    expect(t.store.getState()?.notes.has("N1")).toBe(true);
    expect(t.live().map((x) => x.ms)).toEqual([POLL_INTERVAL_MS]);
  });

  it("reports a failed bootstrap without polling", async () => {
    const t = setup();
    const store = new PlannerStore(
      { bootstrap: () => Promise.reject(new ApiError(500, "internal_error", "Something went wrong.")), changes: () => Promise.reject(new Error("unused")) },
      { isVisible: () => true, watch: () => () => undefined, setTimer: () => () => undefined, localToday: () => "2026-10-14" },
    );
    await store.start();
    expect(store.getStatus()).toEqual({ phase: "error", message: "Something went wrong." });
    expect(t.calls).toEqual([]);
  });
});

describe("PlannerStore polling", () => {
  it("polls with the cursor, applies the changes and polls again 5 s later", async () => {
    const t = setup();
    await t.store.start();
    t.fire();
    expect(t.calls).toEqual(["E10"]);
    t.answers[0]?.resolve(changes({ events: [event({ seq: 11 })], notes: [note({ id: "N5" })], cursor: "E11" }));
    await settle();
    expect(t.store.getState()?.notes.has("N5")).toBe(true);
    expect(t.store.getState()?.cursor).toBe("E11");
    expect(t.live().map((x) => x.ms)).toEqual([POLL_INTERVAL_MS]);
  });

  it("polls again straight away while more changes are waiting", async () => {
    const t = setup();
    await t.store.start();
    t.fire();
    t.answers[0]?.resolve(changes({ events: [event({ seq: 11 })], cursor: "E11", more: true }));
    await settle();
    expect(t.calls).toEqual(["E10", "E11"]);
    t.answers[1]?.resolve(changes({ events: [event({ seq: 12 })], cursor: "E12" }));
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.store.getState()?.cursor).toBe("E12");
  });

  it("reloads the board when the feed asks for a reset", async () => {
    const t = setup();
    await t.store.start();
    expect(t.boots()).toBe(1);
    t.fire();
    t.answers[0]?.resolve(changes({ reset: true, cursor: "E99" }));
    await settle();
    expect(t.boots()).toBe(2);
    expect(t.store.getState()?.cursor).toBe("E10");
  });

  it("never runs two polls at once; a request during a poll runs straight after it", async () => {
    const t = setup();
    await t.store.start();
    t.store.pollNow();
    t.store.pollNow();
    t.store.pollNow();
    expect(t.calls).toHaveLength(1);
    expect(t.live()).toHaveLength(0);
    t.answers[0]?.resolve(changes({ events: [event({ seq: 11 })], cursor: "E11" }));
    await settle();
    expect(t.calls).toEqual(["E10", "E11"]);
    t.answers[1]?.resolve(changes({ cursor: "E11" }));
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.live()).toHaveLength(1);
  });

  it("backs off quietly on network errors and recovers", async () => {
    const t = setup();
    await t.store.start();
    const network = new ApiError(0, "network_error", "offline");
    t.fire();
    t.answers[0]?.reject(network);
    await settle();
    expect(t.live().map((x) => x.ms)).toEqual([backoffDelay(1)]);
    expect(t.store.getTrouble()).toBe(false);
    t.fire();
    t.answers[1]?.reject(network);
    await settle();
    expect(t.live().map((x) => x.ms)).toEqual([backoffDelay(2)]);
    expect(t.store.getTrouble()).toBe(true);
    t.fire();
    t.answers[2]?.resolve(changes());
    await settle();
    expect(t.live().map((x) => x.ms)).toEqual([POLL_INTERVAL_MS]);
    expect(t.store.getTrouble()).toBe(false);
  });

  it("caps the back-off", () => {
    expect(backoffDelay(0)).toBe(5_000);
    expect(backoffDelay(1)).toBe(10_000);
    expect(backoffDelay(3)).toBe(40_000);
    expect(backoffDelay(10)).toBe(60_000);
  });

  it("stops polling after a 401 (the browser is going to the phrase page)", async () => {
    const t = setup();
    await t.store.start();
    t.fire();
    t.answers[0]?.reject(new ApiError(401, "signed_out", "Please sign in again."));
    await settle();
    expect(t.live()).toHaveLength(0);
    t.handlers()?.focus();
    expect(t.calls).toHaveLength(1);
  });

  it("pauses while hidden and polls once on becoming visible or on focus", async () => {
    const t = setup();
    await t.store.start();
    t.env.visible = false;
    t.handlers()?.hidden();
    expect(t.live()).toHaveLength(0);
    t.env.visible = true;
    t.handlers()?.visible();
    expect(t.calls).toHaveLength(1);
    t.answers[0]?.resolve(changes());
    await settle();
    t.handlers()?.focus();
    expect(t.calls).toHaveLength(2);
    t.answers[1]?.resolve(changes());
    await settle();
    // While hidden, a finished poll schedules nothing.
    t.env.visible = false;
    t.handlers()?.focus();
    t.answers[2]?.resolve(changes());
    await settle();
    expect(t.live()).toHaveLength(0);
  });

  it("moves today on when the local date rolls over", async () => {
    const t = setup();
    await t.store.start();
    t.env.today = "2026-10-15";
    t.fire();
    t.answers[0]?.resolve(changes());
    await settle();
    expect(t.store.getState()?.today).toBe("2026-10-15");
  });
});

describe("PlannerStore changes", () => {
  it("shows an optimistic change at once and keeps the answer", async () => {
    const t = setup(bootstrap({ notes: [note({ id: "N1", x: 0, y: 0 })] }));
    await t.store.start();
    const answer = deferred<MutationResponse<NoteView>>();
    const done = t.store.change("note", "N1", { x: 100, y: 50 }, () => answer.promise);
    expect(t.store.getState()?.notes.get("N1")).toMatchObject({ x: 100, y: 50 });
    expect(t.store.getState()?.pending.get("note:N1")).toBe(1);
    answer.resolve({ row: note({ id: "N1", x: 100, y: 50, updated_at: "2026-10-14T09:00:00.000Z" }), event: event({ seq: 40 }) });
    await done;
    expect(t.store.getState()?.notes.get("N1")?.updated_at).toBe("2026-10-14T09:00:00.000Z");
    expect(t.store.getState()?.pending.size).toBe(0);
  });

  it("keeps a newer row the feed held back while the change was in flight", async () => {
    const t = setup(bootstrap({ notes: [note({ id: "N1", title: "Old" })] }));
    await t.store.start();
    const answer = deferred<MutationResponse<NoteView>>();
    const done = t.store.change("note", "N1", { x: 100 }, () => answer.promise);
    // Our move commits at seq 11, the other person's rename at 12, and a poll
    // brings both while our request is still waiting for its answer.
    t.store.pollNow();
    t.answers[0]?.resolve(changes({
      events: [event({ seq: 11 }), event({ seq: 12, actor_user_id: "OTHER" })],
      notes: [note({ id: "N1", x: 100, title: "New" })],
      cursor: "E12",
    }));
    await settle();
    expect(t.store.getState()?.notes.get("N1")).toMatchObject({ x: 100, title: "Old" });
    answer.resolve({ row: note({ id: "N1", x: 100, title: "Old" }), event: event({ seq: 11 }) });
    await done;
    expect(t.store.getState()?.notes.get("N1")).toMatchObject({ x: 100, title: "New" });
  });

  it("restores the newest row the feed held back when the change fails", async () => {
    const t = setup(bootstrap({ notes: [note({ id: "N1", title: "Old" })] }));
    await t.store.start();
    const answer = deferred<MutationResponse<NoteView>>();
    const done = t.store.change("note", "N1", { x: 100 }, () => answer.promise);
    t.store.pollNow();
    t.answers[0]?.resolve(changes({ events: [event({ seq: 11 })], notes: [note({ id: "N1", title: "New" })], cursor: "E11" }));
    await settle();
    const failure = new ApiError(409, "conflict", "Someone else changed this at the same moment.");
    answer.reject(failure);
    await expect(done).rejects.toBe(failure);
    expect(t.store.getState()?.notes.get("N1")).toMatchObject({ x: 0, title: "New" });
  });

  it("puts the row back and rethrows when the change fails", async () => {
    const t = setup(bootstrap({ notes: [note({ id: "N1", x: 0, y: 0 })] }));
    await t.store.start();
    const failure = new ApiError(409, "conflict", "Someone else changed this at the same moment.");
    await expect(t.store.change("note", "N1", { x: 100 }, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(t.store.getState()?.notes.get("N1")?.x).toBe(0);
    expect(t.store.getState()?.pending.size).toBe(0);
    // A failed change asks the feed for the latest state.
    expect(t.calls).toHaveLength(1);
  });
});
