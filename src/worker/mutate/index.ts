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

import type { ItemRef, ItemType, LinkDirection, PlannerEvent } from "../../shared/types";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RunNotOpenError,
  StaleWriteError,
  ValidationError,
} from "../lib/errors";
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

/** A dependency between two tasks: the one that must be done first, and the one that waits. */
export interface Dependency {
  before: ItemRef;
  after: ItemRef;
}

interface Common {
  /** Captures this change was based on (Claude writes) */
  sourceCaptureIds?: readonly string[];
  /** Preconditions on the current row; a mismatch is a ConflictError */
  expect?: Row;
}

/** Changes to a note or a task. A link is never updated this way: it is linked, relinked or unlinked. */
type RowChange = Exclude<MutableEntity, "link">;

export type Mutation =
  | (Common & { entity: MutableEntity; action: "create"; id?: string; values: Row })
  | (Common & {
      entity: "link";
      action: "link";
      a: ItemRef;
      b: ItemRef;
      /** True turns an open dependency of this pair into a plain connection; left out, an open link keeps its kind */
      related?: true;
    })
  | (Common & { entity: "link"; action: "link"; depends: Dependency })
  | (Common & { entity: RowChange; action: "update"; id: string; patch: Row })
  | (Common & { entity: "link"; action: "relink"; id: string; related: true })
  | (Common & { entity: "link"; action: "relink"; id: string; depends: Dependency })
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
  /** Things worth telling the person about, such as a task ticked off too early */
  warnings: string[];
}

export interface MutateOptions {
  now?: Date;
  /** Statements run first, inside the same transaction (e.g. inserting a run). */
  prelude?: D1PreparedStatement[];
  /**
   * Read again and retry when a write guard finds a row changed since it was
   * read (default true). With false a StaleWriteError is thrown at once, for
   * callers that must check the new state themselves (reverts).
   */
  retryStale?: boolean;
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
        if (kind === "retry" && options.retryStale !== false && attempt < MAX_ATTEMPTS) continue;
        throw translate(err, kind);
      }
      return prepared.map((p) => {
        const index = eventIndex.get(p);
        const seq = index === undefined ? 0 : Number(results[index]?.meta.last_row_id ?? 0);
        return {
          entity: p.entity,
          id: p.id,
          row: p.row,
          event: p.event ? toPlannerEvent(p.event, seq) : null,
          warnings: p.warnings,
        };
      });
    }
    return prepared.map((p) => ({ entity: p.entity, id: p.id, row: p.row, event: null, warnings: p.warnings }));
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
  warnings: string[];
}

/** Rows read or written earlier in the same mutateMany() call. */
class Context {
  private readonly rows = new Map<string, Row | null>();
  /** Dependency edges prepared earlier in this call, so one batch cannot make a circle. */
  private readonly edges: { linkId: string; from: string; to: string }[] = [];
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

  /** The dependency edges prepared earlier in this call, excluding one link. */
  pendingEdges(excludeLinkId: string | null): { linkId: string; from: string; to: string }[] {
    return this.edges
      .filter((edge) => edge.linkId !== excludeLinkId)
      .map((edge) => ({ linkId: edge.linkId, from: edge.from, to: edge.to }));
  }

  /** Remember the direction of a link prepared in this call. */
  rememberEdge(linkId: string, from: string | null, to: string | null): void {
    const index = this.edges.findIndex((edge) => edge.linkId === linkId);
    if (index >= 0) this.edges.splice(index, 1);
    if (from !== null && to !== null) this.edges.push({ linkId, from, to });
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
      throw new ForbiddenError("Claude cannot change labels, settings, users or email addresses.");
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
    throw new ValidationError(`This ${m.entity} cannot be archived.`);
  }
  if ((m.action === "link" || m.action === "unlink" || m.action === "relink") && actor.kind === "system") {
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
    case "relink":
      return prepareRelink(ctx, m);
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
  spec.checkCreate?.(ctx.actor, m.values);
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
    warnings: [],
  };
}

/** The two ends of a link and the way they relate. */
interface Relation {
  /** The ends, in the canonical order the row stores them */
  ends: [ItemRef, ItemRef];
  /** "none" for a plain connection; which end comes first for a dependency */
  direction: LinkDirection;
  /** The end that must be done first (null for a plain connection) */
  before: ItemRef | null;
  /** The end that waits for it (null for a plain connection) */
  after: ItemRef | null;
  /** True when an open link of the pair keeps the kind it has (no kind was asked for) */
  keep: boolean;
}

/** "type:id", the way the ends of a link are compared and sorted. */
function itemKey(ref: ItemRef): string {
  return `${ref.type}:${ref.id}`;
}

/** The relation a link mutation asks for. */
function relationOf(m: Extract<Mutation, { action: "link" }>): Relation {
  if ("depends" in m) {
    const ends = canonicalPair(m.depends.before, m.depends.after);
    const direction: LinkDirection = itemKey(m.depends.before) === itemKey(ends[0]) ? "a_to_b" : "b_to_a";
    return { ends, direction, before: m.depends.before, after: m.depends.after, keep: false };
  }
  const ends = canonicalPair(m.a, m.b);
  return { ends, direction: "none", before: null, after: null, keep: m.related !== true };
}

/** The kind of item a link points at. */
function itemType(value: Value | undefined): ItemType {
  if (value === "note" || value === "task") return value;
  throw new ValidationError("A link joins two notes or tasks.");
}

/** The direction a link asks for. */
function linkDirection(value: Value | undefined): LinkDirection {
  if (value === "none" || value === "a_to_b" || value === "b_to_a") return value;
  throw new ValidationError("A link has an unknown direction.");
}

/** The ends of a stored link, in the order the row keeps them. */
function endsOf(row: Row): [ItemRef, ItemRef] {
  return [
    { type: itemType(row.a_type), id: String(row.a_id) },
    { type: itemType(row.b_type), id: String(row.b_id) },
  ];
}

/** An open dependency link: the end that comes first and the end that waits. */
interface DependencyEdge {
  linkId: string;
  before: ItemRef;
  after: ItemRef;
}

/** Every open dependency link, in the order the rows are stored. */
async function dependencyLinks(db: D1Database): Promise<DependencyEdge[]> {
  const { results } = await db
    .prepare(
      `SELECT id, a_type, a_id, b_type, b_id, direction FROM links
       WHERE archived_at IS NULL AND direction <> 'none'`,
    )
    .all<{ id: string; a_type: string; a_id: string; b_type: string; b_id: string; direction: string }>();
  return results.map((row) => {
    const ends = endsOf(row);
    const [before, after] = linkDirection(row.direction) === "a_to_b" ? ends : [ends[1], ends[0]];
    return { linkId: String(row.id), before, after };
  });
}

/** True when `to` can be reached from `from` by following the edges. */
function reaches(edges: readonly { from: string; to: string }[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.from);
    if (list === undefined) next.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop() ?? "";
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of next.get(current) ?? []) stack.push(target);
  }
  return false;
}

/**
 * A dependency is only allowed between two tasks, and never where it would
 * make a circle of tasks waiting for each other. The link being changed is
 * left out of the circle check, so a dependency can be reversed.
 */
async function checkRelation(ctx: Context, relation: Relation, excludeLinkId: string | null): Promise<void> {
  if (relation.direction === "none") return;
  for (const end of relation.ends) {
    if (end.type !== "task") throw new ValidationError("A dependency can only be between two tasks.");
  }
  const edges: { from: string; to: string }[] = [];
  for (const edge of await dependencyLinks(ctx.db)) {
    if (edge.linkId === excludeLinkId) continue;
    edges.push({ from: edge.before.id, to: edge.after.id });
  }
  for (const edge of ctx.pendingEdges(excludeLinkId)) edges.push(edge);
  if (relation.before !== null && relation.after !== null) {
    if (reaches(edges, relation.after.id, relation.before.id)) {
      throw new ValidationError("That would make a circle of tasks waiting for each other.");
    }
  }
}

/**
 * The open prerequisites of a task that are not done yet, as warnings for
 * the person ticking it off. Ticking a task off is never refused, but the
 * person is told what it still waits for.
 */
async function prerequisiteWarnings(ctx: Context, taskId: string): Promise<string[]> {
  const pending = ctx.pendingEdges(null);
  const prepared = new Set(pending.map((edge) => edge.linkId));
  const edges = [
    ...(await dependencyLinks(ctx.db))
      .filter((edge) => !prepared.has(edge.linkId))
      .map((edge) => ({ linkId: edge.linkId, from: edge.before.id, to: edge.after.id })),
    ...pending,
  ];
  const waiting: string[] = [];
  for (const edge of edges) {
    if (edge.to !== taskId) continue;
    if (!waiting.includes(edge.from)) waiting.push(edge.from);
  }
  const warnings: string[] = [];
  for (const id of waiting) {
    const row = await ctx.read("task", id);
    if (!row || row.archived_at !== null) continue;
    if (row.status === "done") continue;
    const title = String(row.title ?? "").trim();
    const name = title === "" ? "an unnamed task" : `"${title}"`;
    warnings.push(`Waits for ${name}, which is not done yet.`);
  }
  return warnings;
}

/** Change the direction of an open link, or do nothing when it already has it. */
async function changeDirection(
  ctx: Context,
  existing: Row,
  relation: Relation,
  m: Mutation,
): Promise<Prepared> {
  const id = String(existing.id);
  if (String(existing.direction) === relation.direction) {
    return { entity: "link", id, row: existing, statements: [], event: null, warnings: [] };
  }
  await checkRelation(ctx, relation, id);
  const after: Row = { ...existing, direction: relation.direction };
  ctx.remember("link", id, after);
  ctx.rememberEdge(id, relation.before?.id ?? null, relation.after?.id ?? null);
  return {
    entity: "link",
    id,
    row: after,
    statements: conditionalUpdate(ctx.db, ENTITIES.link, id, existing, { direction: relation.direction }, null),
    event: ctx.event(
      "link",
      id,
      "update",
      { direction: existing.direction ?? null },
      { direction: relation.direction },
      m,
    ),
    warnings: [],
  };
}

async function prepareLink(ctx: Context, m: Extract<Mutation, { action: "link" }>): Promise<Prepared> {
  const relation = relationOf(m);
  const [a, b] = relation.ends;
  for (const end of relation.ends) {
    const row = await ctx.read(end.type, end.id);
    if (!row || row.archived_at !== null) throw new NotFoundError(`No open ${end.type} with id ${end.id}.`);
  }
  const existing = await ctx.readLinkPair(a, b);
  if (existing && existing.archived_at === null) {
    // Linking a linked pair without asking for a kind changes nothing, so a
    // dependency someone made is never turned into a plain connection by accident.
    if (relation.keep) {
      return { entity: "link", id: String(existing.id), row: existing, statements: [], event: null, warnings: [] };
    }
    return changeDirection(ctx, existing, relation, m);
  }
  if (existing) {
    // Link a pair that was unlinked earlier, with the direction asked for and
    // the same rules as a new link.
    const id = String(existing.id);
    await checkRelation(ctx, relation, id);
    const changes: Row = { archived_at: null };
    if (String(existing.direction) !== relation.direction) changes.direction = relation.direction;
    const after: Row = { ...existing, ...changes };
    ctx.remember("link", id, after);
    ctx.rememberEdge(
      id,
      relation.before?.id ?? null,
      relation.after?.id ?? null,
    );
    const before: Row = {};
    for (const field of Object.keys(changes)) before[field] = existing[field] ?? null;
    return {
      entity: "link",
      id,
      row: after,
      statements: conditionalUpdate(ctx.db, ENTITIES.link, id, existing, changes, null),
      event: ctx.event("link", id, "link", before, changes, m),
      warnings: [],
    };
  }
  await checkRelation(ctx, relation, null);
  const id = ulid(ctx.now.getTime());
  const row: Row = {
    id,
    a_type: a.type,
    a_id: a.id,
    b_type: b.type,
    b_id: b.id,
    direction: relation.direction,
    created_at: ctx.ts,
    archived_at: null,
  };
  const columns = ENTITIES.link.columns;
  const statement = ctx.db
    .prepare(`INSERT INTO links (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((c) => row[c] ?? null));
  ctx.remember("link", id, row);
  ctx.rememberEdge(id, relation.before?.id ?? null, relation.after?.id ?? null);
  return {
    entity: "link",
    id,
    row,
    statements: [statement],
    event: ctx.event("link", id, "link", null, row, m),
    warnings: [],
  };
}

/** Change how an existing link relates its two ends. */
async function prepareRelink(ctx: Context, m: Extract<Mutation, { action: "relink" }>): Promise<Prepared> {
  const before = await ctx.read("link", m.id);
  if (!before) throw new NotFoundError(`No link with id ${m.id}.`);
  if (before.archived_at !== null) throw new NotFoundError(`No open link with id ${m.id}.`);
  const ends = endsOf(before);
  let relation: Relation;
  if ("depends" in m) {
    const pair = canonicalPair(m.depends.before, m.depends.after);
    const keys = new Set([itemKey(pair[0]), itemKey(pair[1])]);
    if (!keys.has(itemKey(ends[0])) || !keys.has(itemKey(ends[1]))) {
      throw new ValidationError("A link can only be changed between the two items it joins.");
    }
    const direction: LinkDirection = itemKey(m.depends.before) === itemKey(ends[0]) ? "a_to_b" : "b_to_a";
    relation = { ends, direction, before: m.depends.before, after: m.depends.after, keep: false };
  } else {
    relation = { ends, direction: "none", before: null, after: null, keep: false };
  }
  return changeDirection(ctx, before, relation, m);
}

async function prepareChange(
  ctx: Context,
  m: Exclude<Mutation, { action: "create" | "link" | "relink" }>,
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
      // Archiving by revert (undoing a creation or an unarchive) leaves an
      // item that is already archived alone, as archiving does.
      if (spec.archive && wanted[spec.archive] != null && before[spec.archive] !== null) {
        delete wanted[spec.archive];
      }
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
  // A position is one value: a move records both coordinates, so every event
  // (and every revert of it) restores a whole position.
  if ((m.entity === "note" || m.entity === "task") && ("x" in changes || "y" in changes)) {
    if (!("x" in changes)) changes.x = before.x ?? null;
    if (!("y" in changes)) changes.y = before.y ?? null;
  }

  if (Object.keys(changes).length === 0) {
    return { entity: m.entity, id: m.id, row: before, statements: [], event: null, warnings: [] };
  }

  // A revert that leaves an open dependency (its direction put back, or an
  // unlink undone) must follow the same rules as a new one.
  if (m.entity === "link") {
    const result: Row = { ...before, ...changes };
    const reopened = changes.archived_at === null && before.archived_at !== null;
    const direction = linkDirection(result.direction);
    if (result.archived_at === null && direction !== "none" && (changes.direction !== undefined || reopened)) {
      const ends = endsOf(before);
      const [first, second] = direction === "a_to_b" ? ends : [ends[1], ends[0]];
      await checkRelation(ctx, { ends, direction, before: first, after: second, keep: false }, m.id);
    }
  }

  // Ticking a task off is never refused, but the person is told what it
  // still waits for.
  const warnings =
    m.entity === "task" && m.action !== "revert" && changes.status === "done"
      ? await prerequisiteWarnings(ctx, m.id)
      : [];

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
    warnings,
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

/** Event JSON never carries hidden columns or the touch column (updated_at). */
function visible(spec: EntitySpec, row: Row): Row {
  const out: Row = {};
  for (const [field, value] of Object.entries(row)) {
    if (spec.hidden.includes(field) || field === spec.touch) continue;
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
      return new StaleWriteError();
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
