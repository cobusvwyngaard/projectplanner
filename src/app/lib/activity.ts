// The Activity view's filters and paging (SPEC 5): who (everyone, humans
// only, Claude only), person, run and a date range, turned into a
// GET /api/events query; pages of the feed merged as they load.

import type { EventsResponse, RunView } from "../../shared/api";
import type { Id, LocalDate, PlannerEvent, Run } from "../../shared/types";
import type { EventsQuery } from "../api";

export type WhoFilter = "all" | "human" | "claude";

export const WHO_FILTERS: readonly { id: WhoFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "human", label: "Humans only" },
  { id: "claude", label: "Claude only" },
];

export interface ActivityFilters {
  who: WhoFilter;
  /** A person: their own actions and Claude's on their behalf (narrowed by `who`) */
  userId: Id | null;
  runId: Id | null;
  /** Local dates, inclusive; "" when not set */
  from: LocalDate | "";
  to: LocalDate | "";
}

export const NO_FILTERS: ActivityFilters = { who: "all", userId: null, runId: null, from: "", to: "" };

export const PAGE_SIZE = 50;

/** Why the date range cannot be used, or null when it is fine. */
export function rangeProblem(filters: Pick<ActivityFilters, "from" | "to">): string | null {
  if (filters.from !== "" && filters.to !== "" && filters.from > filters.to) {
    return "The start date must be on or before the end date.";
  }
  return null;
}

/** The /api/events query for these filters; `before` asks for the page after that seq. */
export function eventsQuery(filters: ActivityFilters, before?: number): EventsQuery {
  const query: EventsQuery = { limit: PAGE_SIZE };
  if (filters.who !== "all") query.actor = filters.who;
  if (filters.userId !== null) query.user_id = filters.userId;
  if (filters.runId !== null) query.run_id = filters.runId;
  if (filters.from !== "") query.from = filters.from;
  if (filters.to !== "") query.to = filters.to;
  if (before !== undefined) query.before = before;
  return query;
}

export function hasFilters(filters: ActivityFilters): boolean {
  return (
    filters.who !== "all" || filters.userId !== null || filters.runId !== null || filters.from !== "" || filters.to !== ""
  );
}

/** The loaded part of the feed, newest first. */
export interface Feed {
  events: PlannerEvent[];
  runs: ReadonlyMap<Id, Run>;
  titles: Readonly<Record<string, string>>;
  /** Seq to pass as `before` for the next page; null when everything is loaded */
  next: number | null;
}

function withRuns(runs: ReadonlyMap<Id, Run>, more: readonly Run[]): ReadonlyMap<Id, Run> {
  if (more.length === 0) return runs;
  const next = new Map(runs);
  for (const run of more) next.set(run.id, run);
  return next;
}

export function feedFrom(page: EventsResponse): Feed {
  return { events: page.events, runs: withRuns(new Map(), page.runs), titles: page.titles, next: page.next };
}

/** The next (older) page added to the end of the feed. */
export function appendPage(feed: Feed, page: EventsResponse): Feed {
  const known = new Set(feed.events.map((e) => e.id));
  return {
    events: [...feed.events, ...page.events.filter((e) => !known.has(e.id))],
    runs: withRuns(feed.runs, page.runs),
    titles: { ...feed.titles, ...page.titles },
    next: page.next,
  };
}

/**
 * The newest page fetched again (after a change arrived or a revert): new
 * events go on top and the older pages already loaded stay. When the new
 * page does not reach the events already shown (more than a page arrived in
 * between), it replaces the feed so there is no gap.
 */
export function refreshFeed(feed: Feed, page: EventsResponse): Feed {
  const newestShown = feed.events.reduce((max, e) => Math.max(max, e.seq), 0);
  const oldestFetched = page.events.reduce((min, e) => Math.min(min, e.seq), Number.POSITIVE_INFINITY);
  if (page.next !== null && oldestFetched > newestShown) return feedFrom(page);
  const byId = new Map(feed.events.map((e) => [e.id, e]));
  for (const e of page.events) byId.set(e.id, e);
  const events = [...byId.values()].sort((a, b) => b.seq - a.seq);
  return {
    events,
    runs: withRuns(feed.runs, page.runs),
    titles: { ...feed.titles, ...page.titles },
    // The oldest event shown is still the feed's, so its paging continues from there.
    next: feed.events.length > 0 ? feed.next : page.next,
  };
}

/** Runs (newest first) with an older page added; a run already shown is updated. */
export function appendRuns(shown: readonly RunView[], page: readonly RunView[]): RunView[] {
  const byId = new Map(shown.map((r) => [r.id, r]));
  for (const run of page) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
}
