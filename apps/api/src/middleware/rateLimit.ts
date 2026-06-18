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
