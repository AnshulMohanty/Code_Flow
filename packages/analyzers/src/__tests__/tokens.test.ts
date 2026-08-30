import { describe, expect, it } from "vitest";
import type { BudgetRedisLike } from "../budget/budgetHandle.js";
import { createInMemoryBudgetHandle, createRedisBudgetHandle, tokensOf } from "../budget/budgetHandle.js";
import {
  estimateTokens,
  estimatedUsage,
  measuredUsage,
  sumUsage,
  totalTokens,
  usageNumber,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
} from "../util/tokens.js";

// V3-P0 — the cost control plane. Hermetic: a fake Redis, an injected clock, no services.

describe("token accounting (the ONE shared utility)", () => {
  it("estimates deterministically at the documented chars-per-token rate", () => {
    expect(TOKEN_ESTIMATE_CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // ceil
    // Same input, same answer — the RAG chunk plan depends on this.
    expect(estimateTokens("a".repeat(401))).toBe(estimateTokens("a".repeat(401)));
  });

  it("distinguishes a MEASURED usage from an ESTIMATED one", () => {
    // The whole point of the field: an estimate must never look like a provider number.
    expect(measuredUsage(10, 5).measured).toBe(true);
    expect(estimatedUsage("some prompt", "some output").measured).toBe(false);
  });

  it("totals input + output (cache tokens are already part of input)", () => {
    expect(totalTokens(measuredUsage(100, 20, { read: 80 }))).toBe(120);
  });

  it("carries provider cache accounting only when reported", () => {
    expect(measuredUsage(1, 1)).toEqual({ inputTokens: 1, outputTokens: 1, measured: true });
    expect(measuredUsage(1, 1, { read: 5, write: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      measured: true,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    });
  });

  it("reads untrusted provider counters without poisoning the ledger with NaN", () => {
    expect(usageNumber(42)).toBe(42);
    expect(usageNumber("42")).toBe(42);
    expect(usageNumber(42.6)).toBe(43);
    expect(usageNumber(undefined)).toBeUndefined();
    expect(usageNumber(null)).toBeUndefined();
    expect(usageNumber("abc")).toBeUndefined();
    expect(usageNumber(-1)).toBeUndefined();
    expect(usageNumber(Number.NaN)).toBeUndefined();
    expect(usageNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("sums usage, and ONE estimated part makes the whole total an estimate", () => {
    expect(sumUsage([measuredUsage(10, 1), measuredUsage(20, 2)])).toEqual({
      inputTokens: 30,
      outputTokens: 3,
      measured: true,
    });
    const mixed = sumUsage([measuredUsage(10, 1), { inputTokens: 5, outputTokens: 0, measured: false }]);
    expect(mixed.measured).toBe(false);
    expect(mixed.inputTokens).toBe(15);
    // An empty sum is trivially measured (nothing was spent, nothing was guessed).
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, measured: true });
  });

  it("normalizes either record() argument form to a count", () => {
    expect(tokensOf(7)).toBe(7);
    expect(tokensOf(measuredUsage(10, 5))).toBe(15);
  });
});

describe("in-memory budget handle", () => {
  it("counts chat and embedding units INDEPENDENTLY", () => {
    // Pooling them could not express either ceiling correctly (different prices).
    const handle = createInMemoryBudgetHandle(100, () => 0);
    return (async () => {
      await handle.record(90, "chat");
      expect(await handle.check(5, "chat")).toBe(true);
      expect(await handle.check(20, "chat")).toBe(false);
      // The embedding ledger is untouched by chat spend.
      expect(await handle.check(100, "embedding")).toBe(true);
      expect(await handle.spent?.("chat")).toBe(90);
      expect(await handle.spent?.("embedding")).toBe(0);
    })();
  });

  it("records a TokenUsage as its total", async () => {
    const handle = createInMemoryBudgetHandle(1000, () => 0);
    await handle.record(measuredUsage(100, 25), "chat");
    expect(await handle.spent?.("chat")).toBe(125);
  });

  it("resets on the UTC day rollover", async () => {
    let clock = Date.parse("2026-08-30T23:59:00Z");
    const handle = createInMemoryBudgetHandle(100, () => clock);
    await handle.record(100, "chat");
    expect(await handle.check(1, "chat")).toBe(false);
    clock = Date.parse("2026-08-31T00:01:00Z");
    expect(await handle.check(1, "chat")).toBe(true);
    expect(await handle.spent?.("chat")).toBe(0);
  });

  it("defaults to the chat unit when none is given (back-compat)", async () => {
    const handle = createInMemoryBudgetHandle(100, () => 0);
    await handle.record(10);
    expect(await handle.spent?.()).toBe(10);
    expect(await handle.spent?.("chat")).toBe(10);
  });
});

/** A fake Redis: an in-object map, so the shared-ledger semantics are testable hermetically. */
function fakeRedis(overrides: Partial<BudgetRedisLike> = {}): BudgetRedisLike & { store: Map<string, number> } {
  const store = new Map<string, number>();
  return {
    store,
    async incrby(key, amount) {
      const next = (store.get(key) ?? 0) + amount;
      store.set(key, next);
      return next;
    },
    async get(key) {
      return store.has(key) ? String(store.get(key)) : null;
    },
    async expire() {
      return 1;
    },
    ...overrides,
  };
}

describe("redis budget handle (the SHARED production ledger)", () => {
  it("two independent handles decrement the SAME ceiling", async () => {
    // This is the bug it fixes: the worker and the API each kept their own ledger, so the
    // "global" daily ceiling was two ceilings that could not see each other's spend.
    const redis = fakeRedis();
    const clock = () => Date.parse("2026-08-30T10:00:00Z");
    const worker = createRedisBudgetHandle(redis, { limitTokens: 100, now: clock });
    const api = createRedisBudgetHandle(redis, { limitTokens: 100, now: clock });

    await worker.record(measuredUsage(60, 0), "chat");
    expect(await api.spent?.("chat")).toBe(60);
    expect(await api.check(50, "chat")).toBe(false); // sees the worker's spend
    expect(await api.check(30, "chat")).toBe(true);

    await api.record(30, "chat");
    expect(await worker.spent?.("chat")).toBe(90);
  });

  it("keys per UTC day and per unit", async () => {
    const redis = fakeRedis();
    let clock = Date.parse("2026-08-30T10:00:00Z");
    const handle = createRedisBudgetHandle(redis, { limitTokens: 100, now: () => clock });
    await handle.record(50, "chat");
    await handle.record(10, "embedding");
    expect([...redis.store.keys()].sort()).toEqual([
      "codeflow:budget:2026-08-30:chat",
      "codeflow:budget:2026-08-30:embedding",
    ]);
    // A new UTC day is a new key ⇒ a fresh ceiling, with no explicit reset step.
    clock = Date.parse("2026-08-31T00:00:01Z");
    expect(await handle.spent?.("chat")).toBe(0);
  });

  it("sets a TTL so day counters clean themselves up", async () => {
    const expires: Array<{ key: string; seconds: number }> = [];
    const redis = fakeRedis({
      async expire(key, seconds) {
        expires.push({ key, seconds });
        return 1;
      },
    });
    const handle = createRedisBudgetHandle(redis, { now: () => 0 });
    await handle.record(5, "chat");
    expect(expires[0].seconds).toBe(60 * 60 * 48);
  });

  it("FAILS OPEN and reports the error when Redis is unreachable", async () => {
    // Failing closed would take the whole AI surface down on a cache blip; the ceiling is
    // itself a safety margin. The choice is explicit and the error is retrievable.
    const redis = fakeRedis({
      async get() {
        throw new Error("ECONNREFUSED");
      },
      async incrby() {
        throw new Error("ECONNREFUSED");
      },
    });
    const handle = createRedisBudgetHandle(redis, { limitTokens: 1, now: () => 0 });
    expect(await handle.check(1_000_000, "chat")).toBe(true);
    await handle.record(10, "chat"); // must not throw
    expect(handle.lastError()).toContain("ECONNREFUSED");
  });

  it("ignores a zero/negative record instead of writing it", async () => {
    const redis = fakeRedis();
    const handle = createRedisBudgetHandle(redis, { now: () => 0 });
    await handle.record(0, "chat");
    await handle.record(-5, "chat");
    expect(redis.store.size).toBe(0);
  });

  it("treats a corrupt stored value as zero rather than NaN", async () => {
    const redis = fakeRedis({
      async get() {
        return "not-a-number";
      },
    });
    const handle = createRedisBudgetHandle(redis, { limitTokens: 100, now: () => 0 });
    expect(await handle.spent?.("chat")).toBe(0);
    expect(await handle.check(50, "chat")).toBe(true);
  });

  it("namespaces by keyPrefix so two deployments can share one Redis", async () => {
    const redis = fakeRedis();
    const a = createRedisBudgetHandle(redis, { keyPrefix: "envA", now: () => 0 });
    const b = createRedisBudgetHandle(redis, { keyPrefix: "envB", now: () => 0 });
    await a.record(10, "chat");
    expect(await b.spent?.("chat")).toBe(0);
  });
});
