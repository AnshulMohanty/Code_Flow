import { describe, expect, it } from "vitest";
import { REPO_MAX_SNAPSHOTS } from "@codeflow/config";
import { createRedisRepoStore, type RepoRedisLike } from "../redisRepoStore.js";
import type { RepoSnapshot } from "../contracts.js";

/**
 * V3-P5 task 5 (ledger #21): the repo-snapshot store, Redis-backed.
 *
 * Driven against a FAKE hash-capable Redis, same arrangement as the session store. What can be
 * wrong in the adapter is the key scheme, the dedup-by-SHA, the ordering, the trim, the TTL and the
 * failure behaviour — a fake exercises all six exactly, and a live round trip would exercise
 * ioredis rather than this file.
 */

function fakeRedis(): RepoRedisLike & {
  hashes: Map<string, Map<string, string>>;
  expires: Array<{ key: string; seconds: number }>;
} {
  const hashes = new Map<string, Map<string, string>>();
  const expires: Array<{ key: string; seconds: number }> = [];
  return {
    hashes,
    expires,
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key, field, value) {
      const hash = hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? new Map<string, string>());
    },
    async hdel(key, ...fields) {
      const hash = hashes.get(key);
      for (const field of fields) hash?.delete(field);
      return fields.length;
    },
    async expire(key, seconds) {
      expires.push({ key, seconds });
      return 1;
    },
    async del(key) {
      hashes.delete(key);
      return 1;
    },
  };
}

function snapshot(commitSha: string, capturedAt: string, files: string[] = ["a.ts"]): RepoSnapshot {
  return {
    repoFullName: "acme/app",
    commitSha,
    fileIds: files,
    edges: [],
    symbolsByFile: {},
    cycles: [],
    capturedAt,
  };
}

describe("createRedisRepoStore", () => {
  it("round-trips a snapshot", async () => {
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    expect(await store.get("acme/app", "sha-1")).toMatchObject({ commitSha: "sha-1", fileIds: ["a.ts"] });
  });

  it("lists most recent FIRST, matching the in-memory contract", async () => {
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("old", "2026-01-01T00:00:00.000Z"));
    await store.put(snapshot("new", "2026-02-01T00:00:00.000Z"));
    expect((await store.list("acme/app")).map((entry) => entry.commitSha)).toEqual(["new", "old"]);
  });

  it("orders by capturedAt, NOT by insertion order", async () => {
    // Which is what makes the hash sufficient: Redis hashes have no order, so if this relied on
    // insertion order it would be relying on something Redis does not promise.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("newer", "2026-03-01T00:00:00.000Z"));
    await store.put(snapshot("older", "2026-01-01T00:00:00.000Z"));
    expect((await store.list("acme/app")).map((entry) => entry.commitSha)).toEqual(["newer", "older"]);
  });

  it("breaks a capturedAt tie by SHA, so list() is a TOTAL order", async () => {
    // Two snapshots captured in the same millisecond must not swap places between calls.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("aaa", "2026-01-01T00:00:00.000Z"));
    await store.put(snapshot("bbb", "2026-01-01T00:00:00.000Z"));
    const first = (await store.list("acme/app")).map((entry) => entry.commitSha);
    const second = (await store.list("acme/app")).map((entry) => entry.commitSha);
    expect(first).toEqual(second);
    expect(first).toEqual(["bbb", "aaa"]);
  });

  it("OVERWRITES the same SHA rather than appending a duplicate", async () => {
    // Re-analysing a commit produces an identical snapshot; a duplicate would waste one of the ten
    // slots and make list() lie about how many commits are known.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z", ["a.ts"]));
    await store.put(snapshot("sha-1", "2026-01-02T00:00:00.000Z", ["a.ts", "b.ts"]));
    const all = await store.list("acme/app");
    expect(all).toHaveLength(1);
    expect(all[0].fileIds).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps two DIFFERENT commits written concurrently — the read-modify-write failure it avoids", async () => {
    // On one JSON blob under read-modify-write, whichever put finished second would erase the
    // other. Field-level hset makes both survive.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await Promise.all([
      store.put(snapshot("sha-a", "2026-01-01T00:00:00.000Z")),
      store.put(snapshot("sha-b", "2026-01-02T00:00:00.000Z")),
    ]);
    expect((await store.list("acme/app")).map((entry) => entry.commitSha).sort()).toEqual(["sha-a", "sha-b"]);
  });

  it("trims to the bound, keeping the most recent", async () => {
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    for (let i = 1; i <= REPO_MAX_SNAPSHOTS + 3; i++) {
      await store.put(snapshot(`sha-${String(i).padStart(2, "0")}`, `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`));
    }
    const all = await store.list("acme/app");
    expect(all).toHaveLength(REPO_MAX_SNAPSHOTS);
    expect(all[0].commitSha).toBe(`sha-${String(REPO_MAX_SNAPSHOTS + 3).padStart(2, "0")}`);
    // The oldest are actually GONE from Redis, not merely hidden by list().
    expect(await store.get("acme/app", "sha-01")).toBeNull();
  });

  it("re-applies the bound on READ, so a hash that lost a trim cannot over-return", async () => {
    // Callers size prompts against this bound; a value written by an older build must not be able
    // to inflate it.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis, maxSnapshots: 2 });
    const hash = new Map<string, string>();
    for (let i = 1; i <= 5; i++) {
      const entry = snapshot(`sha-${i}`, `2026-01-0${i}T00:00:00.000Z`);
      hash.set(entry.commitSha, JSON.stringify(entry));
    }
    redis.hashes.set("codeflow:repo:acme/app", hash);
    expect(await store.list("acme/app")).toHaveLength(2);
  });

  it("refreshes the TTL on every write, so an active repo never expires and a dormant one does", async () => {
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis, ttlSeconds: 1234 });
    await store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    await store.put(snapshot("sha-2", "2026-01-02T00:00:00.000Z"));
    expect(redis.expires).toHaveLength(2);
    expect(redis.expires[0]).toEqual({ key: "codeflow:repo:acme/app", seconds: 1234 });
  });

  it("defaults to a 30-day TTL — much longer than a session, because the question is different", async () => {
    const redis = fakeRedis();
    await createRedisRepoStore({ redis }).put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    expect(redis.expires[0].seconds).toBe(30 * 24 * 60 * 60);
  });

  it("namespaces its keys so a shared Redis can also hold sessions and the budget", async () => {
    const redis = fakeRedis();
    await createRedisRepoStore({ redis }).put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    expect([...redis.hashes.keys()]).toEqual(["codeflow:repo:acme/app"]);
  });

  it("clear() drops the whole repository", async () => {
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    await store.clear("acme/app");
    expect(await store.list("acme/app")).toEqual([]);
  });

  it("SKIPS one corrupt field instead of failing the whole history", async () => {
    // A diff against nine commits beats an error.
    const redis = fakeRedis();
    const store = createRedisRepoStore({ redis });
    await store.put(snapshot("good", "2026-01-02T00:00:00.000Z"));
    redis.hashes.get("codeflow:repo:acme/app")?.set("bad", "{not json");
    const all = await store.list("acme/app");
    expect(all.map((entry) => entry.commitSha)).toEqual(["good"]);
  });
});

describe("failure behaviour — fails SOFT and reports", () => {
  const broken: RepoRedisLike = {
    async hget() {
      throw new Error("redis down");
    },
    async hset() {
      throw new Error("redis down");
    },
    async hgetall() {
      throw new Error("redis down");
    },
    async hdel() {
      throw new Error("redis down");
    },
    async expire() {
      throw new Error("redis down");
    },
    async del() {
      throw new Error("redis down");
    },
  };

  it("list() returns empty rather than throwing — an empty history is a state callers handle", async () => {
    const errors: string[] = [];
    const store = createRedisRepoStore({ redis: broken, onError: (_error, operation) => errors.push(operation) });
    expect(await store.list("acme/app")).toEqual([]);
    expect(errors).toContain("list");
  });

  it("get() returns null rather than throwing", async () => {
    const store = createRedisRepoStore({ redis: broken });
    expect(await store.get("acme/app", "sha-1")).toBeNull();
  });

  it("put() and clear() swallow-and-report rather than failing the question", async () => {
    const errors: string[] = [];
    const store = createRedisRepoStore({ redis: broken, onError: (_error, operation) => errors.push(operation) });
    await expect(store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"))).resolves.toBeUndefined();
    await expect(store.clear("acme/app")).resolves.toBeUndefined();
    expect(errors).toEqual(["put", "clear"]);
  });

  it("REPORTS every failure — a lost snapshot must be diagnosable, not silent", async () => {
    const errors: unknown[] = [];
    const store = createRedisRepoStore({ redis: broken, onError: (error) => errors.push(error) });
    await store.put(snapshot("sha-1", "2026-01-01T00:00:00.000Z"));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("redis down");
  });
});
