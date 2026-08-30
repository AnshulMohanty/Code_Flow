import type {
  PipelineContext,
  PipelineInput,
  PipelineStage,
  StageResult,
} from "@codeflow/shared-types";

/**
 * ADAPTIVE SYNTHESIZE (V3-P4) — pick the fan-out or the single-shot path at RUN time.
 *
 * WHY IT HAS TO BE A RUN-TIME DECISION. The worker assembles its stage list before the pipeline
 * starts, but `metrics.clusters` does not exist until Analyze (stage 6) has run. So whether a
 * fan-out is even possible is not knowable when the stage is constructed — and constructing the
 * wrong one would mean either failing a graph-less analysis or never fanning out at all.
 *
 * The rule is simple and stated: communities present ⇒ fan out; absent ⇒ single shot. Both stages
 * own `aiSynthesis`, both emit a `synthesize` event, and both keep the grounding/cache/budget/partial
 * contract, so from the orchestrator's point of view nothing about stage 7 has changed.
 *
 * There is one more reason to keep the single-shot path reachable rather than deleting it: a cached
 * pre-V3-P1 analysis has an index but no communities, and it is still worth synthesising. Deleting
 * the older path to have "one path" would have made those analyses worse to serve tidiness.
 */
export interface AdaptiveSynthesizeDependencies {
  /** Used when `metrics.clusters` is present. */
  fanOut: PipelineStage<"aiSynthesis">;
  /** Used otherwise (no communities — e.g. a pre-V3-P1 cached analysis, or an edgeless repo). */
  singleShot: PipelineStage<"aiSynthesis">;
  /** Called with which path ran, so a run is explainable. */
  onChoice?(choice: "fan-out" | "single-shot", reason: string): void;
}

export function createAdaptiveSynthesizeStage(deps: AdaptiveSynthesizeDependencies): PipelineStage<"aiSynthesis"> {
  return {
    // Deliberately the SAME id/kind/owns as either delegate: the orchestrator's coverage
    // partition, its cache lookup and its "AI failure ⇒ partial" handling all key off these, and a
    // new id would have silently taken stage 7 out of that machinery.
    id: "synthesize",
    kind: "ai",
    label: "Synthesizing",
    owns: ["aiSynthesis"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"aiSynthesis">> {
      const clusters = ctx.prior.metrics?.clusters;
      const communityCount = clusters?.clusters.length ?? 0;

      if (communityCount > 0) {
        deps.onChoice?.("fan-out", `${communityCount} code communities detected`);
        return deps.fanOut.run(input, ctx);
      }
      deps.onChoice?.(
        "single-shot",
        clusters ? "community detection produced no communities" : "no metrics.clusters (pre-V3-P1 analysis)",
      );
      return deps.singleShot.run(input, ctx);
    },
  };
}
