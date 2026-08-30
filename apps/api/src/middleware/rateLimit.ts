import type { RequestHandler } from "express";
import { RATE_MAX, RATE_WINDOW_MS } from "@codeflow/config";
import { createErrorResponse } from "./errorHandler.js";

/**
 * Per-IP rate-limit store (Guard 4). Injectable so prod uses Redis (shared across API
 * instances) while tests use an in-memory map. A `hit` records one request for `key` in
 * the current fixed window and returns the running count + when the window resets.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>;
}

/**
 * The minimal Redis surface the fixed-window limiter needs. Declared + INJECTED so this
 * module has no Redis dependency and tests can drive a fake.
 */
export interface RateLimitRedisLike {
  /** Atomically increment `key`, returning the new value. */
  incr(key: string): Promise<number>;
  /** Set a TTL in seconds. */
  expire(key: string, seconds: number): Promise<unknown>;
  /** Remaining TTL in seconds; -1 = no TTL, -2 = no key. */
  pttl(key: string): Promise<number>;
}

/**
 * Redis-backed fixed-window store — the PRODUCTION swap (resolves the "prod uses Redis"
 * comment this interface has carried since Guard 4 landed). The limit now holds ACROSS API
 * instances and SURVIVES a restart, neither of which the in-memory map could do.
 *
 * Window mechanics: the key is bucketed by `floor(now / windowMs)`, so the window boundary
 * is derived arithmetically instead of stored — that makes `INCR` + `EXPIRE` sufficient and
 * keeps the operation atomic without a Lua script.
 *
 * On a Redis error it FAILS OPEN (reports a count of 1, i.e. "allowed") and records the
 * error. Failing closed would turn a cache blip into a total outage of the analyze endpoint;
 * an abuse guard is not worth that, and the choice is explicit rather than accidental.
 */
export function createRedisRateLimitStore(
  redis: RateLimitRedisLike,
  options: { keyPrefix?: string } = {},
): RateLimitStore & { lastError(): string | null } {
  const prefix = options.keyPrefix ?? "codeflow:ratelimit";
  let lastError: string | null = null;

  return {
    async hit(key, windowMs, now) {
      const bucket = Math.floor(now / windowMs);
      const windowStart = bucket * windowMs;
      const redisKey = `${prefix}:${key}:${bucket}`;
      try {
        const count = await redis.incr(redisKey);
        if (count === 1) {
          // First hit in this bucket — give the key a TTL so it self-cleans.
          await redis.expire(redisKey, Math.ceil(windowMs / 1000) + 1);
        }
        return { count, resetAt: windowStart + windowMs };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        return { count: 1, resetAt: windowStart + windowMs }; // fail OPEN — documented above
      }
    },
    lastError() {
      return lastError;
    },
  };
}

/** In-memory fixed-window store — the test default (single-process only). */
export function createInMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; windowStart: number }>();
  return {
    async hit(key, windowMs, now) {
      const existing = windows.get(key);
      if (!existing || now - existing.windowStart >= windowMs) {
        const fresh = { count: 1, windowStart: now };
        windows.set(key, fresh);
        return { count: 1, resetAt: now + windowMs };
      }
      existing.count += 1;
      return { count: existing.count, resetAt: existing.windowStart + windowMs };
    },
  };
}

export interface RateLimitOptions {
  store?: RateLimitStore;
  windowMs?: number;
  max?: number;
  now?: () => number;
}

/**
 * Express middleware enforcing a per-IP fixed-window rate limit on the analyze-enqueue
 * endpoint. Over the limit ⇒ 429 with a clear message + `Retry-After`. SEPARATE from the
 * global daily LLM budget (Guard 5) — this protects the queue/abuse surface, that protects
 * the wallet. Limits default to @codeflow/config (P7-tunable).
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): RequestHandler {
  const store = options.store ?? createInMemoryRateLimitStore();
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const max = options.max ?? RATE_MAX;
  const now = options.now ?? Date.now;

  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    store.hit(key, windowMs, now()).then(
      ({ count, resetAt }) => {
        if (count > max) {
          const retryAfterMs = Math.max(0, resetAt - now());
          res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
          res
            .status(429)
            .json(createErrorResponse("RATE_LIMITED", "Too many requests — please slow down and try again shortly.", { retryAfterMs }));
          return;
        }
        next();
      },
      (error) => next(error),
    );
  };
}
