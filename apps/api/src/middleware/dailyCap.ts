import { createInMemoryRateLimitStore, type RateLimitStore } from "./rateLimit.js";

/**
 * Per-visitor DAILY caps on the two things that spend AI money: a new AI analysis and a question.
 *
 * WHY, next to the per-minute limit and the global daily token ceiling. The per-minute limit stops a
 * burst; the token ceiling stops the wallet. Neither stops ONE visitor from spending the whole day's
 * ceiling slowly, which on a demo funded with a few dollars means the next visitor — the recruiter —
 * sees "at capacity". A per-IP count per UTC day is the fair-share piece in between.
 *
 * Off unless configured (`DAILY_AI_ANALYSES_PER_IP`, `DAILY_QUESTIONS_PER_IP`): a self-hosted
 * instance has no wallet to protect from its own user. Reuses the rate limiter's store, so in
 * production the counts live in the same Redis and hold across instances and restarts.
 */
export type DailyCapKind = "ai-analysis" | "question";

export interface DailyCapLimits {
  aiAnalyses: number | null;
  questions: number | null;
}

export interface DailyCaps {
  readonly limits: DailyCapLimits;
  /** Count one use; `allowed: false` once the visitor is over today's cap. */
  consume(kind: DailyCapKind, visitor: string): Promise<{ allowed: boolean; limit: number | null; resetAt: number | null }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A positive whole number from env, else null (unset, blank, 0, junk ⇒ no cap). */
function capFromEnv(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function dailyCapLimitsFromEnv(env: Record<string, string | undefined>): DailyCapLimits {
  return {
    aiAnalyses: capFromEnv(env.DAILY_AI_ANALYSES_PER_IP),
    questions: capFromEnv(env.DAILY_QUESTIONS_PER_IP),
  };
}

export function createDailyCaps(
  options: { limits?: DailyCapLimits; store?: RateLimitStore; now?: () => number } = {},
): DailyCaps {
  const limits = options.limits ?? dailyCapLimitsFromEnv(process.env);
  const store = options.store ?? createInMemoryRateLimitStore();
  const now = options.now ?? Date.now;
  return {
    limits,
    async consume(kind, visitor) {
      const limit = kind === "ai-analysis" ? limits.aiAnalyses : limits.questions;
      if (limit === null) return { allowed: true, limit: null, resetAt: null };
      // The Redis store buckets by floor(now / window), so in production a 24 h window resets at UTC
      // midnight — the same boundary as the token ceiling, so "try again tomorrow" is one moment.
      const { count, resetAt } = await store.hit(`daily:${kind}:${visitor}`, DAY_MS, now());
      return { allowed: count <= limit, limit, resetAt };
    },
  };
}
