/**
 * ANSWER-LATENCY SAMPLES (V3-FINAL) — so "p50 answer latency" is a measurement, not a slogan.
 *
 * WHY THIS EXISTS. The design surfaces a p50 answer latency in the HUD and in the NUMBERS section.
 * Nothing in the analysis result carries one: `pipeline.stages[].durationMs` measures the INDEX
 * build, which is a different question from "how long does an answer take". Without a source the
 * only honest options were to render an em-dash forever or to invent a number — and inventing it is
 * exactly the failure the grounding invariant exists to prevent, in the one place a reader is most
 * likely to take a figure at face value.
 *
 * SO IT IS MEASURED, at the only place that knows: around the ask handler, per request.
 *
 * WHAT IT HONESTLY IS, stated so the UI can say it: a PER-PROCESS, in-memory ring of the most recent
 * answers this API replica served. It is not a fleet-wide percentile, it does not survive a restart,
 * and two replicas report two different numbers. That is a real limitation and the endpoint reports
 * `sampleCount` and `scope: "process"` alongside the figure so a reader can weigh it. Making it
 * global means putting the samples in the Redis this process already has — the same wiring task
 * ledger #21 tracks for the answer cache — and is deliberately NOT done on a guess about whether
 * anyone needs it.
 *
 * BOUNDED, for the reason every in-memory structure in a long-lived process is: the ring holds a
 * fixed number of samples and drops the oldest, so a busy replica cannot leak through it.
 *
 * NOT MEASURED HERE: a refusal or an at-capacity response. Those are fast because they do no work,
 * and letting them into the sample would make the p50 look better the more often the service failed
 * to answer — a metric that improves when the product degrades is worse than no metric.
 */

/** Samples retained. Enough for a stable median, small enough to be free. */
export const LATENCY_WINDOW = 200;

export interface LatencySnapshot {
  /** Milliseconds. Null until at least one answer has been served. */
  p50Ms: number | null;
  /** Also reported, because a p50 alone hides the tail a user actually complains about. */
  p95Ms: number | null;
  /** How many samples the figures are computed from. A p50 over 2 samples is not a p50. */
  sampleCount: number;
  /** Always `"process"` today — see the module note on why that is stated rather than implied. */
  scope: "process";
}

const samples: number[] = [];

/** Record one ANSWERED response's wall-clock. Refusals and at-capacity responses are excluded. */
export function recordAnswerLatency(durationMs: number): void {
  // A negative or non-finite duration means the caller measured wrong; recording it would corrupt
  // every percentile that follows, so it is dropped rather than clamped.
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  samples.push(durationMs);
  if (samples.length > LATENCY_WINDOW) samples.splice(0, samples.length - LATENCY_WINDOW);
}

export function answerLatency(): LatencySnapshot {
  if (samples.length === 0) {
    return { p50Ms: null, p95Ms: null, sampleCount: 0, scope: "process" };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    sampleCount: sorted.length,
    scope: "process",
  };
}

/** Test seam: forget every sample. */
export function resetAnswerLatencyForTests(): void {
  samples.length = 0;
}

/**
 * Nearest-rank percentile on an already-sorted array.
 *
 * Nearest-rank rather than interpolated: an interpolated p50 over a handful of samples invents a
 * millisecond value that no request actually took, and every figure here is meant to be a real
 * observation.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}
