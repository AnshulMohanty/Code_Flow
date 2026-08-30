import type { BudgetHandle, BudgetUnit, TokenUsage } from "@codeflow/shared-types";
import { DAILY_LLM_BUDGET } from "@codeflow/config";
import { totalTokens } from "../util/tokens.js";

/**
 * The global daily LLM-spend ceiling (Guard 5), in two implementations behind one
 * interface: an in-memory handle (the hermetic test default) and a Redis-backed handle
 * (the production swap, shared by BOTH the worker and the API Q&A path).
 *
 * V3-P0 changed two things here:
 *   1. `record()` now accepts a `TokenUsage`, so a paid path can hand over the provider's
 *      REAL numbers instead of a character-count guess.
 *   2. Counters are per BILLING UNIT (`chat` / `embedding`). Chat and embedding tokens are
 *      priced differently and exhaust independently, so one pooled number could not express
 *      either ceiling correctly.
 */

/** Normalize either `record()` argument form to a token count. */
export function tokensOf(actual: number | TokenUsage): number {
  return typeof actual === "number" ? actual : totalTokens(actual);
}

const DEFAULT_UNIT: BudgetUnit = "chat";

/**
 * In-memory `BudgetHandle` — the test/default implementation. Tracks cumulative tokens per
 * unit for the current UTC day and resets when the day rolls over. `now` is injectable so
 * tests can advance the UTC day deterministically.
 *
 * Single-process only: the API and worker are separate processes, so production must use
 * `createRedisBudgetHandle` or the ceiling is enforced twice at half strength.
 */
export function createInMemoryBudgetHandle(
  limitTokens: number = DAILY_LLM_BUDGET,
  now: () => number = Date.now,
): BudgetHandle {
  let day = utcDay(now());
  const spentByUnit = new Map<BudgetUnit, number>();

  const rollover = () => {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      spentByUnit.clear();
    }
  };

  return {
    async check(estimatedTokens: number, unit: BudgetUnit = DEFAULT_UNIT): Promise<boolean> {
      rollover();
      return (spentByUnit.get(unit) ?? 0) + estimatedTokens <= limitTokens;
    },
    async record(actual: number | TokenUsage, unit: BudgetUnit = DEFAULT_UNIT): Promise<void> {
      rollover();
      spentByUnit.set(unit, (spentByUnit.get(unit) ?? 0) + tokensOf(actual));
    },
    async spent(unit: BudgetUnit = DEFAULT_UNIT): Promise<number> {
      rollover();
      return spentByUnit.get(unit) ?? 0;
    },
  };
}

/**
 * The minimal Redis surface the budget needs. Declared here and INJECTED rather than
 * importing a Redis client, so `@codeflow/analyzers` stays a dependency-free library, the
 * API and worker each pass their own connection, and tests can drive a fake.
 */
export interface BudgetRedisLike {
  /** Atomically add `amount` to `key` and return the new value. */
  incrby(key: string, amount: number): Promise<number>;
  get(key: string): Promise<string | null>;
  /** Set a TTL in seconds (used so day counters expire themselves). */
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RedisBudgetOptions {
  limitTokens?: number;
  now?: () => number;
  /** Key namespace, so two deployments can share one Redis without colliding. */
  keyPrefix?: string;
}

/** Two days, so a counter outlives the UTC boundary it belongs to before self-deleting. */
const DAY_TTL_SECONDS = 60 * 60 * 48;

/**
 * Redis-backed `BudgetHandle` — the PRODUCTION handle, shared by the worker (pipeline AI
 * stages) and the API (Q&A path). Before V3-P0 those were two separate ledgers (worker:
 * Mongo, API: per-process memory), so the "global daily ceiling" was neither global nor a
 * single ceiling — the API could spend a full budget the worker could not see. One Redis
 * counter per (day, unit) fixes that: `INCRBY` is atomic, so concurrent processes and
 * multiple instances all decrement the same ceiling.
 *
 * Reads are best-effort by design: if Redis is unreachable, `check` FAILS OPEN (returns
 * true) and logs. Failing closed would take the whole AI surface down on a cache blip,
 * which is a worse outcome than briefly over-spending against a ceiling that is itself a
 * safety margin — but the choice is explicit and reported, never silent.
 */
export function createRedisBudgetHandle(
  redis: BudgetRedisLike,
  options: RedisBudgetOptions = {},
): BudgetHandle & { lastError(): string | null } {
  const limitTokens = options.limitTokens ?? DAILY_LLM_BUDGET;
  const now = options.now ?? Date.now;
  const prefix = options.keyPrefix ?? "codeflow:budget";
  let lastError: string | null = null;

  const keyFor = (unit: BudgetUnit) => `${prefix}:${utcDay(now())}:${unit}`;

  const readSpent = async (unit: BudgetUnit): Promise<number | null> => {
    try {
      const raw = await redis.get(keyFor(unit));
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };

  return {
    async check(estimatedTokens: number, unit: BudgetUnit = DEFAULT_UNIT): Promise<boolean> {
      const spent = await readSpent(unit);
      if (spent === null) return true; // fail OPEN — documented above
      return spent + estimatedTokens <= limitTokens;
    },
    async record(actual: number | TokenUsage, unit: BudgetUnit = DEFAULT_UNIT): Promise<void> {
      const amount = tokensOf(actual);
      if (amount <= 0) return;
      const key = keyFor(unit);
      try {
        await redis.incrby(key, amount);
        // Refresh the TTL on every write; a key that is being written to is in use.
        await redis.expire(key, DAY_TTL_SECONDS);
      } catch (error: unknown) {
        // A lost write under-counts spend. Surfaced, not swallowed.
        lastError = error instanceof Error ? error.message : String(error);
      }
    },
    async spent(unit: BudgetUnit = DEFAULT_UNIT): Promise<number> {
      return (await readSpent(unit)) ?? 0;
    },
    lastError() {
      return lastError;
    },
  };
}

/** UTC calendar day key (YYYY-MM-DD) — the reset boundary. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
