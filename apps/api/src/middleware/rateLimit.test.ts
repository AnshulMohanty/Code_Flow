import { describe, expect, it } from "vitest";
import {
  createInMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitRedisLike,
} from "./rateLimit.js";

// V3-P0 — Guard 4's PRODUCTION store. Hermetic: a fake Redis, an explicit clock, no server.

/** A fake Redis: a map plus INCR/EXPIRE semantics, so cross-instance behaviour is testable. */
function fakeRedis(overrides: Partial<RateLimitRedisLike> = {}): RateLimitRedisLike & { store: Map<string, number> } {
  const store = new Map<string, number>();
  return {
    store,
    async incr(key) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async pttl() {
      return -1;
    },
    ...overrides,
  };
}

const WINDOW = 60_000;

describe("redis rate-limit store", () => {
  it("counts hits within one fixed window and reports the window reset", async () => {
    const store = createRedisRateLimitStore(fakeRedis());
    const now = 1_000_000;
    expect(await store.hit("ip-1", WINDOW, now)).toEqual({ count: 1, resetAt: expectedReset(now) });
    expect(await store.hit("ip-1", WINDOW, now + 10)).toEqual({ count: 2, resetAt: expectedReset(now) });
    expect(await store.hit("ip-1", WINDOW, now + 20)).toEqual({ count: 3, resetAt: expectedReset(now) });
  });

  it("holds the limit ACROSS instances — the thing the in-memory store could not do", async () => {
    const redis = fakeRedis();
    const instanceA = createRedisRateLimitStore(redis);
    const instanceB = createRedisRateLimitStore(redis);
    const now = 1_000_000;

    await instanceA.hit("ip-1", WINDOW, now);
    await instanceA.hit("ip-1", WINDOW, now);
    // A request landing on the OTHER replica continues the same count.
    expect((await instanceB.hit("ip-1", WINDOW, now)).count).toBe(3);

    // The in-memory store, by contrast, starts over per instance.
    const memA = createInMemoryRateLimitStore();
    const memB = createInMemoryRateLimitStore();
    await memA.hit("ip-1", WINDOW, now);
    await memA.hit("ip-1", WINDOW, now);
    expect((await memB.hit("ip-1", WINDOW, now)).count).toBe(1);
  });

  it("starts a fresh count in the next window", async () => {
    const store = createRedisRateLimitStore(fakeRedis());
    const now = 1_000_000;
    await store.hit("ip-1", WINDOW, now);
    await store.hit("ip-1", WINDOW, now);
    const next = await store.hit("ip-1", WINDOW, now + WINDOW);
    expect(next.count).toBe(1);
    expect(next.resetAt).toBeGreaterThan(expectedReset(now));
  });

  it("keeps different keys independent", async () => {
    const store = createRedisRateLimitStore(fakeRedis());
    const now = 1_000_000;
    await store.hit("ip-1", WINDOW, now);
    await store.hit("ip-1", WINDOW, now);
    expect((await store.hit("ip-2", WINDOW, now)).count).toBe(1);
  });

  it("sets a self-cleaning TTL on the FIRST hit only", async () => {
    const expires: Array<{ key: string; seconds: number }> = [];
    const redis = fakeRedis({
      async expire(key, seconds) {
        expires.push({ key, seconds });
        return 1;
      },
    });
    const store = createRedisRateLimitStore(redis);
    const now = 1_000_000;
    await store.hit("ip-1", WINDOW, now);
    await store.hit("ip-1", WINDOW, now);
    expect(expires).toHaveLength(1); // only the bucket-creating hit sets a TTL
    expect(expires[0].seconds).toBe(61); // window + 1s of slack
  });

  it("buckets the key by window so the boundary needs no stored state", async () => {
    const redis = fakeRedis();
    const store = createRedisRateLimitStore(redis, { keyPrefix: "rl" });
    await store.hit("ip-1", WINDOW, 0);
    await store.hit("ip-1", WINDOW, WINDOW);
    expect([...redis.store.keys()]).toEqual(["rl:ip-1:0", "rl:ip-1:1"]);
  });

  it("FAILS OPEN and reports the error when Redis is unreachable", async () => {
    // A cache blip must not take the analyze endpoint down; an abuse guard is not worth that.
    const store = createRedisRateLimitStore(
      fakeRedis({
        async incr() {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    const result = await store.hit("ip-1", WINDOW, 1_000_000);
    expect(result.count).toBe(1); // "allowed"
    expect(store.lastError()).toContain("ECONNREFUSED");
  });
});

function expectedReset(now: number): number {
  return (Math.floor(now / WINDOW) + 1) * WINDOW;
}
