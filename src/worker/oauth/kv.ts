// KV-compatible storage for @cloudflare/workers-oauth-provider, backed by the
// oauth_kv D1 table, so the Worker needs only D1 and R2 (DECISIONS.md).
//
// It implements the calls the provider makes and nothing more:
//   get(key) / get(key, "json") / get(key, { type: "json" })
//   put(key, value, { expirationTtl | expiration, metadata })
//   delete(key)
//   list({ prefix, limit, cursor }) -> { keys, list_complete, cursor }
// Expiry follows KV: `expiration` is seconds since the epoch, and a key is
// invisible from that second on. Expired rows are removed by purgeExpired().

type GetType = "text" | "json";

interface PutOptions {
  /** Seconds from now */
  expirationTtl?: number;
  /** Seconds since the epoch */
  expiration?: number;
  metadata?: unknown;
}

interface ListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

interface ListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface ListResult {
  keys: ListKey[];
  list_complete: boolean;
  cursor?: string;
}

/** KV's own maximum page size. */
const MAX_LIST_LIMIT = 1000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class D1KvStore {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => number = nowSeconds,
  ) {}

  async get(key: string, options?: GetType | { type?: GetType }): Promise<unknown> {
    const type = (typeof options === "string" ? options : options?.type) ?? "text";
    if (type !== "text" && type !== "json") throw new TypeError(`Unsupported KV get type: ${String(type)}`);
    const row = await this.db
      .prepare(`SELECT value FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(key, this.clock())
      .first<{ value: string }>();
    if (!row) return null;
    return type === "json" ? (JSON.parse(row.value) as unknown) : row.value;
  }

  async put(key: string, value: string, options: PutOptions = {}): Promise<void> {
    if (typeof value !== "string") throw new TypeError("Only string values can be stored.");
    let expiresAt: number | null = null;
    if (options.expiration !== undefined) expiresAt = Math.floor(options.expiration);
    else if (options.expirationTtl !== undefined) expiresAt = this.clock() + Math.floor(options.expirationTtl);
    const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
    await this.db
      .prepare(
        `INSERT INTO oauth_kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata`,
      )
      .bind(key, value, expiresAt, metadata)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM oauth_kv WHERE key = ?`).bind(key).run();
  }

  /** Keys in key order. The cursor is the last key of the previous page. */
  async list(options: ListOptions = {}): Promise<ListResult> {
    const prefix = options.prefix ?? "";
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? MAX_LIST_LIMIT), MAX_LIST_LIMIT));
    const after = options.cursor ?? "";
    const { results } = await this.db
      .prepare(
        `SELECT key, expires_at, metadata FROM oauth_kv
         WHERE substr(key, 1, length(?1)) = ?1 AND key > ?2 AND (expires_at IS NULL OR expires_at > ?3)
         ORDER BY key LIMIT ?4`,
      )
      .bind(prefix, after, this.clock(), limit + 1)
      .all<{ key: string; expires_at: number | null; metadata: string | null }>();
    const page = results.slice(0, limit);
    const keys = page.map((row) => {
      const entry: ListKey = { name: row.key };
      if (row.expires_at !== null) entry.expiration = row.expires_at;
      if (row.metadata !== null) entry.metadata = JSON.parse(row.metadata) as unknown;
      return entry;
    });
    const last = page[page.length - 1];
    if (results.length > limit && last) return { keys, list_complete: false, cursor: last.key };
    return { keys, list_complete: true };
  }
}

/**
 * The store as the KVNamespace the provider expects. D1KvStore implements
 * only the subset of KVNamespace the provider calls (see the top of this
 * file), so the full interface is asserted here, in this one place.
 */
export function oauthKv(db: D1Database): KVNamespace {
  return new D1KvStore(db) as unknown as KVNamespace;
}

/** Delete expired rows. Returns how many were removed. */
export async function purgeExpired(db: D1Database, now: number = nowSeconds()): Promise<number> {
  const result = await db.prepare(`DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?`).bind(now).run();
  return result.meta.changes;
}
