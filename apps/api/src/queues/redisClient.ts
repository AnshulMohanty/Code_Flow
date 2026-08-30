import type { BudgetRedisLike } from "@codeflow/analyzers";
import type { RateLimitRedisLike } from "../middleware/rateLimit.js";
import { env, isTestEnv } from "../config/env.js";
import { createRedisConnectionOptions, isRedisQueueEnabled } from "./queueConnection.js";

/**
 * One lazily-created Redis connection for the API's shared state (V3-P0): the daily LLM
 * budget and the per-IP rate limit. Both were per-process before, which made the "global"
 * ceiling and the "per-IP" limit per-INSTANCE — neither survived a restart or a second
 * replica.
 *
 * `ioredis` is imported DYNAMICALLY so:
 *   - the hermetic test suite never loads a Redis driver (there is no Redis in tests), and
 *   - a deployment without `REDIS_URL` starts fine and falls back to in-memory.
 * It is a direct dependency (not merely BullMQ's transitive one) so the import is explicit.
 */

/** The subset both stores need. Structurally satisfied by an `ioredis` instance. */
export type SharedRedis = BudgetRedisLike & RateLimitRedisLike;

let clientPromise: Promise<SharedRedis | null> | null = null;

/** True when a shared Redis is configured AND we are not in the hermetic test env. */
export function isSharedRedisEnabled(): boolean {
  return isRedisQueueEnabled();
}

/**
 * The shared Redis client, or `null` when Redis is unavailable/disabled (tests, or no
 * `REDIS_URL`). Resolving to null is the signal for callers to use their in-memory store —
 * a degradation the caller then SURFACES rather than hides.
 */
export async function getSharedRedis(): Promise<SharedRedis | null> {
  if (isTestEnv() || !env.redisUrl) return null;
  clientPromise ??= connect();
  return clientPromise;
}

async function connect(): Promise<SharedRedis | null> {
  try {
    const { Redis } = await import("ioredis");
    const options = createRedisConnectionOptions();
    const client = new Redis({
      ...options,
      // Keep API request latency bounded: a dead Redis must fail fast, not hang a request.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // An 'error' listener is required — without one, ioredis surfaces connection errors as
    // unhandled exceptions and can take the process down.
    client.on("error", () => {
      /* handled per-call by the stores, which fall back or fail open */
    });
    return client as unknown as SharedRedis;
  } catch {
    // Driver missing or connection construction failed — callers degrade to in-memory.
    return null;
  }
}

/** Test seam: drop the memoized client so a suite can re-evaluate the environment. */
export function resetSharedRedisForTests(): void {
  clientPromise = null;
}
