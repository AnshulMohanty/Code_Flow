/**
 * AUTOSCALE-READY WORKER CONFIGURATION (V3-P5 task 5).
 *
 * The worker was already correct for a SINGLE instance: BullMQ hands each job to exactly one
 * consumer, SIGTERM is handled, and `worker.close()` waits for in-flight jobs. What was missing for
 * a scaler is everything it needs to make a decision and everything the process needs to survive
 * the decision:
 *
 *   1. CONCURRENCY WAS HARDCODED to 2. Two is right for a 1-vCPU box and wrong for a 4-vCPU one, and
 *      an operator changing it should not have to rebuild the image.
 *   2. A SCALER CANNOT SEE THE QUEUE. Every autoscaler worth using (KEDA, Render, Fly, a plain
 *      HPA + adapter) scales on a metric it can read over HTTP. Queue DEPTH is the right one here,
 *      not CPU: an analysis job is IO- and provider-bound, so CPU stays low while jobs pile up, and
 *      a CPU rule would refuse to scale exactly when the backlog is worst.
 *   3. THE DRAIN WINDOW WAS UNSTATED. An analysis job can run for minutes; a scale-in sends SIGTERM
 *      and then SIGKILL after a grace period. If the grace period is shorter than the job, the job
 *      is killed mid-flight — which is survivable (BullMQ re-delivers a stalled job) but wasteful,
 *      and silently so. The number a platform must be configured with is stated here, in code, so
 *      it can be read off rather than guessed.
 *
 * NOTHING HERE READS AN API OR SPAWNS ANYTHING. It is arithmetic over env plus documented
 * constants, so it is fully testable and the recommendation is auditable.
 */

/** Concurrency default. 2 matches the previous hardcoded value, so an unset env changes nothing. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * The concurrency ceiling per instance, and it is a deliberate bound rather than a shrug.
 *
 * A single job holds a shallow clone on disk, a tree-sitter parse in memory, and (with AI enabled)
 * an in-flight provider request. The binding constraint is MEMORY, not CPU: eight concurrent
 * analyses of large repositories on a 512MB instance is an OOM kill, which loses all eight jobs
 * rather than queueing them. Scaling OUT is the correct answer past this point, which is what the
 * queue-depth metric below exists to trigger.
 */
export const MAX_CONCURRENCY = 8;

/**
 * Jobs-per-instance the scale rule targets.
 *
 * Set equal to concurrency: a backlog is "handled" when every queued job has a slot. A lower target
 * scales out on a queue that is about to drain anyway (thrash); a higher one deliberately keeps a
 * backlog, which for a user-facing analysis means waiting for no reason.
 */
export function targetQueueDepthPerInstance(concurrency: number): number {
  return Math.max(1, concurrency);
}

/**
 * The drain window a platform must allow between SIGTERM and SIGKILL, in seconds.
 *
 * Derived from the job budget, not chosen: the pipeline's own per-run ceiling is the longest a
 * single job can legitimately take, and the drain must outlast one job plus a margin for the Mongo
 * and Postgres disconnects. Under-configuring this does not corrupt anything — BullMQ re-delivers
 * the stalled job — but it wastes the whole run, including any provider spend it had already
 * incurred, which is the part worth avoiding.
 */
export const RECOMMENDED_DRAIN_SECONDS = 300;

export interface ScalingConfig {
  concurrency: number;
  /** Port for the liveness/readiness/metrics server. 0 disables it. */
  healthPort: number;
  /** What a scaler should aim for, so the rule can be generated rather than transcribed. */
  targetQueueDepth: number;
  drainSeconds: number;
  /** Anything the env asked for that could not be honoured, for the operator to see at boot. */
  warnings: string[];
}

/**
 * Resolve the scaling config from the environment.
 *
 * OUT-OF-RANGE VALUES ARE CLAMPED AND ANNOUNCED, not rejected. A worker that refuses to boot
 * because `WORKER_CONCURRENCY=99` is a worse outcome than one that runs at 8 and says so — a
 * failed boot during a scale-out event removes capacity at the moment it is most needed.
 */
export function resolveScalingConfig(source: NodeJS.ProcessEnv = process.env): ScalingConfig {
  const warnings: string[] = [];

  const concurrency = (() => {
    const raw = source.WORKER_CONCURRENCY;
    if (!raw) return DEFAULT_CONCURRENCY;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      warnings.push(`WORKER_CONCURRENCY="${raw}" is not a positive integer; using ${DEFAULT_CONCURRENCY}.`);
      return DEFAULT_CONCURRENCY;
    }
    if (parsed > MAX_CONCURRENCY) {
      warnings.push(
        `WORKER_CONCURRENCY=${parsed} exceeds the per-instance ceiling of ${MAX_CONCURRENCY} ` +
          "(memory-bound, not CPU-bound); clamped. Scale OUT past this point.",
      );
      return MAX_CONCURRENCY;
    }
    return parsed;
  })();

  const healthPort = (() => {
    const raw = source.WORKER_HEALTH_PORT;
    if (raw === undefined) return 0;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      warnings.push(`WORKER_HEALTH_PORT="${raw}" is not a valid port; the health server stays OFF.`);
      return 0;
    }
    return parsed;
  })();

  return {
    concurrency,
    healthPort,
    targetQueueDepth: targetQueueDepthPerInstance(concurrency),
    drainSeconds: RECOMMENDED_DRAIN_SECONDS,
    warnings,
  };
}

/**
 * The scale rule, rendered from the resolved config.
 *
 * Emitted at boot so the deployed process states the rule it was built for. Copy-pasteable into
 * whatever the platform wants; the numbers come from the same place the worker's own behaviour does,
 * which is the point — a scale rule transcribed by hand into a dashboard drifts from the code
 * silently, and that drift is invisible until a backlog does not clear.
 */
export function describeScaleRule(config: ScalingConfig): string {
  return [
    `scale on: BullMQ queue depth (waiting + delayed) from GET /metrics on port ${config.healthPort || "<disabled>"}`,
    `target: ${config.targetQueueDepth} job(s) per instance`,
    `concurrency: ${config.concurrency} per instance (ceiling ${MAX_CONCURRENCY})`,
    `terminationGracePeriodSeconds: >= ${config.drainSeconds} (an analysis job must finish or it is re-run)`,
    "do NOT scale on CPU: analysis is IO/provider-bound, so CPU stays low while the queue grows",
  ].join("\n");
}
