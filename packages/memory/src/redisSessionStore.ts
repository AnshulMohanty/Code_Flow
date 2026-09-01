import type { NewTurn, SessionMemory, SessionMemoryStore } from "./contracts.js";
import { appendTurn, applySessionBounds, emptySession } from "./sessionStore.js";

/**
 * The Redis-backed session store — production adapter (V3-P3).
 *
 * INTEGRATION-ONLY: the hermetic suite drives it against a fake `MemoryRedisLike` (a Map with
 * the three methods), and a live Redis round trip is in the deferred manual bucket. That is the
 * same arrangement V3-P0 used for the shared budget and V3-P2 for pgvector, and for the same
 * reason: what can actually be wrong in this file is the key scheme, the TTL, the serialisation
 * and the bounds — all of which a fake exercises exactly.
 *
 * WHY IT MATTERS AT ALL, concretely: with the in-memory store, a conversation lives in one API
 * process's heap. Two replicas behind a load balancer give a user two different conversations,
 * and a restart forgets every follow-up. That is not a performance difference, it is a different
 * product.
 *
 * A TTL, not a size cap, bounds the whole store: conversations are short-lived, nobody returns
 * to a two-week-old thread, and expiry is a job Redis already does correctly. The per-session
 * bounds still apply on top (see `applySessionBounds`) because they bound the PROMPT, which is a
 * separate concern from bounding storage.
 */

/** The Redis subset this store needs. Structurally satisfied by an `ioredis` instance. */
export interface MemoryRedisLike {
  get(key: string): Promise<string | null>;
  /** `set(key, value, "EX", seconds)` — the ioredis expiry form. */
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisSessionStoreOptions {
  redis: MemoryRedisLike;
  /** Key prefix. Namespaced so a shared Redis can also hold the budget and the rate limiter. */
  keyPrefix?: string;
  /** Session lifetime in seconds. Default 24h. */
  ttlSeconds?: number;
  /** Called when Redis fails. Default: no reporting (the caller decides what to do). */
  onError?(error: unknown, operation: string): void;
}

const DEFAULT_PREFIX = "codeflow:session";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export function createRedisSessionStore(options: RedisSessionStoreOptions): SessionMemoryStore {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const key = (sessionId: string) => `${prefix}:${sessionId}`;

  /**
   * Redis failures FAIL SOFT here, and that is a different judgement from the budget's.
   *
   * The budget fails OPEN because a blip taking the AI surface down is worse than briefly
   * overspending a margin. Memory fails SOFT for the analogous reason with a smaller cost: a
   * lost session means a follow-up loses its context, so the user gets a worse answer to THIS
   * question — annoying, recoverable, and strictly better than a 500. It is reported, never
   * swallowed silently.
   */
  const report = (error: unknown, operation: string) => options.onError?.(error, operation);

  return {
    id: "redis-session-store",

    async load(sessionId: string): Promise<SessionMemory | null> {
      try {
        const raw = await options.redis.get(key(sessionId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as SessionMemory;
        // Bounds re-applied on READ as well as write: a value written by an older build (or with
        // different constants) must not be able to inflate today's prompt.
        return applySessionBounds(parsed);
      } catch (error) {
        report(error, "load");
        return null;
      }
    },

    async append(sessionId: string, analysisId: string, turn: NewTurn): Promise<SessionMemory> {
      let base = emptySession(sessionId, analysisId);
      try {
        const raw = await options.redis.get(key(sessionId));
        if (raw) {
          const parsed = JSON.parse(raw) as SessionMemory;
          // Same rule as the in-memory store: a session belongs to ONE analysis, so a different
          // analysisId starts fresh rather than mixing two repositories' entities.
          if (parsed.analysisId === analysisId) base = applySessionBounds(parsed);
        }
      } catch (error) {
        report(error, "append/read");
      }

      const next = appendTurn(base, turn);
      try {
        // Every write refreshes the TTL, so an active conversation does not expire mid-thread.
        await options.redis.set(key(sessionId), JSON.stringify(next), "EX", ttl);
      } catch (error) {
        // The turn still HAPPENED — the caller gets correct memory for this request, it just did
        // not persist. Returning `next` rather than `base` is the honest answer to "what does
        // memory look like now".
        report(error, "append/write");
      }
      return next;
    },

    async clear(sessionId: string): Promise<void> {
      try {
        await options.redis.del(key(sessionId));
      } catch (error) {
        report(error, "clear");
      }
    },
  };
}
