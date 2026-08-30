/**
 * THE FOUR LATENCY TIERS, reported INDEPENDENTLY (V3-P5 task 1).
 *
 * WHY FOUR NUMBERS AND NOT ONE. "How fast is CodeFlow" has four different answers, and averaging
 * them produces a number that describes nothing a user experiences:
 *
 *   coreAnalysis — clone + parse + graph + metrics. Deterministic, no provider. This is what a user
 *                  waits for before seeing ANYTHING, so it is the number that decides whether the
 *                  product feels alive.
 *   aiSynthesis  — the AI stages (synthesize + rag). Provider-bound, and the tier that layered
 *                  scheduling actually changes, because those two are the one parallel layer.
 *   qaCoreHit    — a question answered from cache. Should be single-digit milliseconds; if it is
 *                  not, something is doing I/O it should not.
 *   qaGenerate   — a question that reaches a provider. The tier a user feels most sharply, because
 *                  they are watching a cursor blink.
 *
 * Reporting them separately is also what makes a regression attributable: a rise in `coreAnalysis`
 * is a parser or graph problem, a rise in `aiSynthesis` is a provider or scheduling problem, and a
 * rise in `qaCoreHit` means a cache stopped working. One blended number hides all three.
 *
 * HERMETIC BY CONSTRUCTION. The bench drives MOCK providers with a configurable per-call delay, so
 * it measures THE ORCHESTRATION — scheduling, layering, cache hits — and not the internet. That is
 * the honest scope, stated up front: these numbers say how much time this codebase adds around a
 * provider call, and nothing about how fast the provider is. Real-provider numbers need keys and are
 * a Phase-7 item.
 */

export interface TierSample {
  tier: "coreAnalysis" | "aiSynthesis" | "qaCoreHit" | "qaGenerate";
  /** Wall-clock milliseconds. */
  ms: number;
  /** What was configured for this sample, so a number is never quoted without its conditions. */
  conditions: string;
}

export interface LatencyReport {
  samples: TierSample[];
  /** Per-tier best/median/worst across the samples for that tier. */
  tiers: Record<TierSample["tier"], { best: number; median: number; worst: number; runs: number } | null>;
  /** The comparison that justifies layered scheduling, when both modes were sampled. */
  scheduleComparison?: {
    sequentialMs: number;
    layeredMs: number;
    speedup: number;
  };
  notes: string[];
}

/** Time one async operation. Returns the value AND the elapsed span, so a caller never has to
 *  choose between measuring and using the result. */
export async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await work();
  return { value, ms: Date.now() - startedAt };
}

/**
 * Summarise samples per tier. MEDIAN rather than mean, deliberately: a bench on a shared machine
 * picks up scheduler noise as occasional large outliers, and a mean lets one of those dominate the
 * headline. Best and worst are reported alongside so the spread is visible rather than smoothed away.
 */
export function summarizeTiers(samples: readonly TierSample[]): LatencyReport["tiers"] {
  const tiers: LatencyReport["tiers"] = {
    coreAnalysis: null,
    aiSynthesis: null,
    qaCoreHit: null,
    qaGenerate: null,
  };
  const byTier = new Map<TierSample["tier"], number[]>();
  for (const sample of samples) {
    const bucket = byTier.get(sample.tier) ?? [];
    bucket.push(sample.ms);
    byTier.set(sample.tier, bucket);
  }
  for (const [tier, values] of byTier) {
    const sorted = [...values].sort((a, b) => a - b);
    tiers[tier] = {
      best: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
      worst: sorted[sorted.length - 1],
      runs: sorted.length,
    };
  }
  return tiers;
}

/** One line per tier, plus the schedule comparison. What goes in a log or a README. */
export function renderLatencyReport(report: LatencyReport): string {
  const lines: string[] = ["latency tiers (hermetic — mock providers; measures orchestration, not the internet)"];
  for (const tier of ["coreAnalysis", "aiSynthesis", "qaCoreHit", "qaGenerate"] as const) {
    const stats = report.tiers[tier];
    lines.push(
      stats
        ? `  ${tier.padEnd(13)} best ${String(stats.best).padStart(5)}ms · median ${String(stats.median).padStart(5)}ms · worst ${String(stats.worst).padStart(5)}ms  (${stats.runs} run(s))`
        : `  ${tier.padEnd(13)} not sampled`,
    );
  }
  if (report.scheduleComparison) {
    const { sequentialMs, layeredMs, speedup } = report.scheduleComparison;
    lines.push(`  schedule      sequential ${sequentialMs}ms → layered ${layeredMs}ms  (${speedup.toFixed(2)}x)`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}
