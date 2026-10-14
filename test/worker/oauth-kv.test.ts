import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduled } from "../../src/worker/cron";
import { D1KvStore, oauthKv, purgeExpired } from "../../src/worker/oauth/kv";
import { freshDb } from "../helpers/db";

let db: D1Database;
let now: number;
let kv: D1KvStore;

beforeEach(async () => {
  db = await freshDb();
  now = 1_800_000_000;
  kv = new D1KvStore(db, () => now);
});

async function rowCount(): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM oauth_kv`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("get, put and delete", () => {
  it("stores and returns text", async () => {
    await kv.put("client:abc", "hello");
    expect(await kv.get("client:abc")).toBe("hello");
    expect(await kv.get("client:abc", "text")).toBe("hello");
    expect(await kv.get("client:missing")).toBeNull();
  });

  it("parses JSON with either form of the type option", async () => {
    await kv.put("grant:u:g", JSON.stringify({ id: "g", scope: ["planner"] }));
    expect(await kv.get("grant:u:g", { type: "json" })).toEqual({ id: "g", scope: ["planner"] });
    expect(await kv.get("grant:u:g", "json")).toEqual({ id: "g", scope: ["planner"] });
    expect(await kv.get("grant:u:missing", { type: "json" })).toBeNull();
  });

  it("refuses types the provider never asks for", async () => {
    await kv.put("k", "v");
    await expect(kv.get("k", { type: "arrayBuffer" } as unknown as { type: "json" })).rejects.toThrow(TypeError);
  });

  it("overwrites a key, value, expiry and metadata together", async () => {
    await kv.put("k", "one", { expirationTtl: 60, metadata: { a: 1 } });
    await kv.put("k", "two");
    expect(await kv.get("k")).toBe("two");
    const listed = await kv.list({ prefix: "k" });
    expect(listed.keys).toEqual([{ name: "k" }]);
    expect(await rowCount()).toBe(1);
  });

  it("deletes, and deleting a missing key is fine", async () => {
    await kv.put("k", "v");
    await kv.delete("k");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });
});

describe("expiry", () => {
  it("hides a key from its expirationTtl on", async () => {
    await kv.put("token:a", "x", { expirationTtl: 600 });
    now += 599;
    expect(await kv.get("token:a")).toBe("x");
    now += 1;
    expect(await kv.get("token:a")).toBeNull();
    expect(await kv.get("token:a", { type: "json" })).toBeNull();
    expect((await kv.list({ prefix: "token:" })).keys).toEqual([]);
  });

  it("hides a key from its absolute expiration on", async () => {
    await kv.put("grant:a", "x", { expiration: now + 10 });
    expect(await kv.get("grant:a")).toBe("x");
    now += 10;
    expect(await kv.get("grant:a")).toBeNull();
  });

  it("purgeExpired removes expired rows only", async () => {
    await kv.put("a", "1", { expirationTtl: 60 });
    await kv.put("b", "2", { expirationTtl: 120 });
    await kv.put("c", "3");
    expect(await purgeExpired(db, now + 60)).toBe(1);
    expect(await rowCount()).toBe(2);
    expect(await purgeExpired(db, now + 1_000_000)).toBe(1);
    expect(await kv.get("c")).toBe("3");
  });

  it("the cron purges expired OAuth records", async () => {
    const store = oauthKv(db);
    await store.put("old", "1", { expiration: Math.floor(Date.now() / 1000) - 5 });
    await store.put("live", "2", { expirationTtl: 3600 });
    await runScheduled(env);
    expect(await rowCount()).toBe(1);
    expect(await store.get("live")).toBe("2");
  });
});

describe("list", () => {
  beforeEach(async () => {
    for (const name of ["grant:u1:a", "grant:u1:b", "grant:u1:c", "grant:u2:a", "grant:u10:a", "token:u1:a:x", "client:z"]) {
      await kv.put(name, "v");
    }
  });

  it("lists keys with a prefix in key order", async () => {
    const result = await kv.list({ prefix: "grant:u1:" });
    expect(result.keys.map((k) => k.name)).toEqual(["grant:u1:a", "grant:u1:b", "grant:u1:c"]);
    expect(result.list_complete).toBe(true);
    expect(result.cursor).toBeUndefined();
  });

  it("treats LIKE wildcards in a prefix literally", async () => {
    await kv.put("grant:u_:x", "v");
    await kv.put("grant:u%:x", "v");
    expect((await kv.list({ prefix: "grant:u_" })).keys.map((k) => k.name)).toEqual(["grant:u_:x"]);
    expect((await kv.list({ prefix: "grant:u%" })).keys.map((k) => k.name)).toEqual(["grant:u%:x"]);
  });

  it("pages with limit and cursor", async () => {
    // Byte order, as in KV: "0" sorts before ":".
    const first = await kv.list({ prefix: "grant:", limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(["grant:u10:a", "grant:u1:a"]);
    expect(first.list_complete).toBe(false);
    const second = await kv.list({ prefix: "grant:", limit: 2, cursor: first.cursor ?? null });
    expect(second.keys.map((k) => k.name)).toEqual(["grant:u1:b", "grant:u1:c"]);
    expect(second.list_complete).toBe(false);
    const third = await kv.list({ prefix: "grant:", limit: 2, cursor: second.cursor ?? null });
    expect(third.keys.map((k) => k.name)).toEqual(["grant:u2:a"]);
    expect(third.list_complete).toBe(true);
  });

  it("lists everything without a prefix", async () => {
    expect((await kv.list()).keys).toHaveLength(7);
  });

  it("returns expiration and metadata, and skips expired keys", async () => {
    await kv.put("meta:a", "v", { expiration: now + 100, metadata: { clientId: "c1", expiresAt: 5 } });
    await kv.put("meta:b", "v", { expirationTtl: 60 });
    now += 60;
    expect((await kv.list({ prefix: "meta:" })).keys).toEqual([
      { name: "meta:a", expiration: 1_800_000_100, metadata: { clientId: "c1", expiresAt: 5 } },
    ]);
  });
});
