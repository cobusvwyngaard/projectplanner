// The Activity view (SPEC 5): every change, newest first, filtered by who
// made it (humans only, Claude only), person, Claude run and date range, with
// Revert on each; and Claude's runs with "Show changes" and "Revert whole run".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunView } from "../../shared/api";
import { actorLabel } from "../../shared/actors";
import { formatDateTime } from "../../shared/format";
import type { Id, PlannerEvent } from "../../shared/types";
import { api, errorMessage } from "../api";
import { EventEntry, RevertButton, RevertConflicts, useRevert } from "../components/events";
import type { DescribeContext } from "../lib/events";
import {
  NO_FILTERS,
  PAGE_SIZE,
  WHO_FILTERS,
  appendPage,
  appendRuns,
  eventsQuery,
  feedFrom,
  hasFilters,
  rangeProblem,
  refreshFeed,
  type ActivityFilters,
  type Feed,
} from "../lib/activity";
import { openItem } from "../router";
import { usePlanner } from "../store";
import { reportError } from "../toast";

type ActivityTab = "changes" | "runs";

const TABS: readonly { id: ActivityTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "runs", label: "Claude runs" },
];

export function ActivityView() {
  const [tab, setTab] = useState<ActivityTab>("changes");
  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);

  const showRun = useCallback((runId: Id) => {
    setFilters({ ...NO_FILTERS, runId });
    setTab("changes");
  }, []);

  return (
    <div className="page activity">
      <header className="page-head">
        <h1>Activity</h1>
        <div className="segmented" role="tablist" aria-label="Activity">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`activity-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="activity-panel"
              className="segment"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div id="activity-panel" role="tabpanel" aria-labelledby={`activity-tab-${tab}`}>
        {tab === "changes" ? (
          <ChangesFeed filters={filters} onFilters={setFilters} onShowRun={showRun} />
        ) : (
          <RunsList onShowRun={showRun} />
        )}
      </div>
    </div>
  );
}

function useDescribeContext(titles: Readonly<Record<string, string>>): DescribeContext {
  const users = usePlanner((s) => s.users);
  const labels = usePlanner((s) => s.labels);
  return useMemo(() => ({ users, labels, titles }), [users, labels, titles]);
}

const NO_TITLES: Readonly<Record<string, string>> = {};

/** Notes and tasks open in the item panel (archived ones too, from their history). */
function opener(event: PlannerEvent): (() => void) | undefined {
  const type = event.entity_type;
  if (type !== "note" && type !== "task") return undefined;
  return () => openItem({ type, id: event.entity_id });
}

function ChangesFeed({
  filters,
  onFilters,
  onShowRun,
}: {
  filters: ActivityFilters;
  onFilters: (filters: ActivityFilters) => void;
  onShowRun: (runId: Id) => void;
}) {
  const users = usePlanner((s) => s.users);
  const cursor = usePlanner((s) => s.cursor);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const problem = rangeProblem(filters);
  // Answers for filters that are no longer shown are dropped.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setFeed(null);
    setError(null);
    if (rangeProblem(filters)) return;
    api.events(eventsQuery(filters)).then(
      (page) => {
        if (generation.current === mine) setFeed(feedFrom(page));
      },
      (err: unknown) => {
        if (generation.current === mine) setError(errorMessage(err));
      },
    );
  }, [filters]);

  /** Fetch the newest page again and put new events on top. */
  const refresh = useCallback(() => {
    const mine = generation.current;
    if (rangeProblem(filters)) return;
    api.events(eventsQuery(filters)).then(
      (page) => {
        if (generation.current === mine) setFeed((shown) => (shown ? refreshFeed(shown, page) : feedFrom(page)));
      },
      // The poller already says when the planner cannot be reached.
      () => undefined,
    );
  }, [filters]);

  // New changes reach the store through the poller; show them here too.
  const loaded = feed !== null;
  const lastCursor = useRef(cursor);
  useEffect(() => {
    if (lastCursor.current === cursor) return;
    lastCursor.current = cursor;
    if (loaded) refresh();
  }, [cursor, loaded, refresh]);

  const loadMore = async () => {
    if (!feed || feed.next === null) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.events(eventsQuery(filters, feed.next));
      if (generation.current === mine) setFeed((shown) => (shown ? appendPage(shown, page) : feedFrom(page)));
    } catch (err) {
      reportError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const ctx = useDescribeContext(feed?.titles ?? NO_TITLES);
  const runIntent = filters.runId !== null ? feed?.runs.get(filters.runId)?.intent : undefined;
  const set = (patch: Partial<ActivityFilters>) => onFilters({ ...filters, ...patch });

  return (
    <>
      <div className="filters" role="group" aria-label="Filters">
        <div className="segmented" role="group" aria-label="Who made the change">
          {WHO_FILTERS.map((w) => (
            <button
              key={w.id}
              type="button"
              className="segment"
              aria-pressed={filters.who === w.id}
              onClick={() => set({ who: w.id })}
            >
              {w.label}
            </button>
          ))}
        </div>
        <label className="inline-label">
          <span>Person</span>
          <select className="input select" aria-label="Person" value={filters.userId ?? ""} onChange={(e) => set({ userId: e.target.value || null })}>
            <option value="">Everyone</option>
            {[...users.values()].map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </label>
        <div className="date-range">
          <label className="inline-label">
            <span>From</span>
            <input
              className="input input--date"
              type="date"
              aria-label="From"
              value={filters.from}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => set({ from: e.target.value })}
            />
          </label>
          <label className="inline-label">
            <span>To</span>
            <input
              className="input input--date"
              type="date"
              aria-label="To"
              value={filters.to}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => set({ to: e.target.value })}
            />
          </label>
        </div>
        {filters.runId !== null && (
          <span className="filter-chip">
            <span>Run: {runIntent ?? "one Claude run"}</span>
            <button type="button" className="link-button" onClick={() => set({ runId: null })}>
              Show all runs
            </button>
          </span>
        )}
        {hasFilters(filters) && (
          <button type="button" className="button button--quiet" onClick={() => onFilters(NO_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {!problem && !error && feed === null && <p className="muted">Loading the activity…</p>}
      {feed && feed.events.length === 0 && (
        <p className="empty">{hasFilters(filters) ? "No changes match these filters." : "Nothing has happened yet."}</p>
      )}
      {feed && feed.events.length > 0 && (
        <ol className="feed" aria-label="Changes, newest first">
          {feed.events.map((event) => (
            <EventEntry
              key={event.id}
              event={event}
              ctx={ctx}
              extras={feed}
              onOpenTitle={opener(event)}
              onRunClick={onShowRun}
              onReverted={refresh}
            />
          ))}
        </ol>
      )}
      {feed && feed.next !== null && (
        <div className="load-more">
          <button type="button" className="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}

function RunsList({ onShowRun }: { onShowRun: (runId: Id) => void }) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirst = useCallback(() => {
    api.runs({ limit: PAGE_SIZE }).then(
      ({ runs: page }) => {
        setRuns((shown) => (shown ? appendRuns(shown, page) : page));
        setMore((had) => had || page.length === PAGE_SIZE);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  useEffect(loadFirst, [loadFirst]);

  const loadMore = async () => {
    const last = runs?.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const { runs: page } = await api.runs({ before: last.started_at, limit: PAGE_SIZE });
      setRuns((shown) => appendRuns(shown ?? [], page));
      setMore(page.length === PAGE_SIZE);
    } catch (err) {
      reportError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  if (error) {
    return (
      <p className="notice notice--error" role="alert">
        {error}
      </p>
    );
  }
  if (runs === null) return <p className="muted">Loading Claude's runs…</p>;
  if (runs.length === 0) {
    return (
      <p className="empty">
        No Claude runs yet. When Claude organises the planner through the connector, each run shows here with its
        summary.
      </p>
    );
  }
  return (
    <>
      <ul className="runs">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} onShowRun={onShowRun} onReverted={loadFirst} />
        ))}
      </ul>
      {more && (
        <div className="load-more">
          <button type="button" className="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}

function RunCard({ run, onShowRun, onReverted }: { run: RunView; onShowRun: (runId: Id) => void; onReverted: () => void }) {
  const users = usePlanner((s) => s.users);
  const ctx = useDescribeContext(NO_TITLES);
  const revert = useRevert(
    (confirm) => api.revertRun(run.id, confirm),
    onReverted,
    () => api.run(run.id).then((detail) => detail.titles),
  );
  const captures = run.capture_ids.length;
  return (
    <li className="run-card">
      <div className="run-card-head">
        <h2 className="run-intent">{run.intent}</h2>
        <span className="badge badge--claude">{actorLabel({ kind: "claude", user_id: run.user_id }, users)}</span>
      </div>
      {run.summary ? (
        <p className="run-summary">{run.summary}</p>
      ) : (
        <p className="muted small">{run.finished_at ? "Finished without a summary." : "Not finished yet."}</p>
      )}
      <dl className="facts">
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(run.started_at)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{run.finished_at ? formatDateTime(run.finished_at) : "Still open"}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{run.event_count}</dd>
        </div>
        <div>
          <dt>Captures</dt>
          <dd>{captures}</dd>
        </div>
      </dl>
      <div className="button-row">
        <button type="button" className="button" onClick={() => onShowRun(run.id)}>
          Show changes
        </button>
        {run.event_count > 0 && <RevertButton revert={revert} label="Revert whole run" title="Undo every change this run made" />}
      </div>
      <RevertConflicts revert={revert} ctx={ctx} />
    </li>
  );
}
