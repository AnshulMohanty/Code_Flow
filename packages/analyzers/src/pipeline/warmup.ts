/**
 * Boot-time warm-up: a registry of process-lifetime resources initialised once at boot and reused by
 * every job in the process (not a pool of anything). What is cold on a process's first job:
 * tree-sitter WASM grammars, provider clients (and provider selection), and the retrieval schema
 * (`CREATE EXTENSION` / `CREATE TABLE`). Warming them up front stops the first job paying for them.
 *
 * `warmedUp` is exposed on /health and gates /ready, so an orchestrator holds traffic until the process
 * is warm. Warming changes only timing: tasks are idempotent and return nothing anything reads, so a
 * warm and a cold process produce byte-identical results.
 */

export type WarmupTaskStatus = "pending" | "running" | "warm" | "failed" | "skipped";

export interface WarmupTaskState {
  name: string;
  status: WarmupTaskStatus;
  /** Milliseconds the task took. Present once it settles. */
  durationMs?: number;
  /** Present when it failed — warming is best-effort, so a failure is recorded, not thrown. */
  error?: string;
  /**
   * True when this task is REQUIRED for readiness. A non-required task that fails leaves the
   * process warm: failing to pre-connect to Postgres should not stop the deterministic pipeline
   * from serving, because that pipeline does not need Postgres.
   */
  required: boolean;
}

export interface WarmupTask {
  name: string;
  /** Idempotent. Must not return anything a caller depends on — see the determinism note. */
  run(): Promise<void>;
  /** Default true. */
  required?: boolean;
}

export interface WarmupState {
  /** True when every REQUIRED task is warm. */
  warmedUp: boolean;
  /** True while warming is in progress. */
  warming: boolean;
  tasks: WarmupTaskState[];
  /** Total wall-clock of the last `warmUp()` call. */
  durationMs?: number;
  /** ISO timestamp of the last successful warm-up, when there has been one. */
  warmedAt?: string;
}

export interface WarmupRegistry {
  register(task: WarmupTask): void;
  /**
   * Run every pending task. Idempotent and CONCURRENCY-SAFE: two callers racing at boot share one
   * in-flight promise rather than both warming, because warming twice is wasted work at exactly the
   * moment the process has none to spare.
   */
  warmUp(): Promise<WarmupState>;
  state(): WarmupState;
  /** Test seam: forget everything. */
  reset(): void;
}

export interface WarmupOptions {
  /** Injectable clock (ms), so durations are deterministic in tests. */
  now?: () => number;
  /** Injectable ISO clock, for the same reason. */
  isoNow?: () => string;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export function createWarmupRegistry(options: WarmupOptions = {}): WarmupRegistry {
  const now = options.now ?? Date.now;
  const isoNow = options.isoNow ?? (() => new Date().toISOString());
  const tasks = new Map<string, WarmupTask>();
  const states = new Map<string, WarmupTaskState>();
  let inFlight: Promise<WarmupState> | null = null;
  let totalDurationMs: number | undefined;
  let warmedAt: string | undefined;

  const snapshot = (): WarmupState => {
    const list = [...tasks.keys()].sort().map((name) => states.get(name) as WarmupTaskState);
    const required = list.filter((task) => task.required);
    return {
      // An empty registry is NOT warm. "Nothing to do" and "ready" are different claims, and
      // reporting an unconfigured process as ready is how a misconfiguration reaches users.
      warmedUp: required.length > 0 && required.every((task) => task.status === "warm"),
      warming: inFlight !== null,
      tasks: list,
      ...(totalDurationMs !== undefined ? { durationMs: totalDurationMs } : {}),
      ...(warmedAt ? { warmedAt } : {}),
    };
  };

  return {
    register(task: WarmupTask) {
      // Re-registering the same name REPLACES rather than duplicating, so a module loaded twice
      // does not double-warm.
      tasks.set(task.name, task);
      if (!states.has(task.name) || states.get(task.name)?.status !== "warm") {
        states.set(task.name, { name: task.name, status: "pending", required: task.required !== false });
      }
    },

    async warmUp(): Promise<WarmupState> {
      if (inFlight) return inFlight;
      const startedAt = now();
      inFlight = (async () => {
        // Tasks run CONCURRENTLY: they are independent process-level initialisations, and warming
        // them one at a time would make the cold start as slow as the sum rather than the max.
        await Promise.all(
          [...tasks.values()].map(async (task) => {
            const current = states.get(task.name);
            if (current?.status === "warm") return;
            const at = now();
            states.set(task.name, { name: task.name, status: "running", required: task.required !== false });
            try {
              await task.run();
              states.set(task.name, {
                name: task.name,
                status: "warm",
                durationMs: now() - at,
                required: task.required !== false,
              });
            } catch (error) {
              // Best-effort: a failed warm-up is RECORDED, not thrown. Throwing would take a
              // process down at boot over an optimisation, and the cold path still works.
              const message = error instanceof Error ? error.message : String(error);
              states.set(task.name, {
                name: task.name,
                status: "failed",
                durationMs: now() - at,
                error: message,
                required: task.required !== false,
              });
              options.logger?.warn(`Warm-up task "${task.name}" failed (continuing cold).`, { error: message });
            }
          }),
        );
        totalDurationMs = now() - startedAt;
        const state = snapshot();
        if (state.warmedUp) warmedAt = isoNow();
        options.logger?.info(
          `Warm-up ${state.warmedUp ? "complete" : "incomplete"} in ${totalDurationMs}ms: ` +
            state.tasks.map((task) => `${task.name}=${task.status}(${task.durationMs ?? 0}ms)`).join(" "),
        );
        return snapshot();
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },

    state: snapshot,

    reset() {
      tasks.clear();
      states.clear();
      inFlight = null;
      totalDurationMs = undefined;
      warmedAt = undefined;
    },
  };
}

/**
 * The process-wide registry.
 *
 * A module-level singleton, which is the right shape here and worth justifying: the things being
 * warmed ARE process-global (a WASM grammar cache, a connection pool), so threading a registry
 * through every call site would be modelling a per-call concern that does not exist. `reset()`
 * keeps it testable.
 */
export const warmupRegistry: WarmupRegistry = createWarmupRegistry();
