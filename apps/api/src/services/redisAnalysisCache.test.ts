import { describe, expect, it } from "vitest";
import { createRedisAnalysisCache, type CacheRedisLike } from "./redisAnalysisCache.js";

/**
 * V3-P5 task 5 (ledger #21): the Q&A answer cache, shared via Redis instead of per-process.
 *
 * Driven against a fake, like the budget and the session store. What can be wrong here is the key
 * prefix, the TTL, the serialisation, the value bound and — above all — the failure behaviour, and
 * a fake exercises all five.
 */

function fakeRedis(): CacheRedisLike & { store: Map<string, string>; writes: Array<{ key: string; ttl: number }> } {
  const store = new Map<string, string>();
  const writes: Array<{ key: string; ttl: number }> = [];
  return {
    store,
    writes,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, _mode, seconds) {
      store.set(key, value);
      writes.push({ key, ttl: seconds });
      return "OK";
    },
  };
}

describe("createRedisAnalysisCache", () => {
  it("round-trips a value", async () => {
    const redis = fakeRedis();
    const cache = createRedisAnalysisCache({ redis });
    await cache.set("q1", { answer: "it uses BullMQ", citations: ["src/queue.ts"] });
    expect(await cache.get("q1")).toEqual({ answer: "it uses BullMQ", citations: ["src/queue.ts"] });
  });

  it("returns null for a miss", async () => {
    expect(await createRedisAnalysisCache({ redis: fakeRedis() }).get("nope")).toBeNull();
  });

  it("namespaces its keys so a shared Redis can also hold sessions, repo memory and the budget", async () => {
    const redis = fakeRedis();
    await createRedisAnalysisCache({ redis }).set("q1", 1);
    expect([...redis.store.keys()]).toEqual(["codeflow:qa-cache:q1"]);
  });

  it("writes with a TTL, defaulting to 7 days", async () => {
    const redis = fakeRedis();
    await createRedisAnalysisCache({ redis }).set("q1", 1);
    expect(redis.writes[0].ttl).toBe(7 * 24 * 60 * 60);
  });

  it("honours a configured TTL", async () => {
    const redis = fakeRedis();
    await createRedisAnalysisCache({ redis, ttlSeconds: 60 }).set("q1", 1);
    expect(redis.writes[0].ttl).toBe(60);
  });

  it("preserves falsy values — 0, false and empty string are HITS, not misses", async () => {
    // The bug this prevents: a `store.get(key) ?? null` style hit test treats a cached `0` as a
    // miss and re-buys it from the provider every time.
    const cache = createRedisAnalysisCache({ redis: fakeRedis() });
    await cache.set("zero", 0);
    await cache.set("false", false);
    await cache.set("empty", "");
    expect(await cache.get("zero")).toBe(0);
    expect(await cache.get("false")).toBe(false);
    expect(await cache.get("empty")).toBe("");
  });

  it("stores null distinguishably from a miss", async () => {
    const cache = createRedisAnalysisCache({ redis: fakeRedis() });
    await cache.set("explicit-null", null);
    expect(await cache.get("explicit-null")).toBeNull();
  });

  it("REFUSES to cache undefined rather than writing the text 'undefined'", async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string. Writing it stores the literal
    // "undefined", which throws SyntaxError on the next read — a poisoned key that costs a provider
    // call on every question until it expires.
    const redis = fakeRedis();
    const errors: string[] = [];
    const cache = createRedisAnalysisCache({ redis, onError: (error) => errors.push(String(error)) });
    await cache.set("bad", undefined);
    expect(redis.store.size).toBe(0);
    expect(errors.join(" ")).toMatch(/refusing to cache an undefined value/);
  });

  it("REFUSES an oversized value, and says so", async () => {
    const redis = fakeRedis();
    const errors: string[] = [];
    const cache = createRedisAnalysisCache({ redis, maxValueBytes: 64, onError: (error) => errors.push(String(error)) });
    await cache.set("huge", "x".repeat(500));
    expect(redis.store.size).toBe(0);
    expect(errors.join(" ")).toMatch(/refusing to cache \d+ bytes/);
  });

  it("measures the bound in BYTES, not characters", async () => {
    // A multi-byte string must not slip past a byte bound by counting short.
    const redis = fakeRedis();
    const cache = createRedisAnalysisCache({ redis, maxValueBytes: 20 });
    // 10 emoji ~= 40+ bytes of UTF-8 but 20 UTF-16 code units.
    await cache.set("emoji", "🙂".repeat(10));
    expect(redis.store.size).toBe(0);
  });
});

describe("failure behaviour — a broken cache costs MONEY, never correctness", () => {
  const broken: CacheRedisLike = {
    async get() {
      throw new Error("redis down");
    },
    async set() {
      throw new Error("redis down");
    },
  };

  it("a failed READ is a MISS, not a thrown question", async () => {
    // The caller then takes the normal path: check the budget, call the provider, record usage.
    // Cache-before-budget is unchanged, so a broken cache cannot overspend the shared ceiling.
    const errors: string[] = [];
    const cache = createRedisAnalysisCache({ redis: broken, onError: (_error, operation) => errors.push(operation) });
    expect(await cache.get("q1")).toBeNull();
    expect(errors).toEqual(["get"]);
  });

  it("a failed WRITE resolves rather than rejecting", async () => {
    const errors: string[] = [];
    const cache = createRedisAnalysisCache({ redis: broken, onError: (_error, operation) => errors.push(operation) });
    await expect(cache.set("q1", { answer: "x" })).resolves.toBeUndefined();
    expect(errors).toEqual(["set"]);
  });

  it("a CORRUPT cached value is a miss, not a crash", async () => {
    const redis = fakeRedis();
    redis.store.set("codeflow:qa-cache:q1", "{not json");
    const errors: string[] = [];
    const cache = createRedisAnalysisCache({ redis, onError: (_error, operation) => errors.push(operation) });
    expect(await cache.get("q1")).toBeNull();
    expect(errors).toEqual(["get"]);
  });

  it("reports the underlying error, so a Redis rejecting every write is diagnosable", async () => {
    const errors: unknown[] = [];
    const cache = createRedisAnalysisCache({ redis: broken, onError: (error) => errors.push(error) });
    await cache.set("q1", 1);
    expect((errors[0] as Error).message).toBe("redis down");
  });
});
