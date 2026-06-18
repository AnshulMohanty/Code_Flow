import type { BudgetHandle } from "@codeflow/shared-types";
import { DAILY_LLM_BUDGET } from "@codeflow/config";

/**
 * In-memory `BudgetHandle` — the test/default implementation of the global daily LLM-spend
 * ceiling (Guard 5). Tracks cumulative tokens for the current UTC day and resets when the
 * day rolls over. The worker uses a persistent (Mongo/Redis-backed) handle in prod so the
 * ceiling holds across instances/restarts; the mechanics are identical.
 *
 * `now` is injectable so tests can advance the UTC day deterministically.
 */
export function createInMemoryBudgetHandle(
  limitTokens: number = DAILY_LLM_BUDGET,
  now: () => number = Date.now,
): BudgetHandle {
  let day = utcDay(now());
  let spent = 0;

  const rollover = () => {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      spent = 0;
    }
  };

  return {
    async check(estimatedTokens: number): Promise<boolean> {
      rollover();
      return spent + estimatedTokens <= limitTokens;
    },
    async record(actualTokens: number): Promise<void> {
      rollover();
      spent += actualTokens;
    },
  };
}

/** UTC calendar day key (YYYY-MM-DD) — the reset boundary. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
