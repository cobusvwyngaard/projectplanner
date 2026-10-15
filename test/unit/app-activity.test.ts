// The Activity view's filters and paging.

import { describe, expect, it } from "vitest";
import type { EventsResponse, RunView } from "../../src/shared/api";
import {
  NO_FILTERS,
  PAGE_SIZE,
  appendPage,
  appendRuns,
  eventsQuery,
  feedFrom,
  hasFilters,
  rangeProblem,
  refreshFeed,
} from "../../src/app/lib/activity";
import { T0, event } from "./app-fixtures";

function page(seqs: number[], next: number | null = null, titles: Record<string, string> = {}): EventsResponse {
  return { events: seqs.map((seq) => event({ seq })), runs: [], titles, next };
}

const seqs = (feed: { events: { seq: number }[] }) => feed.events.map((e) => e.seq);

describe("activity filters", () => {
  it("asks for everything by default", () => {
    expect(eventsQuery(NO_FILTERS)).toEqual({ limit: PAGE_SIZE });
    expect(hasFilters(NO_FILTERS)).toBe(false);
  });

  it("turns each filter into its query parameter", () => {
    const filters = { who: "human" as const, userId: "U2", runId: "R1", from: "2026-10-01", to: "2026-10-14" };
    expect(eventsQuery(filters, 40)).toEqual({
      limit: PAGE_SIZE,
      actor: "human",
      user_id: "U2",
      run_id: "R1",
      from: "2026-10-01",
      to: "2026-10-14",
      before: 40,
    });
    expect(hasFilters({ ...NO_FILTERS, who: "claude" })).toBe(true);
  });

  it("refuses a range that ends before it starts", () => {
    expect(rangeProblem({ from: "2026-10-14", to: "2026-10-01" })).toMatch(/start date/);
    expect(rangeProblem({ from: "2026-10-01", to: "2026-10-01" })).toBeNull();
    expect(rangeProblem({ from: "2026-10-01", to: "" })).toBeNull();
  });
});

describe("feed paging", () => {
  it("adds older pages at the end without repeating events", () => {
    const feed = appendPage(feedFrom(page([5, 4, 3], 3)), page([3, 2, 1]));
    expect(seqs(feed)).toEqual([5, 4, 3, 2, 1]);
    expect(feed.next).toBeNull();
  });

  it("puts new events on top and keeps the paging of older pages", () => {
    const loaded = appendPage(feedFrom(page([6, 5], 5)), page([4, 3], 3));
    const fresh = refreshFeed(loaded, page([8, 7, 6], 6, { "note:N1": "Renamed" }));
    expect(seqs(fresh)).toEqual([8, 7, 6, 5, 4, 3]);
    expect(fresh.next).toBe(3);
    expect(fresh.titles["note:N1"]).toBe("Renamed");
  });

  it("starts again when more than a page arrived since the last refresh", () => {
    const fresh = refreshFeed(feedFrom(page([2, 1])), page([90, 89], 89));
    expect(seqs(fresh)).toEqual([90, 89]);
    expect(fresh.next).toBe(89);
  });

  it("fills an empty feed from the refresh", () => {
    const fresh = refreshFeed(feedFrom(page([])), page([2, 1], 1));
    expect(seqs(fresh)).toEqual([2, 1]);
    expect(fresh.next).toBe(1);
  });
});

describe("appendRuns", () => {
  const run = (id: string, started_at: string): RunView => ({
    id,
    user_id: "U1",
    intent: `Run ${id}`,
    summary: null,
    started_at,
    finished_at: null,
    event_count: 0,
    capture_ids: [],
  });

  it("keeps runs newest first and updates runs already shown", () => {
    const shown = [run("R2", "2026-10-14T08:00:00.000Z"), run("R1", T0)];
    const updated = { ...run("R2", "2026-10-14T08:00:00.000Z"), summary: "Done" };
    const merged = appendRuns(shown, [updated, run("R0", "2026-10-13T08:00:00.000Z")]);
    expect(merged.map((r) => r.id)).toEqual(["R2", "R1", "R0"]);
    expect(merged[0]?.summary).toBe("Done");
  });
});
