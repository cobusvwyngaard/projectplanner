// Claude runs as the Activity and Inbox views show them: how many events each
// run wrote and which captures it worked from.

import type { RunDetailResponse, RunView } from "../../shared/api";
import type { Id, Run, Timestamp } from "../../shared/types";
import { NotFoundError } from "../lib/errors";
import { MAX_PARAMS, getRow, rowsByIds, runEvents, selectInChunks } from "./queries";
import { eventRefs, titlesFor } from "./titles";

interface RunStats {
  counts: Map<Id, number>;
  captures: Map<Id, Set<Id>>;
}

/**
 * Event counts and capture ids of runs. A run's captures are those it
 * claimed or processed, plus those its events name as sources.
 */
async function runStats(db: D1Database, runIds: readonly Id[]): Promise<RunStats> {
  const [counts, captures] = await Promise.all([
    selectInChunks<{ run_id: Id; n: number }>(db, runIds, (part, marks) =>
      db
        .prepare(`SELECT run_id, COUNT(*) AS n FROM events WHERE run_id IN (${marks}) GROUP BY run_id`)
        .bind(...part),
    ),
    selectInChunks<{ run_id: Id; capture_id: Id }>(
      db,
      runIds,
      (part, marks) =>
        db
          .prepare(
            `SELECT claimed_by_run_id AS run_id, id AS capture_id FROM captures WHERE claimed_by_run_id IN (${marks})
             UNION
             SELECT processed_by_run_id, id FROM captures WHERE processed_by_run_id IN (${marks})
             UNION
             SELECT e.run_id, c.id FROM events AS e
               JOIN json_each(e.source_capture_ids) AS j
               JOIN captures AS c ON c.id = j.value
             WHERE e.run_id IN (${marks}) AND e.source_capture_ids IS NOT NULL`,
          )
          .bind(...part, ...part, ...part),
      Math.floor(MAX_PARAMS / 3),
    ),
  ]);
  const stats: RunStats = { counts: new Map(counts.map((c) => [c.run_id, c.n])), captures: new Map() };
  for (const { run_id, capture_id } of captures) {
    const set = stats.captures.get(run_id) ?? new Set<Id>();
    set.add(capture_id);
    stats.captures.set(run_id, set);
  }
  return stats;
}

function toView(run: Run, stats: RunStats): RunView {
  return {
    ...run,
    event_count: stats.counts.get(run.id) ?? 0,
    capture_ids: [...(stats.captures.get(run.id) ?? [])].sort(),
  };
}

/** Runs with their event counts and capture ids. */
export async function runViews(db: D1Database, runs: readonly Run[]): Promise<RunView[]> {
  const stats = await runStats(db, runs.map((r) => r.id));
  return runs.map((run) => toView(run, stats));
}

/** Runs, newest first; `before` pages by started_at. */
export async function listRuns(
  db: D1Database,
  options: { before?: Timestamp | undefined; limit: number },
): Promise<RunView[]> {
  const where = options.before === undefined ? "" : "WHERE started_at < ?";
  const params = options.before === undefined ? [options.limit] : [options.before, options.limit];
  const { results } = await db
    .prepare(
      `SELECT id, user_id, intent, summary, started_at, finished_at FROM runs ${where}
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .bind(...params)
    .all<Run>();
  return runViews(db, results);
}

/** A run with its events (oldest first), captures and titles. */
export async function runDetail(db: D1Database, runId: Id): Promise<RunDetailResponse> {
  const run = await getRow(db, "run", runId);
  if (!run) throw new NotFoundError("No such run.");
  const [stats, events] = await Promise.all([runStats(db, [run.id]), runEvents(db, run.id)]);
  const view = toView(run, stats);
  const [captures, titles] = await Promise.all([
    rowsByIds(db, "capture", view.capture_ids),
    titlesFor(db, eventRefs(events)),
  ]);
  return { run: view, events, captures, titles };
}
