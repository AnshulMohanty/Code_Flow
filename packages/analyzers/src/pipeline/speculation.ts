import type { AnalysisCacheHandle } from "@codeflow/shared-types";

/**
 * SPECULATIVE PREFETCH (V3-P5 task 1) — with a real rollback.
 *
 * THE IDEA. On the hard tail (a complex community, a question that is about to trigger follow-ups),
 * some of the next requests are predictable: a user who just asked about a file usually asks who
 * calls it, and a supervisor about to synthesise a hard community will want that community's central
 * files. Computing those DURING the current wait costs wall-clock nothing, because the process is
 * blocked on a provider anyway.
 *
 * WHY IT NEEDS A ROLLBACK, which is the part that is easy to get wrong. A speculative result is a
 * GUESS. If it is written straight into the shared cache and the guess was wrong, the cache now
 * holds an entry that was never validated by a real request — and the next real request may be
 * SERVED it. That is not a wasted computation, it is a correctness hazard: a speculative embedding
 * computed against a stale index, or a graph answer computed before a slice settled, would be
 * indistinguishable from a real one.
 *
 * So speculation writes to a STAGING layer. `commit()` promotes only the keys a real request
 * actually asked for; `rollback()` discards the rest. The shared cache never sees an unvalidated
 * entry, which means a wrong guess costs exactly the CPU it used and nothing else.
 *
 * ALSO DELIBERATE: speculation never spends money it was not going to spend. Prefetch tasks are
 * either free (graph traversals) or cache-warming for a call the caller is about to make anyway.
 * A paid speculative provider call would be gambling with the daily budget, and the budget is the
 * one resource in this system that cannot be rolled back.
 */

export interface SpeculationTask<T = unknown> {
  /** The cache key this task will produce. */
  key: string;
  /** Compute it. MUST be free or cache-warming — never a paid provider call. */
  compute(): Promise<T>;
  /** Human-readable, for the report. */
  label: string;
}

export interface SpeculationStats {
  launched: number;
  /** Speculations a real request went on to ask for. */
  hits: number;
  /** Speculations nothing asked for; discarded on rollback. */
  discarded: number;
  /** Tasks that threw. A failed speculation is a non-event by design. */
  failed: number;
  /** hits / launched, or 0 when nothing was launched. The number that decides whether speculating
   *  is worth doing at all — a hit rate near zero means the prediction is wrong and should stop. */
  hitRate: number;
  labels: { hit: string[]; discarded: string[]; failed: string[] };
}

export interface Speculator {
  /** Launch a task. Fire-and-forget: never awaited by the caller, never allowed to reject. */
  speculate<T>(task: SpeculationTask<T>): void;
  /**
   * Ask for a key. Returns the staged value when one exists (a HIT), else null.
   * A hit marks the key for promotion on `commit()`.
   */
  claim<T>(key: string): Promise<T | null>;
  /** Promote CLAIMED keys into the real cache; discard the rest. */
  commit(): Promise<SpeculationStats>;
  /** Discard everything, promoting nothing. */
  rollback(): SpeculationStats;
  stats(): SpeculationStats;
}

export interface SpeculatorOptions {
  /** The real cache. Only written by `commit()`, and only for claimed keys. */
  cache: AnalysisCacheHandle;
  /** Max concurrent speculations. Bounded because speculation must never starve the real work it
   *  is trying to speed up. */
  maxConcurrent?: number;
  logger?: { warn(message: string, meta?: unknown): void };
}

const DEFAULT_MAX_CONCURRENT = 3;

export function createSpeculator(options: SpeculatorOptions): Speculator {
  /** key -> the in-flight or settled staged computation. */
  const staged = new Map<string, { label: string; promise: Promise<unknown> }>();
  const claimed = new Set<string>();
  const failed = new Map<string, string>();
  let inFlight = 0;
  const queue: SpeculationTask[] = [];

  const pump = () => {
    while (inFlight < (options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) && queue.length > 0) {
      const task = queue.shift() as SpeculationTask;
      inFlight += 1;
      const promise = task
        .compute()
        .catch((error: unknown) => {
          // A failed speculation is a NON-EVENT: it is recorded and swallowed. Letting it reject
          // would turn an optimisation into an unhandled rejection that can take the process down —
          // the exact opposite of what a latency feature should do.
          failed.set(task.key, error instanceof Error ? error.message : String(error));
          options.logger?.warn(`Speculation "${task.label}" failed (ignored).`, { key: task.key });
          return null;
        })
        .finally(() => {
          inFlight -= 1;
          pump();
        });
      staged.set(task.key, { label: task.label, promise });
    }
  };

  const buildStats = (committedKeys: Set<string>): SpeculationStats => {
    const hit: string[] = [];
    const discarded: string[] = [];
    const failedLabels: string[] = [];
    for (const [key, entry] of staged) {
      if (failed.has(key)) failedLabels.push(entry.label);
      else if (committedKeys.has(key)) hit.push(entry.label);
      else discarded.push(entry.label);
    }
    const launched = staged.size;
    return {
      launched,
      hits: hit.length,
      discarded: discarded.length,
      failed: failedLabels.length,
      hitRate: launched === 0 ? 0 : hit.length / launched,
      labels: { hit: hit.sort(), discarded: discarded.sort(), failed: failedLabels.sort() },
    };
  };

  return {
    speculate<T>(task: SpeculationTask<T>) {
      // Already staged (or already claimed) ⇒ do not recompute. Speculating twice for the same key
      // is pure waste at the moment there is least capacity for it.
      if (staged.has(task.key)) return;
      queue.push(task as SpeculationTask);
      pump();
    },

    async claim<T>(key: string): Promise<T | null> {
      const entry = staged.get(key);
      if (!entry) return null;
      const value = (await entry.promise) as T | null;
      if (value === null || failed.has(key)) return null;
      // Claimed ⇒ a real request asked for exactly this, so it is validated and may be promoted.
      claimed.add(key);
      return value;
    },

    async commit(): Promise<SpeculationStats> {
      for (const key of claimed) {
        const entry = staged.get(key);
        if (!entry) continue;
        const value = await entry.promise;
        if (value !== null && !failed.has(key)) await options.cache.set(key, value);
      }
      const stats = buildStats(new Set(claimed));
      staged.clear();
      claimed.clear();
      failed.clear();
      return stats;
    },

    rollback(): SpeculationStats {
      // Nothing reaches the real cache. That is the whole guarantee: a wrong guess costs CPU only.
      const stats = buildStats(new Set());
      staged.clear();
      claimed.clear();
      failed.clear();
      return stats;
    },

    stats: () => buildStats(new Set(claimed)),
  };
}
