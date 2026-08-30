import { createHash } from "node:crypto";
import type {
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  StageResult,
  Synthesis,
} from "@codeflow/shared-types";
import type { LlmClient } from "@codeflow/analyzers";
import { summarizeBlackboard } from "./blackboard.js";
import type { FanOutResult } from "./contracts.js";
import { runFanOut, type FanOutDeps } from "./runFanOut.js";

/**
 * THE FAN-OUT AS THE SYNTHESIZE STAGE (V3-P4 task 1).
 *
 * The brief named this as risk (a): stage 7 changes from a single call into a fan-out plus a
 * supervisor, and the grounding, cache, budget and "AI failure ⇒ partial" contract must survive
 * EXACTLY. So this stage keeps all four, and each one is kept in the same shape the single-shot
 * stage used rather than a similar-looking one:
 *
 *   GROUNDING — the supervisor's reading order is grounded against graph nodes, dropped-and-counted,
 *     renumbered (in `deriveSupervisedSynthesis`); the specialists are grounded more strictly still,
 *     to their own community's files.
 *   CACHE — a SHA-keyed completion cache, checked BEFORE any call, storing the finished `Synthesis`
 *     rather than a raw completion. That differs from the single-shot stage and the reason is
 *     specific: there is no single completion to cache here (there are 5N of them), so the cacheable
 *     unit is the OUTCOME. It is re-grounded on read, so a cached synthesis that no longer matches
 *     the graph is discarded rather than served.
 *   BUDGET — cache-before-budget still holds: a hit spends nothing. The per-specialist checks live
 *     in the orchestrator, so exhaustion degrades (fewer lenses, deterministic fallback) instead of
 *     failing.
 *   PARTIAL — this stage THROWS only when it has nothing grounded at all, which is the same
 *     condition the single-shot stage threw on. Anything less — a failed specialist, a refused lens,
 *     a failed supervisor — is a recorded degradation, because losing one lens of five is not losing
 *     the analysis.
 *
 * `metrics.clusters` is REQUIRED. Without communities there is nothing low-coupling to fan out over,
 * and fanning out over arbitrary file groups would produce five overlapping reports — the thing the
 * community-based design exists to avoid. Its absence is treated as "use the single-shot stage",
 * which the worker decides.
 */

export interface FanOutSynthesizeDependencies extends Omit<FanOutDeps, "result"> {
  chatClient: LlmClient;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

/** Cache-key version — bump on a change to the prompt shape or the routing algorithm. */
const FANOUT_CACHE_VERSION = "v1";

export function createFanOutSynthesizeStage(deps: FanOutSynthesizeDependencies): PipelineStage<"aiSynthesis"> {
  const now = deps.now ?? Date.now;

  return {
    id: "synthesize",
    kind: "ai",
    label: "Synthesizing",
    owns: ["aiSynthesis"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"aiSynthesis">> {
      const startedAt = now();
      const graph = ctx.prior.graph;
      if (!graph) {
        throw new Error("Synthesize requires the graph slice; Connect must run first.");
      }
      const metrics = ctx.prior.metrics;
      const clusters = metrics?.clusters;
      if (!clusters || clusters.clusters.length === 0) {
        throw new Error(
          "Fan-out synthesis requires metrics.clusters (V3-P1 community detection); " +
            "use the single-shot synthesize stage for an analysis without communities.",
        );
      }

      const nodeIds = new Set(graph.nodes.map((node) => node.id));

      // The result the agents read. Assembled from the PRIOR slices, so the fan-out sees exactly
      // what the pipeline has produced so far and cannot reach for anything else.
      const result = {
        ...(ctx.prior as Record<string, unknown>),
        id: input.jobId,
        repository: input.repositoryRef,
        mode: input.mode,
        createdAt: new Date(startedAt).toISOString(),
        commitSha: ctx.commitSha,
        warnings: [],
        files: graph.nodes,
        graph,
        metrics,
      } as unknown as FanOutDeps["result"];

      // Keyed by SHA + provider/model + the community partition, because a different partition is a
      // different fan-out even at the same commit — serving the old synthesis would be serving an
      // answer about a structure that no longer exists.
      const cacheKey =
        `fanout-synthesis/${FANOUT_CACHE_VERSION}/${deps.chatClient.provider}/${deps.chatClient.model}/` +
        `${ctx.commitSha ?? "no-sha"}/${sha256(`${clusters.seed}:${clusters.resolution}:${clusters.count}:${clusters.modularity}`)}`;

      // CACHE READ before any call (wallet defense), and RE-GROUNDED on read.
      const cached = await ctx.cache.get<Synthesis>(cacheKey);
      if (cached) {
        const regrounded = cached.readingOrder.filter((step) => nodeIds.has(step.fileId));
        if (regrounded.length > 0) {
          return finish({ ...cached, readingOrder: regrounded }, { cached: true, fanOut: null });
        }
        ctx.logger.warn("Cached fan-out synthesis no longer grounds against the graph; re-running.");
      }

      const fanOut = await runFanOut({ ...deps, result, ...(ctx.budget ? { budget: ctx.budget } : {}) });

      for (const warning of fanOut.warnings) ctx.logger.warn(`Fan-out synthesis: ${warning}`);

      if (fanOut.synthesis.readingOrder.length === 0) {
        // The SAME condition the single-shot stage threw on: nothing grounded to show. Everything
        // short of this degrades instead.
        throw new Error("Fan-out synthesis produced no grounded reading steps.");
      }

      // Cache only a grounded, supervised outcome. A fallback synthesis is deterministic and cheap
      // to recompute, and caching it would mean a transient supervisor failure froze the degraded
      // answer in for the whole SHA.
      if (fanOut.supervised) await ctx.cache.set(cacheKey, fanOut.synthesis);

      return finish(fanOut.synthesis, { cached: false, fanOut });

      function finish(synthesis: Synthesis, meta: { cached: boolean; fanOut: FanOutResult | null }): StageResult<"aiSynthesis"> {
        const summary = meta.fanOut ? summarizeBlackboard(meta.fanOut.blackboard) : null;
        const event: ProgressEvent = {
          jobId: input.jobId,
          stage: "synthesize",
          stageIndex: 7,
          stageCount: 7,
          kind: "ai",
          status: "completed",
          label: "Synthesizing",
          detail: meta.cached
            ? `Synthesized onboarding guide (${synthesis.readingOrder.length} reading steps, cached).`
            : `Synthesized onboarding guide from ${summary?.findings ?? 0} finding(s) across ` +
              `${summary?.clusters ?? 0} community/ies (${meta.fanOut?.specialistCalls ?? 0} specialist calls, ` +
              `peak concurrency ${meta.fanOut?.peakConcurrency ?? 0}` +
              `${meta.fanOut?.supervised ? "" : ", deterministic fallback"}).`,
          progress: 0,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: now() - startedAt,
          preview: {
            readingSteps: synthesis.readingOrder.length,
            droppedCitations: synthesis.droppedCitations ?? 0,
            cached: meta.cached,
            // Reported so a run is explainable after the fact: how much was spent, how parallel it
            // actually was, and how much of the bill was best-of-N.
            ...(meta.fanOut
              ? {
                  specialistCalls: meta.fanOut.specialistCalls,
                  bestOfNExtraCalls: meta.fanOut.bestOfNExtraCalls,
                  peakConcurrency: meta.fanOut.peakConcurrency,
                  supervisorContextTokens: meta.fanOut.supervisorContext.total,
                  supervised: meta.fanOut.supervised,
                  findings: summary?.findings ?? 0,
                  refusedLenses: summary?.refused ?? 0,
                  failedLenses: summary?.failed ?? 0,
                  hardCommunities: meta.fanOut.routes.filter((route) => route.difficulty === "hard").length,
                  skippedCommunities: meta.fanOut.skippedClusters.length,
                }
              : {}),
          },
          emittedAt: new Date(now()).toISOString(),
        };
        return { partial: { aiSynthesis: synthesis }, event };
      }
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
