import type { AnalysisCacheHandle } from "@codeflow/shared-types";

/**
 * THE SHARED Q&A ANSWER CACHE (V3-P5 task 5, ledger #21).
 *
 * WHAT WAS WRONG. V3-P0 moved the daily budget onto a shared Redis counter — the wallet half of the
 * problem — but the ANSWER cache stayed a process-local Map. Consequences, both real and neither a
 * correctness bug: two API replicas each pay once for the same repeated question, and a restart
 * forgets every answer it had already bought. Cache-before-budget still held and the ceiling was
 * still shared, so this was never a spend-CEILING risk. It was pure waste, which is exactly the
 * kind of thing that is easy to leave forever because nothing breaks.
 *
 * THE FAILURE MODE THAT MATTERS IS THE ONE ON READ, and it decides the whole shape of this file. A
 * cache read that THROWS would fail a question that Redis has nothing to do with. A cache read that
 * returns null on failure makes the caller pay for an answer it may already own. The second is
 * strictly better — money, not correctness — so every operation here fails soft and reports.
 *
 * Note what that preserves: cache-before-budget is unchanged. A failed READ becomes a miss, which
 * takes the normal path (check the budget, call the provider, record actual usage). A failed WRITE
 * loses one cached answer. Neither can overspend the ceiling, because the ceiling is the Redis
 * counter and not this.
 *
 * A TTL, not an eviction policy. Answers are derived from an analysis pinned to a commit SHA, so
 * they never go stale in the usual sense — but the repository moves on, and an answer nobody has
 * asked for in a week is not worth memory. Expiry is a job Redis already does correctly.
 */

/** The Redis subset this cache needs. Structurally satisfied by an `ioredis` instance. */
export interface CacheRedisLike {
  get(key: string): Promise<string | null>;
  /** `set(key, value, "EX", seconds)` — the ioredis expiry form. */
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export interface RedisAnalysisCacheOptions {
  redis: CacheRedisLike;
  /** Key prefix. Namespaced so a shared Redis can also hold sessions, repo memory and the budget. */
  keyPrefix?: string;
  /** Entry lifetime. Default 7 days. */
  ttlSeconds?: number;
  /** Largest value written, in bytes of UTF-8 JSON. Default 256 KB. */
  maxValueBytes?: number;
  onError?(error: unknown, operation: string): void;
}

const DEFAULT_PREFIX = "codeflow:qa-cache";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 256 KB. A bound rather than a guess: a Q&A answer plus its citations is a few KB, so anything
 * approaching this is not an answer — it is a bug, or a caller stuffing an entire analysis through
 * a cache handle. Refusing to write it keeps one pathological entry from evicting a shared Redis's
 * useful contents, and the refusal is REPORTED rather than silent, because a cache that silently
 * declines to store the thing you asked it to store is a confusing thing to debug.
 */
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;

export function createRedisAnalysisCache(options: RedisAnalysisCacheOptions): AnalysisCacheHandle {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const maxBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  const report = (error: unknown, operation: string) => options.onError?.(error, operation);

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      try {
        const raw = await options.redis.get(`${prefix}:${key}`);
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch (error) {
        // A miss, not a throw. Costs one provider call; a throw would cost the whole answer.
        report(error, "get");
        return null;
      }
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      try {
        const serialised = JSON.stringify(value);
        // `JSON.stringify(undefined)` is `undefined`, not a string. Writing it would store the
        // literal text "undefined", which parses back as a SyntaxError on the next read — a
        // poisoned key that costs a provider call every time until it expires.
        if (serialised === undefined) {
          report(new Error(`refusing to cache an undefined value for key ${key}`), "set");
          return;
        }
        const bytes = Buffer.byteLength(serialised, "utf8");
        if (bytes > maxBytes) {
          report(new Error(`refusing to cache ${bytes} bytes for key ${key} (max ${maxBytes})`), "set");
          return;
        }
        await options.redis.set(`${prefix}:${key}`, serialised, "EX", ttl);
      } catch (error) {
        // A lost write costs one future cache hit. Reported so a Redis that rejects every write is
        // diagnosable rather than merely expensive.
        report(error, "set");
      }
    },
  };
}
