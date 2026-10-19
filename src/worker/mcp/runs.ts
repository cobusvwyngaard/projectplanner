// Claude runs (SPEC section 7): starting, finishing, expiring, and the
// open-run check. The runs table is bookkeeping, not board data: it is
// written here directly, never through mutate(); every capture it touches
// still goes through mutate() so the change is an event.

import { ConflictError, NotFoundError, RunNotOpenError, ValidationError } from "../lib/errors";
import { addMs, iso } from "../lib/time";
import { ulid } from "../lib/ulid";
import { claudeActor, SYSTEM_ACTOR } from "../mutate/actor";
import { mutateMany, RUN_MAX_AGE_MS, type Mutation } from "../mutate/index";

/** Everything a tool needs to act for one user at one moment. */
export interface ToolContext {
  db: D1Database;
  userId: string;
  now: Date;
}

/** A run that exists, belongs to `userId`, is unfinished and is under 2 hours old. */
export async function getOpenRun(
  db: D1Database,
  userId: string,
  runId: string,
  now: Date,
): Promise<{ id: string; user_id: string; started_at: string }> {
  const run = await db
    .prepare(`SELECT id, user_id, started_at FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ id: string; user_id: string; started_at: string; finished_at: string | null }>();
  if (!run) throw new NotFoundError("No such run.");
  if (run.user_id !== userId) throw new RunNotOpenError();
  const started = new Date(run.started_at).getTime();
  if (now.getTime() - started > RUN_MAX_AGE_MS) throw new RunNotOpenError();
  return run;
}

/**
 * Open a run and claim its captures in one transaction: the run row is
 * inserted as the prelude of the same mutateMany() batch that claims, and
 * each claim carries `expect {inbox_status: 'new'}`. If another run claimed
 * any capture first, the whole batch rolls back: no run, no claims.
 */
export async function startRun(
  ctx: ToolContext,
  input: { intent: string; capture_ids: string[] },
): Promise<{ run_id: string; claimed: string[]; expires_at: string }> {
  const { db, userId, now } = ctx;
  const ids = input.capture_ids;
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("Capture ids must be unique.");
  }
  const captures =
    ids.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT id, kind, transcript_status, inbox_status FROM captures WHERE id IN (${ids.map(() => "?").join(", ")})`,
            )
            .bind(...ids)
            .all<{ id: string; kind: string; transcript_status: string; inbox_status: string }>()
        ).results;
  const byId = new Map(captures.map((c) => [c.id, c]));
  const bad: string[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    const ready = c !== undefined && (c.kind === "text" || c.transcript_status === "done");
    if (!c || c.inbox_status !== "new" || !ready) bad.push(id);
  }
  if (bad.length > 0) {
    throw new ValidationError(`These captures cannot be claimed: ${bad.join(", ")}.`, { ids: bad });
  }

  const runId = ulid(now.getTime());
  const startedAt = iso(now);
  const ops: Mutation[] = ids.map((id) => ({
    entity: "capture",
    action: "update",
    id,
    patch: { inbox_status: "claimed", claimed_by_run_id: runId, claimed_at: startedAt },
    expect: { inbox_status: "new" },
    sourceCaptureIds: ids,
  }));
  const prelude = [
    db
      .prepare(`INSERT INTO runs (id, user_id, intent, started_at, finished_at) VALUES (?, ?, ?, ?, NULL)`)
      .bind(runId, userId, input.intent, startedAt),
  ];
  try {
    await mutateMany(db, claudeActor(userId, runId), ops, { prelude, now });
  } catch (err) {
    // Only a claim conflict (a refused claim or a stale expect on the capture)
    // means another run got there first; every other error reaches the caller.
    if (err instanceof ConflictError) {
      throw new ConflictError("Some of those captures were just claimed by another run.");
    }
    throw err;
  }
  return { run_id: runId, claimed: [...ids], expires_at: iso(addMs(now, RUN_MAX_AGE_MS)) };
}

/**
 * Finish an open run: first release every capture it still holds (back to
 * 'new'; captures already marked keep their processed/ignored state), then
 * set finished_at and the summary.
 */
export async function finishRun(
  ctx: ToolContext,
  input: { run_id: string; summary: string },
): Promise<{ released: string[] }> {
  const { db, userId, now } = ctx;
  await getOpenRun(db, userId, input.run_id, now);
  const { results } = await db
    .prepare(`SELECT id FROM captures WHERE claimed_by_run_id = ?`)
    .bind(input.run_id)
    .all<{ id: string }>();
  const claimedIds = results.map((r) => r.id);
  if (claimedIds.length > 0) {
    const ops: Mutation[] = claimedIds.map((id) => ({
      entity: "capture",
      action: "update",
      id,
      patch: { inbox_status: "new", claimed_by_run_id: null, claimed_at: null },
      sourceCaptureIds: [],
    }));
    await mutateMany(db, claudeActor(userId, input.run_id), ops, { now });
  }
  const res = await db
    .prepare(`UPDATE runs SET finished_at = ?, summary = ? WHERE id = ? AND finished_at IS NULL`)
    .bind(iso(now), input.summary, input.run_id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw new RunNotOpenError();
  return { released: claimedIds };
}

/** Close at most 20 runs that ran out of time; their captures go back to the inbox. */
export async function closeExpiredRuns(env: { DB: D1Database }, now: Date): Promise<void> {
  const cutoff = iso(addMs(now, -RUN_MAX_AGE_MS));
  const { results } = await env.DB
    .prepare(`SELECT id FROM runs WHERE finished_at IS NULL AND started_at < ? ORDER BY started_at ASC LIMIT 20`)
    .bind(cutoff)
    .all<{ id: string }>();
  for (const run of results) {
    const { results: claimed } = await env.DB
      .prepare(`SELECT id FROM captures WHERE claimed_by_run_id = ?`)
      .bind(run.id)
      .all<{ id: string }>();
    const ops: Mutation[] = claimed.map((r) => ({
      entity: "capture",
      action: "update",
      id: r.id,
      patch: { inbox_status: "new", claimed_by_run_id: null, claimed_at: null },
      sourceCaptureIds: [],
    }));
    if (ops.length > 0) {
      try {
        await mutateMany(env.DB, SYSTEM_ACTOR, ops, { now });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error(`closeExpiredRuns ${run.id} release failed: ${e.name}: ${e.message}`);
        // Leave the run open: its captures are still claimed by it, and the
        // next scheduled call tries the release again.
        continue;
      }
    }
    await env.DB
      .prepare(`UPDATE runs SET finished_at = ?, summary = ? WHERE id = ? AND finished_at IS NULL`)
      .bind(
        iso(now),
        "Closed automatically after 2 hours; its unprocessed captures went back to the inbox.",
        run.id,
      )
      .run();
  }
}
