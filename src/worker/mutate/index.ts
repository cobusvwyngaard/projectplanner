// The single write path for board data (SPEC section 4.1).
//
// Every change to notes, tasks, links, labels, captures, users and settings
// goes through mutate()/mutateMany(). For each change it reads the current row,
// works out the field-level diff and commits, in ONE db.batch() transaction:
//
//   1. the entity write, conditional on the fields it changes still holding
//      the values that were read (optimistic concurrency);
//   2. a write_guard row that aborts the transaction if that write missed;
//   3. the events row with the before/after diff.
//
// So the entity write and its event commit together or not at all. Claude's
// writes additionally carry a guard that its run is still open.

import type { ItemRef, PlannerEvent } from "../../shared/types";
import { ConflictError, ForbiddenError, NotFoundError, RunNotOpenError, ValidationError } from "../lib/errors";
import { HOUR_MS, addMs, iso } from "../lib/time";
import { ulid } from "../lib/ulid";
import type { Actor } from "./actor";
import { CLAUDE_ENTITIES, ENTITIES, type EntitySpec, type MutableEntity } from "./entities";
import { eventStatement, toPlannerEvent, type NewEvent } from "./events";

export type Value = string | number | null;
export type Row = Record<string, Value>;

/** Claude runs expire this long after they start (SPEC section 7). */
export const RUN_MAX_AGE_MS = 2 * HOUR_MS;

const MAX_ATTEMPTS = 3;

interface Common {
  /** Captures this change was based on (Claude writes) */
  sourceCaptureIds?: readonly string[];
  /** Preconditions on the current row; a mismatch is a ConflictError */
  expect?: Row;
}

export type Mutation =
  | (Common & { entity: MutableEntity; action: "create"; id?: string; values: Row })
  | (Common & { entity: "link"; action: "link"; a: ItemRef; b: ItemRef })
  | (Common & { entity: MutableEntity; action: "update"; id: string; patch: Row })
  | (Common & { entity: MutableEntity; action: "archive" | "unarchive"; id: string })
  | (Common & { entity: "link"; action: "unlink"; id: string })
  | (Common & { entity: "task"; action: "complete" | "reopen"; id: string })
  | (Common & { entity: MutableEntity; action: "revert"; id: string; patch: Row; revertsEventId: string });

export interface MutationResult {
  entity: MutableEntity;
  id: string;
  /** The row after the change (unchanged row for a no-op) */
  row: Row;
  /** The event written, or null when nothing changed */
  event: PlannerEvent | null;
}

export interface MutateOptions {
  now?: Date;
  /** Statements run first, inside the same transaction (e.g. inserting a run). */
  prelude?: D1PreparedStatement[];
}

/** Apply one change. See mutateMany(). */
export async function mutate(
  db: D1Database,
  actor: Actor,
  mutation: Mutation,
  options: MutateOptions = {},
): Promise<MutationResult> {
  const [result] = await mutateMany(db, actor, [mutation], options);
  if (!result) throw new Error("mutateMany returned no result");
  return result;
}

/**
 * Apply several changes atomically: all of them commit with their events in
 * one transaction, or none do. Later changes see the effect of earlier ones.
 */
export async function mutateMany(
  db: D1Database,
  actor: Actor,
  mutations: readonly Mutation[],
  options: MutateOptions = {},
): Promise<MutationResult[]> {
  checkActor(actor);
  for (let attempt = 1; ; attempt++) {
    const now = options.now ?? new Date();
    const ctx = new Context(db, actor, now);
    const prepared: Prepared[] = [];
    for (const m of mutations) prepared.push(await prepare(ctx, m));

    const statements: D1PreparedStatement[] = [...(options.prelude ?? [])];
    if (actor.kind === "claude") statements.push(runGuard(db, actor, now));
    const eventIndex = new Map<Prepared, number>();
    for (const p of prepared) {
      statements.push(...p.statements);
      if (p.event) {
        statements.push(eventStatement(db, p.event));
        eventIndex.set(p, statements.length - 1);
      }
    }

    if (statements.length > 0) {
      let results: D1Result[];
      try {
        results = await db.batch(statements);
      } catch (err) {
        const kind = classify(err);
        if (kind === "retry" && attempt < MAX_ATTEMPTS) continue;
        throw translate(err, kind);
      }
      return prepared.map((p) => {
        const index = eventIndex.get(p);
        const seq = index === undefined ? 0 : Number(results[index]?.meta.last_row_id ?? 0);
        return { entity: p.entity, id: p.id, row: p.row, event: p.event ? toPlannerEvent(p.event, seq) : null };
      });
    }
    return prepared.map((p) => ({ entity: p.entity, id: p.id, row: p.row, event: null }));
  }
}

/** Find a link between two items, archived or not. */
export async function findLink(db: D1Database, a: ItemRef, b: ItemRef): Promise<Row | null> {
  const [x, y] = canonicalPair(a, b);
  return db
    .prepare(`SELECT ${ENTITIES.link.columns.join(", ")} FROM links WHERE a_type = ? AND a_id = ? AND b_type = ? AND b_id = ?`)
    .bind(x.type, x.id, y.type, y.id)
    .first<Row>();
}

/** Links are stored with endpoints sorted so each pair is stored once. */
export function canonicalPair(a: ItemRef, b: ItemRef): [ItemRef, ItemRef] {
  const ka = `${a.type}:${a.id}`;
  const kb = `${b.type}:${b.id}`;
  if (ka === kb) throw new ValidationError("An item cannot be linked to itself.");
  return ka < kb ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------

interface Prepared {
  entity: MutableEntity;
  id: string;
  row: Row;
  statements: D1PreparedStatement[];
  event: NewEvent | null;
}

/** Rows read or written earlier in the same mutateMany() call. */
class Context {
  private readonly rows = new Map<string, Row | null>();
  readonly ts: string;

  constructor(
    readonly db: D1Database,
    readonly actor: Actor,
    readonly now: Date,
  ) {
    this.ts = iso(now);
  }

  async read(entity: MutableEntity, id: string): Promise<Row | null> {
    const key = `${entity}:${id}`;
    if (this.rows.has(key)) return this.rows.get(key) ?? null;
    const spec = ENTITIES[entity];
    const row = await this.db
      .prepare(`SELECT ${spec.columns.join(", ")} FROM ${spec.table} WHERE ${spec.key} = ?`)
      .bind(id)
      .first<Row>();
    this.rows.set(key, row);
    return row;
  }

  remember(entity: MutableEntity, id: string, row: Row): void {
    this.rows.set(`${entity}:${id}`, row);
  }

  async readLinkPair(a: ItemRef, b: ItemRef): Promise<Row | null> {
    for (const [key, row] of this.rows) {
      if (!key.startsWith("link:") || !row) continue;
      if (row.a_type === a.type && row.a_id === a.id && row.b_type === b.type && row.b_id === b.id) return row;
    }
    const row = await findLink(this.db, a, b);
    if (row) {
      const id = String(row.id);
      if (!this.rows.has(`link:${id}`)) this.rows.set(`link:${id}`, row);
      return this.rows.get(`link:${id}`) ?? null;
    }
    return null;
  }

  event(
    entity: MutableEntity,
    id: string,
    action: NewEvent["action"],
    before: Row | null,
    after: Row | null,
    m: Mutation,
    revertsEventId: string | null = null,
  ): NewEvent {
    const spec = ENTITIES[entity];
    return {
      id: ulid(this.now.getTime()),
      ts: this.ts,
      actor: this.actor,
      entityType: entity,
      entityId: id,
      action,
      before: before === null ? null : visible(spec, before),
      after: after === null ? null : visible(spec, after),
      sourceCaptureIds: m.sourceCaptureIds ?? null,
      revertsEventId,
    };
  }
}

function checkActor(actor: Actor): void {
  if (actor.kind === "human" && !actor.userId) throw new ForbiddenError("A person must be signed in.");
  if (actor.kind === "claude" && (!actor.userId || !actor.runId)) throw new RunNotOpenError();
}

function authorise(actor: Actor, m: Mutation, spec: EntitySpec): void {
  if (actor.kind === "claude") {
    if (!CLAUDE_ENTITIES.includes(m.entity)) {
      throw new ForbiddenError("Claude cannot change labels, settings or users.");
    }
    if (m.action === "archive" || m.action === "unarchive") {
      throw new ForbiddenError("Only people can archive or unarchive items.");
    }
  }
  if (m.action === "revert" && actor.kind !== "human") {
    throw new ForbiddenError("Only people can revert changes.");
  }
  if (m.action === "create" && !spec.creators.includes(actor.kind)) {
    throw new ForbiddenError(`This actor cannot create ${m.entity} records.`);
  }
  if ((m.action === "archive" || m.action === "unarchive") && spec.archive === null) {
    throw new ValidationError(`A ${m.entity} cannot be archived.`);
  }
  if ((m.action === "link" || m.action === "unlink") && actor.kind === "system") {
    throw new ForbiddenError("The system does not link items.");
  }
}

function checkValues(values: Row, allowed: readonly string[], entity: MutableEntity): void {
  for (const [field, value] of Object.entries(values)) {
    if (!allowed.includes(field)) throw new ValidationError(`Field "${field}" cannot be set on a ${entity}.`);
    const ok =
      value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    if (!ok) throw new ValidationError(`Field "${field}" has an invalid value.`);
  }
}

function checkExpect(m: Mutation, before: Row): void {
  if (!m.expect) return;
  for (const [field, value] of Object.entries(m.expect)) {
    if (!same(before[field], value)) {
      throw new ConflictError(`Expected ${m.entity} ${field} to be ${JSON.stringify(value)}.`, {
        field,
        expected: value,
        actual: before[field] ?? null,
      });
    }
  }
}

async function prepare(ctx: Context, m: Mutation): Promise<Prepared> {
  const spec = ENTITIES[m.entity];
  authorise(ctx.actor, m, spec);
  switch (m.action) {
    case "create":
      return prepareCreate(ctx, m, spec);
    case "link":
      return prepareLink(ctx, m);
    default:
      return prepareChange(ctx, m, spec);
  }
}

async function prepareCreate(
  ctx: Context,
  m: Extract<Mutation, { action: "create" }>,
  spec: EntitySpec,
): Promise<Prepared> {
  checkValues(m.values, [...spec.writable[ctx.actor.kind], ...spec.createOnly], m.entity);
  const id = spec.key === "id" ? (m.id ?? ulid(ctx.now.getTime())) : String(m.values[spec.key] ?? "");
  if (!id) throw new ValidationError(`A ${m.entity} needs a ${spec.key}.`);
  if (await ctx.read(m.entity, id)) throw new ConflictError(`That ${m.entity} already exists.`);

  const row: Row = { ...spec.defaults, ...m.values, [spec.key]: id };
  if (spec.columns.includes("created_at")) row.created_at = ctx.ts;
  if (spec.touch) row[spec.touch] = ctx.ts;
  if (m.entity === "task" && row.status === "done") {
    row.done_at = ctx.ts;
    row.done_by_user_id = ctx.actor.userId;
  }
  const columns = spec.columns.filter((c) => c in row);
  const statement = ctx.db
    .prepare(`INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((c) => row[c] ?? null));
  ctx.remember(m.entity, id, row);
  return {
    entity: m.entity,
    id,
    row,
    statements: [statement],
    event: ctx.event(m.entity, id, "create", null, row, m),
  };
}

async function prepareLink(ctx: Context, m: Extract<Mutation, { action: "link" }>): Promise<Prepared> {
  const [a, b] = canonicalPair(m.a, m.b);
  for (const end of [a, b]) {
    const row = await ctx.read(end.type, end.id);
    if (!row || row.archived_at !== null) throw new NotFoundError(`No open ${end.type} with id ${end.id}.`);
  }
  const existing = await ctx.readLinkPair(a, b);
  if (existing && existing.archived_at === null) {
    return { entity: "link", id: String(existing.id), row: existing, statements: [], event: null };
  }
  if (existing) {
    // Re-link a pair that was unlinked earlier.
    const id = String(existing.id);
    const after: Row = { ...existing, archived_at: null };
    ctx.remember("link", id, after);
    return {
      entity: "link",
      id,
      row: after,
      statements: conditionalUpdate(ctx.db, ENTITIES.link, id, existing, { archived_at: null }, null),
      event: ctx.event("link", id, "link", { archived_at: existing.archived_at ?? null }, { archived_at: null }, m),
    };
  }
  const id = ulid(ctx.now.getTime());
  const row: Row = {
    id,
    a_type: a.type,
    a_id: a.id,
    b_type: b.type,
    b_id: b.id,
    created_at: ctx.ts,
    archived_at: null,
  };
  const columns = ENTITIES.link.columns;
  const statement = ctx.db
    .prepare(`INSERT INTO links (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((c) => row[c] ?? null));
  ctx.remember("link", id, row);
  return { entity: "link", id, row, statements: [statement], event: ctx.event("link", id, "link", null, row, m) };
}

async function prepareChange(
  ctx: Context,
  m: Exclude<Mutation, { action: "create" | "link" }>,
  spec: EntitySpec,
): Promise<Prepared> {
  const before = await ctx.read(m.entity, m.id);
  if (!before) throw new NotFoundError(`No ${m.entity} with id ${m.id}.`);
  if (ctx.actor.kind === "claude" && spec.archive && before[spec.archive] !== null) {
    throw new NotFoundError(`No open ${m.entity} with id ${m.id}.`);
  }
  checkExpect(m, before);

  let action: NewEvent["action"] = m.action;
  let wanted: Row;
  let revertsEventId: string | null = null;
  switch (m.action) {
    case "update":
      checkValues(m.patch, spec.writable[ctx.actor.kind], m.entity);
      wanted = { ...m.patch };
      break;
    case "archive":
    case "unlink":
      wanted = { [spec.archive ?? "archived_at"]: ctx.ts };
      if (before[spec.archive ?? "archived_at"] !== null) wanted = {};
      break;
    case "unarchive":
      wanted = { [spec.archive ?? "archived_at"]: null };
      break;
    case "complete":
      wanted = { status: "done" };
      break;
    case "reopen":
      wanted = { status: "open" };
      break;
    case "revert": {
      const fixed = new Set([spec.key, "created_at", spec.touch]);
      checkValues(m.patch, spec.columns.filter((c) => !fixed.has(c)), m.entity);
      wanted = { ...m.patch };
      revertsEventId = m.revertsEventId;
      break;
    }
  }

  const changes: Row = {};
  for (const [field, value] of Object.entries(wanted)) {
    if (!same(before[field], value)) changes[field] = value;
  }
  // Ticking a task off records when and on whose behalf; reopening clears it.
  if (m.entity === "task" && m.action !== "revert" && "status" in changes) {
    const done = changes.status === "done";
    action = done ? "complete" : "reopen";
    const doneAt = done ? ctx.ts : null;
    const doneBy = done ? ctx.actor.userId : null;
    if (!same(before.done_at, doneAt)) changes.done_at = doneAt;
    if (!same(before.done_by_user_id, doneBy)) changes.done_by_user_id = doneBy;
  }

  if (Object.keys(changes).length === 0) {
    return { entity: m.entity, id: m.id, row: before, statements: [], event: null };
  }

  const after: Row = { ...before, ...changes };
  if (spec.touch) after[spec.touch] = ctx.ts;
  ctx.remember(m.entity, m.id, after);
  const beforeDiff: Row = {};
  for (const field of Object.keys(changes)) beforeDiff[field] = before[field] ?? null;
  return {
    entity: m.entity,
    id: m.id,
    row: after,
    statements: conditionalUpdate(ctx.db, spec, m.id, before, changes, spec.touch ? ctx.ts : null),
    event: ctx.event(m.entity, m.id, action, beforeDiff, changes, m, revertsEventId),
  };
}

/**
 * UPDATE that only applies if every changed field still holds the value read
 * earlier, followed by a guard that aborts the batch if it did not apply.
 */
function conditionalUpdate(
  db: D1Database,
  spec: EntitySpec,
  id: string,
  before: Row,
  changes: Row,
  touchedAt: string | null,
): D1PreparedStatement[] {
  const fields = Object.keys(changes);
  const sets = fields.map((f) => `${f} = ?`);
  const setValues: Value[] = fields.map((f) => changes[f] ?? null);
  if (spec.touch && touchedAt) {
    sets.push(`${spec.touch} = ?`);
    setValues.push(touchedAt);
  }
  const conditions = fields.map((f) => `${f} IS ?`);
  const update = db
    .prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE ${spec.key} = ? AND ${conditions.join(" AND ")}`)
    .bind(...setValues, id, ...fields.map((f) => before[f] ?? null));
  const guard = db
    .prepare(`INSERT INTO write_guard (expected, actual, reason) VALUES (1, changes(), 'stale')`);
  return [update, guard];
}

/** Aborts the batch unless the actor's run exists, is theirs, is open and is under 2 hours old. */
function runGuard(db: D1Database, actor: Actor, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO write_guard (expected, actual, reason)
       SELECT 1, COUNT(*), 'run' FROM runs
       WHERE id = ? AND user_id = ? AND finished_at IS NULL AND started_at >= ?`,
    )
    .bind(actor.runId, actor.userId, iso(addMs(now, -RUN_MAX_AGE_MS)));
}

function visible(spec: EntitySpec, row: Row): Row {
  const out: Row = {};
  for (const [field, value] of Object.entries(row)) {
    if (spec.hidden.includes(field)) continue;
    out[field] = value;
  }
  return out;
}

function same(a: Value | undefined, b: Value | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

type Failure = "retry" | "run" | "claim" | "foreign_key" | "constraint" | "other";

function classify(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("write_guard:stale") || message.includes("UNIQUE constraint failed")) return "retry";
  if (message.includes("write_guard:run")) return "run";
  if (message.includes("write_guard:claim")) return "claim";
  if (message.includes("FOREIGN KEY constraint failed")) return "foreign_key";
  if (message.includes("CHECK constraint failed") || message.includes("NOT NULL constraint failed")) return "constraint";
  return "other";
}

function translate(err: unknown, kind: Failure): Error {
  switch (kind) {
    case "retry":
      return new ConflictError("Someone else changed this at the same moment. Please try again.");
    case "run":
      return new RunNotOpenError();
    case "claim":
      return new ConflictError("Some of those captures have already been claimed by another run.");
    case "foreign_key":
      return new ValidationError("A referenced item, label or person does not exist.");
    case "constraint":
      return new ValidationError("A value is not allowed for this field.");
    case "other":
      return err instanceof Error ? err : new Error(String(err));
  }
}
