import type { PipelineInput, PipelineStage } from "@codeflow/shared-types";
import { runPipeline } from "../pipeline/orchestrator.js";
import { computeLayers, describeSchedule } from "../pipeline/schedule.js";
import { summarizeTiers, timed, type LatencyReport, type TierSample } from "./latencyTiers.js";

/**
 * THE HERMETIC BENCH RUNNER (V3-P5 task 1's acceptance: four tiers reported INDEPENDENTLY).
 *
 * `latencyTiers.ts` defines the four tiers and how to summarise them; this drives the real
 * orchestrator to produce them. Deliberately separate files: the summary logic is pure and unit
 * tested, while this one has to actually wait for things, and mixing the two would make the
 * arithmetic untestable without sleeping.
 *
 * EVERYTHING SLOW IS INJECTED. The stages come from the caller, so the bench measures the
 * ORCHESTRATION — layering, cache hits, the readiness scheduler — against a configurable provider
 * delay, and never touches a network. That scope limit is not a caveat added afterwards; it is why
 * the numbers are reproducible and why this can run in CI. `scripts/live-benchmark.mjs` covers the
 * other half, against a real deployment, and reports the same four tiers so the two subtract.
 *
 * IT USES A REAL CLOCK, unlike the rest of the suite. Everywhere else an injected counter clock is
 * the right call because determinism matters more than duration. Here duration IS the measurement,
 * so `Date.now()` is correct and the numbers are therefore machine-dependent — which is exactly why
 * `summarizeTiers` reports median/best/worst rather than a single figure, and why the SPEEDUP ratio
 * is the number worth quoting: a ratio survives being measured on a different machine.
 */

export interface LatencyBenchDeps {
  input: PipelineInput;
  /** Build a fresh stage list. Called once per run so no state leaks between samples. */
  stages(): PipelineStage[];
  /**
   * Answer a question. `cached` distinguishes the two Q&A tiers, which the bench cannot infer:
   * from the outside a fast answer and a cache hit look the same, and asserting they are the same
   * thing is how a broken cache would pass a benchmark.
   */
  ask?(options: { cached: boolean }): Promise<unknown>;
  /** Samples per tier. Median is taken, so an odd count is preferable. */
  runs?: number;
}

/**
 * Run the bench. Reports the four tiers plus the sequential-vs-layered comparison.
 *
 * The comparison is the point of the exercise rather than a bonus: layered scheduling was built in
 * task 1 on the claim that the DAG has real parallelism, and a claim like that should come with the
 * number it is worth. It also guards the invariant from the other side — if the speedup were ~1.0,
 * the extra scheduler complexity would not be paying for itself.
 */
export async function runLatencyBench(deps: LatencyBenchDeps): Promise<LatencyReport> {
  const runs = deps.runs ?? 3;
  const samples: TierSample[] = [];
  const notes: string[] = [];

  const plan = computeLayers(deps.stages());
  notes.push(`schedule: ${describeSchedule(plan)}`);
  // Stated so `coreAnalysis` cannot be misquoted. The deterministic stages in a hermetic fixture do
  // no real work, so that tier measures the ORCHESTRATOR's own overhead and will read as ~0ms — which
  // is a genuine and useful result (the scheduler costs nothing measurable) and NOT a claim about how
  // long parsing a repository takes. The live benchmark is where that number comes from.
  notes.push(
    "coreAnalysis measures orchestrator overhead only — hermetic deterministic stages do no real " +
      "parse/clone work. For real parse timings use scripts/live-benchmark.mjs.",
  );

  let sequentialTotal = 0;
  let layeredTotal = 0;

  for (let run = 0; run < runs; run++) {
    const sequential = await timed(() =>
      runPipeline(deps.stages(), deps.input, { schedule: "sequential" }),
    );
    const layered = await timed(() => runPipeline(deps.stages(), deps.input, { schedule: "layered" }));
    sequentialTotal += sequential.ms;
    layeredTotal += layered.ms;

    // coreAnalysis and aiSynthesis are read from the pipeline's OWN recorded per-stage durations,
    // not from a wall-clock split. Under layered scheduling the two AI stages overlap, so a
    // wall-clock split would have to guess where one ended and the other began — and the sum of
    // overlapping stages exceeding the wall clock is the correct, informative outcome rather than
    // a bug to hide.
    const stageRecords = layered.value.result.pipeline?.stages ?? [];
    const sumOf = (kinds: readonly string[]) =>
      stageRecords.filter((record) => kinds.includes(record.kind)).reduce((total, record) => total + (record.durationMs ?? 0), 0);

    samples.push({
      tier: "coreAnalysis",
      ms: sumOf(["deterministic"]),
      conditions: `hermetic, layered, ${stageRecords.length} stage(s)`,
    });
    samples.push({
      tier: "aiSynthesis",
      ms: sumOf(["ai"]),
      conditions: "hermetic, mock providers, layered",
    });
  }

  if (deps.ask) {
    for (let run = 0; run < runs; run++) {
      const generated = await timed(() => deps.ask!({ cached: false }));
      samples.push({ tier: "qaGenerate", ms: generated.ms, conditions: "hermetic, mock provider, cache miss" });
      const hit = await timed(() => deps.ask!({ cached: true }));
      samples.push({ tier: "qaCoreHit", ms: hit.ms, conditions: "hermetic, cache hit" });
    }
  } else {
    notes.push("qaGenerate/qaCoreHit not sampled: no `ask` was injected.");
  }

  const sequentialMs = Math.round(sequentialTotal / runs);
  const layeredMs = Math.round(layeredTotal / runs);

  return {
    samples,
    tiers: summarizeTiers(samples),
    scheduleComparison: {
      sequentialMs,
      layeredMs,
      // Guarded: a layered run measured at 0ms on a fast machine would otherwise produce Infinity
      // and turn a real result into a nonsense headline.
      speedup: layeredMs > 0 ? sequentialMs / layeredMs : 1,
    },
    notes,
  };
}
