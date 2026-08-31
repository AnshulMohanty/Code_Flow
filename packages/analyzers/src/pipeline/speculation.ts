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
  /**
   * key -> the staged computation. Registered at SPECULATE time, not at start time.
   *
   * FIXED IN V3-FINAL, and only wiring this up exposed it: the first version registered a key in
   * `staged` when `pump()` DEQUEUED it, so any task still waiting on the concurrency bound was
   * invisible to `claim` — it returned null, the caller recomputed the thing from scratch, and the
   * queued task later ran anyway and was discarded. So the bound turned a hit into a miss PLUS a
   * duplicated computation, which is worse than not speculating at all. It was latent because the
   * only test that queued more tasks than the bound asserted peak concurrency and never checked that
   * the claims returned values.
   *
   * Now the promise is a DEFERRED created at enqueue time and resolved when the task actually runs,
   * so `claim` awaits a queued task instead of missing it.
   */
  const staged = new Map<string, { label: string; promise: Promise<unknown> }>();
  const claimed = new Set<string>();
  const failed = new Map<string, string>();
  let inFlight = 0;
  const queue: Array<{ task: SpeculationTask; resolve: (value: unknown) => void }> = [];

  const pump = () => {
    while (inFlight < (options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) && queue.length > 0) {
      const pending = queue.shift() as { task: SpeculationTask; resolve: (value: unknown) => void };
      const { task, resolve } = pending;
      inFlight += 1;
      void task
        .compute()
        .catch((error: unknown) => {
          // A failed speculation is a NON-EVENT: it is recorded and swallowed. Letting it reject
          // would turn an optimisation into an unhandled rejection that can take the process down —
          // the exact opposite of what a latency feature should do.
          failed.set(task.key, error instanceof Error ? error.message : String(error));
          options.logger?.warn(`Speculation "${task.label}" failed (ignored).`, { key: task.key });
          return null;
        })
        .then((value) => resolve(value))
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  /**
   * Discard everything, INCLUDING tasks still waiting in the queue.
   *
   * Draining the queue is the part worth stating: once the run has decided what it wanted, an
   * unclaimed queued task is CPU nobody will ever use, and "a wrong guess costs exactly the CPU it
   * used" is only true if we stop starting new ones. Anything already awaiting a drained task's
   * promise gets null — a miss, which is the honest answer and infinitely better than a hang.
   */
  const settle = () => {
    for (const pending of queue) pending.resolve(null);
    queue.length = 0;
    staged.clear();
    claimed.clear();
    failed.clear();
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
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((settle) => {
        resolve = settle;
      });
      // Registered NOW, so a task waiting on the concurrency bound is still claimable — see the
      // `staged` note.
      staged.set(task.key, { label: task.label, promise });
      queue.push({ task: task as SpeculationTask, resolve });
      pump();
    },

    async claim<T>(key: string): Promise<T | null> {
      const entry = staged.get(key);
      if (!entry) return null;
      // A CLAIM IS PROOF THE GUESS WAS RIGHT, so it jumps the queue ahead of still-unproven ones.
      // The concurrency bound is deliberately NOT bypassed: a claimed task waits for a slot like any
      // other, because running it immediately would break the one guarantee that stops speculation
      // from starving the work it is trying to speed up.
      const index = queue.findIndex((pending) => pending.task.key === key);
      if (index > 0) queue.unshift(...queue.splice(index, 1));
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
      settle();
      return stats;
    },

    rollback(): SpeculationStats {
      // Nothing reaches the real cache. That is the whole guarantee: a wrong guess costs CPU only.
      const stats = buildStats(new Set());
      settle();
      return stats;
    },

    stats: () => buildStats(new Set(claimed)),
  };
}

/**
 * A STAGE THAT DECLARES WHAT IT WILL WANT (wired V3-FINAL).
 *
 * WHY THE STAGE DECLARES AND THE ORCHESTRATOR LAUNCHES. Speculation needs two pieces of knowledge
 * that live in different places, and neither side can supply both:
 *
 *   - The ORCHESTRATOR knows the WINDOW. It is the only thing that knows a stage's declared reads
 *     are satisfied while the stage itself has not started yet — i.e. that there is a wait to spend.
 *   - The STAGE knows the WHAT. A cache key and how to compute it are stage internals, and an
 *     orchestrator that knew them would be an orchestrator that had to change every time a stage
 *     changed its cache.
 *
 * So this is the narrow optional capability that joins them, following `StageEmbeddingTarget`'s
 * precedent exactly: a plain interface a stage MAY satisfy, duck-typed at the call site, invisible to
 * every stage that does not.
 *
 * THE RULE A DECLARED TASK MUST OBEY is the module rule above: free, or cache-warming for a call the
 * stage is about to make anyway. Never a paid provider call. The budget is the one resource in this
 * system that cannot be rolled back, so speculating with it would be gambling rather than
 * optimising.
 */
export interface StageSpeculationSource {
  /**
   * Tasks this stage will want, computable now. Called by the orchestrator once the stage's declared
   * reads are satisfied and BEFORE the stage runs. Returning `[]` is normal — a stage that cannot
   * usefully speculate for this particular run (no working tree, no SHA) should say so rather than
   * stage something it will not claim.
   *
   * MUST be cheap and side-effect free: it builds task descriptors, it does not do the work.
   */
  speculations(context: {
    /** The slices already assigned, same snapshot the stage will receive. */
    prior: unknown;
    /** Resolved by Ingest; absent on a no-clone AI-only retry. */
    repoPath?: string;
    commitSha?: string;
  }): SpeculationTask[];
}

/** Duck-type check, so the orchestrator never has to know which stages opt in. */
export function isSpeculationSource(value: unknown): value is StageSpeculationSource {
  return typeof (value as StageSpeculationSource | null)?.speculations === "function";
}
