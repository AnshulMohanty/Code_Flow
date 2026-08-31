import { FANOUT_MAX_CONCURRENCY, SUPERVISOR_MAX_FINDINGS, SUPERVISOR_MAX_READING_STEPS } from "@codeflow/config";
import { BudgetExceededError, estimateTokens, type LlmClient } from "@codeflow/analyzers";
import type { AnalysisResult, BudgetHandle, RepoCluster } from "@codeflow/shared-types";
import { meterContext } from "../contextMeter.js";
import { emptyBlackboard, post } from "./blackboard.js";
import type {
  Blackboard,
  BlackboardEntry,
  FanOutResult,
  SpecialistFinding,
  SpecialistId,
  SpecialistTask,
} from "./contracts.js";
import { SPECIALIST_IDS } from "./contracts.js";
import { planRouting } from "./routing.js";
import { consolidateKnowledge } from "./consolidate.js";
import {
  buildSpecialistPrompt,
  buildSpecialistTask,
  groundFindings,
  parseSpecialistOutput,
  SPECIALIST_SYSTEM_PROMPT,
} from "./specialists.js";
import {
  buildSupervisorPrompt,
  deriveSupervisedSynthesis,
  fallbackSynthesis,
  SUPERVISOR_SYSTEM_PROMPT,
} from "./supervisor.js";

/**
 * THE ORCHESTRATOR (V3-P4 tasks 1-3): fan out specialists over communities, collect structured
 * summaries on a blackboard, have one supervisor synthesise.
 *
 *   plan routing (deterministic, free)
 *     -> for each selected community, run 5 specialists IN PARALLEL (bounded concurrency)
 *          -> hard communities get N trajectories, scored by an EXACT verifier, best kept
 *          -> phase gate per specialist: input safety, schema, grounding, budget
 *     -> blackboard (structured summaries only, never transcripts)
 *     -> ONE supervisor over a BOUNDED selection + deterministic graph facts
 *     -> grounded synthesis, or a deterministic fallback if the supervisor fails
 *
 * FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR, each with the reason it matters:
 *
 * 1. **Genuinely parallel.** Specialists for a community run concurrently, capped by
 *    `FANOUT_MAX_CONCURRENCY` (provider rate limits and peak memory are real). `peakConcurrency` is
 *    OBSERVED, not assumed — a counter incremented around each call — because a wall-clock
 *    measurement alone is flaky on a loaded machine while a concurrency counter is exact.
 *
 * 2. **Orchestrator context does not grow with worker count.** Enforced by the blackboard's bounded
 *    selection, and reported as `supervisorContext` so the claim is measured rather than argued.
 *
 * 3. **N-times cost only on the routed-hard tail.** `bestOfNExtraCalls` is reported separately from
 *    `specialistCalls`, so the extra bill is always attributable.
 *
 * 4. **The Synthesize contract is unchanged.** Grounding, the SHA-keyed cache, the budget, and
 *    "AI failure ⇒ partial" all behave exactly as the single-shot stage did. Where this path differs
 *    it differs by being MORE forgiving: a specialist failing is a recorded entry, not a failed run,
 *    because losing one lens of five is not losing the analysis.
 *
 * AGENTS ARE AI LEAVES. Nothing here writes a deterministic slice; the graph, metrics and
 * communities are computed before any agent runs and are read-only throughout.
 */

export interface FanOutDeps {
  result: AnalysisResult;
  chatClient: LlmClient;
  budget?: BudgetHandle;
  /** Overrides for tests. */
  specialists?: readonly SpecialistId[];
  maxConcurrency?: number;
  maxCommunities?: number;
  maxHardCommunities?: number;
  hardThreshold?: number;
  samples?: number;
  maxFiles?: number;
  maxFindings?: number;
  maxSupervisorFindings?: number;
  maxReadingSteps?: number;
  maxTokens?: number;
  /**
   * Scores one candidate's findings 0..1 so best-of-N can pick a winner. Injected, and EXACT by
   * default (see `createGroundingScorer`) — a scorer that costs money or varies run to run would
   * make best-of-N unaffordable and unreproducible at once.
   */
  scoreCandidate?: (findings: readonly SpecialistFinding[], task: SpecialistTask) => number;
  /**
   * ISO timestamp stamped on the consolidated knowledge base. Supplied rather than read from a
   * clock, so a fan-out driven by an injected clock stays fully reproducible — the same rule
   * `snapshotOf` and `consolidateKnowledge` follow.
   */
  capturedAt?: string;
}

export async function runFanOut(deps: FanOutDeps): Promise<FanOutResult> {
  const clusters = deps.result.metrics?.clusters?.clusters ?? [];
  const specialists = deps.specialists ?? SPECIALIST_IDS;
  const maxConcurrency = Math.max(1, deps.maxConcurrency ?? FANOUT_MAX_CONCURRENCY);
  const scoreCandidate = deps.scoreCandidate ?? createGroundingScorer();
  const warnings: string[] = [];
  // Deliberately NOT `new Date()` when unset: a fixed sentinel keeps an un-stamped run reproducible
  // instead of silently making every KB differ. A caller that wants a real timestamp passes one.
  const capturedAt = deps.capturedAt ?? "1970-01-01T00:00:00.000Z";

  if (clusters.length === 0) {
    // No communities ⇒ nothing to fan out over. Honest rather than clever: the deterministic
    // fallback still produces a grounded reading order from entry points + centrality, which is
    // exactly what a single-community repository deserves.
    const board = emptyBlackboard();
    warnings.push("No code communities were detected, so there was nothing to fan out over.");
    return {
      synthesis: fallbackSynthesis(board, deps.result, deps.maxReadingSteps ?? SUPERVISOR_MAX_READING_STEPS),
      blackboard: board,
      routes: [],
      skippedClusters: [],
      peakConcurrency: 0,
      specialistCalls: 0,
      bestOfNExtraCalls: 0,
      supervisorContext: meterContext({ instructions: "", retrieval: "", memory: "", tools: "", transcript: "", question: "" }),
      supervised: false,
      // Still built, and it is not empty: the deterministic FACTS and the FAQ come from the graph,
      // so a repository with no communities still gets a usable KB. Returning nothing here would
      // make "no communities" look like "consolidation failed".
      knowledgeBase: consolidateKnowledge({ result: deps.result, blackboard: board, capturedAt }),
      warnings,
    };
  }

  const plan = planRouting(clusters, deps.result, {
    ...(deps.maxCommunities !== undefined ? { maxCommunities: deps.maxCommunities } : {}),
    ...(deps.maxHardCommunities !== undefined ? { maxHard: deps.maxHardCommunities } : {}),
    ...(deps.hardThreshold !== undefined ? { hardThreshold: deps.hardThreshold } : {}),
    ...(deps.samples !== undefined ? { samples: deps.samples } : {}),
  });
  if (plan.skippedClusters.length > 0) {
    // NEVER a silent cap: a report that omits what it dropped reads as "covered everything".
    warnings.push(
      `${plan.skippedClusters.length} of ${clusters.length} communities were not analysed (the least complex): ` +
        `${plan.skippedClusters.join(", ")}.`,
    );
  }

  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));

  // --- Fan out -------------------------------------------------------------
  const tracker = createConcurrencyTracker();
  let specialistCalls = 0;
  let bestOfNExtraCalls = 0;
  let budgetExhausted = false;
  let board: Blackboard = emptyBlackboard();

  // One job per (community, specialist). Ordered community-by-community with the hardest first, so
  // the concurrency cap spends its slots on the interesting work rather than starving it in a tail.
  const jobs: Array<{ cluster: RepoCluster; specialist: SpecialistId; samples: number }> = [];
  for (const route of plan.routes) {
    const cluster = byId.get(route.cluster);
    if (!cluster) continue;
    for (const specialist of specialists) jobs.push({ cluster, specialist, samples: route.samples });
  }

  const entries: BlackboardEntry[] = [];
  await mapWithConcurrency(jobs, maxConcurrency, async (job) => {
    const task = buildSpecialistTask(job.specialist, job.cluster, deps.result, deps.maxFiles);
    const prompt = buildSpecialistPrompt(task);
    const context = meterContext({
      instructions: SPECIALIST_SYSTEM_PROMPT,
      retrieval: prompt,
      memory: "",
      tools: "",
      transcript: "",
      question: job.specialist,
    });

    // PHASE GATE — budget. Checked per specialist, so exhaustion SKIPS the remaining ones rather
    // than failing the whole run: four lenses are worth more than none.
    if (budgetExhausted) {
      entries.push(skipped(job.specialist, job.cluster.id, "budget exhausted earlier in this run", context));
      return;
    }
    if (deps.budget) {
      const estimate = estimateTokens(`${SPECIALIST_SYSTEM_PROMPT}\n${prompt}`);
      if (!(await deps.budget.check(estimate, "chat"))) {
        budgetExhausted = true;
        entries.push(skipped(job.specialist, job.cluster.id, "daily LLM budget exhausted", context));
        return;
      }
    }

    // Best-of-N: sample `job.samples` trajectories, score each with the EXACT verifier, keep the
    // best. Sequential within a job on purpose — the samples are alternatives to each other, so
    // running them concurrently would multiply peak provider load for no latency gain that matters
    // (the fan-out across communities is where the parallelism lives).
    let best: { findings: SpecialistFinding[]; droppedFileIds: string[]; score: number } | null = null;
    let refusal: string | null = null;
    let failure: string | null = null;

    for (let sample = 0; sample < Math.max(1, job.samples); sample++) {
      let text: string;
      try {
        text = await tracker.track(async () => {
          const completed = await deps.chatClient.complete({
            cachePrefix: SPECIALIST_SYSTEM_PROMPT,
            system: SPECIALIST_SYSTEM_PROMPT,
            prompt,
            temperature: sample === 0 ? 0 : 0.7,
            ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
          });
          if (deps.budget) await deps.budget.record(completed.usage, "chat");
          return completed.text;
        });
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          budgetExhausted = true;
          failure = error.message;
          break;
        }
        failure = error instanceof Error ? error.message : String(error);
        continue;
      }
      specialistCalls += 1;
      if (sample > 0) bestOfNExtraCalls += 1;

      // PHASE GATE — schema.
      const parsed = parseSpecialistOutput(text);
      if ("error" in parsed) {
        failure = parsed.error;
        continue;
      }
      if (parsed.refused) {
        refusal = parsed.reason ?? "refused";
        // A refusal is a real answer, so further samples would be paying to talk a specialist out
        // of a correct "nothing here". Stop.
        break;
      }

      // PHASE GATE — grounding (to THIS community's files, stricter than "in the graph").
      const grounded = groundFindings(parsed, task, {
        ...(deps.maxFindings !== undefined ? { maxFindings: deps.maxFindings } : {}),
      });
      if (grounded.findings.length === 0) {
        failure = "every finding was ungrounded (cited files outside this community)";
        continue;
      }
      const score = scoreCandidate(grounded.findings, task);
      if (!best || score > best.score) best = { ...grounded, score };
    }

    if (best) {
      entries.push({
        specialist: job.specialist,
        cluster: job.cluster.id,
        status: "ok",
        findings: best.findings,
        droppedFileIds: best.droppedFileIds,
        samples: Math.max(1, job.samples),
        ...(job.samples > 1 ? { bestScore: best.score } : {}),
        context,
      });
      return;
    }
    if (refusal) {
      entries.push({
        specialist: job.specialist,
        cluster: job.cluster.id,
        status: "refused",
        reason: refusal,
        findings: [],
        droppedFileIds: [],
        samples: Math.max(1, job.samples),
        context,
      });
      return;
    }
    entries.push({
      specialist: job.specialist,
      cluster: job.cluster.id,
      status: budgetExhausted ? "skipped-budget" : "failed",
      reason: failure ?? "no usable output",
      findings: [],
      droppedFileIds: [],
      samples: Math.max(1, job.samples),
      context,
    });
  });

  // Sorted before posting so the blackboard is deterministic despite the concurrent writes. Without
  // this the entry ORDER would depend on scheduling, and the whole run would stop being reproducible
  // for a reason that has nothing to do with the models.
  entries.sort((a, b) => a.cluster - b.cluster || a.specialist.localeCompare(b.specialist));
  for (const entry of entries) board = post(board, entry);

  // --- Supervise -----------------------------------------------------------
  const nodeIds = new Set((deps.result.graph?.nodes ?? deps.result.files).map((node) => node.id));
  const maxSteps = deps.maxReadingSteps ?? SUPERVISOR_MAX_READING_STEPS;
  const supervisorPrompt = buildSupervisorPrompt(board, deps.result, {
    maxFindings: deps.maxSupervisorFindings ?? SUPERVISOR_MAX_FINDINGS,
    maxSteps,
  });

  let synthesis = null as ReturnType<typeof fallbackSynthesis> | null;
  let supervised = false;

  const canSupervise =
    !budgetExhausted &&
    (!deps.budget ||
      (await deps.budget.check(estimateTokens(`${SUPERVISOR_SYSTEM_PROMPT}\n${supervisorPrompt.prompt}`), "chat")));

  if (!canSupervise) {
    warnings.push("The supervisor step was skipped (daily LLM budget exhausted); used the deterministic fallback.");
  } else {
    try {
      const completed = await deps.chatClient.complete({
        cachePrefix: SUPERVISOR_SYSTEM_PROMPT,
        system: SUPERVISOR_SYSTEM_PROMPT,
        prompt: supervisorPrompt.prompt,
        temperature: 0,
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      });
      if (deps.budget) await deps.budget.record(completed.usage, "chat");
      synthesis = deriveSupervisedSynthesis(completed.text, nodeIds, maxSteps);
      supervised = true;
    } catch (error) {
      // The specialists' work is still real, so falling back beats discarding it. A fan-out that
      // spent five calls and then returned nothing would be strictly worse than the single call it
      // replaced.
      warnings.push(
        `The supervisor step failed (${error instanceof Error ? error.message : String(error)}); used the deterministic fallback.`,
      );
    }
  }

  return {
    synthesis: synthesis ?? fallbackSynthesis(board, deps.result, maxSteps),
    blackboard: board,
    routes: plan.routes,
    skippedClusters: plan.skippedClusters,
    peakConcurrency: tracker.peak,
    specialistCalls,
    bestOfNExtraCalls,
    supervisorContext: supervisorPrompt.context,
    supervised,
    knowledgeBase: consolidateKnowledge({ result: deps.result, blackboard: board, capturedAt }),
    warnings,
  };
}

function skipped(specialist: SpecialistId, cluster: number, reason: string, context: BlackboardEntry["context"]): BlackboardEntry {
  return { specialist, cluster, status: "skipped-budget", reason, findings: [], droppedFileIds: [], samples: 0, context };
}

/**
 * The DEFAULT best-of-N scorer — exact, free, deterministic.
 *
 * Three components, and the reasoning for each:
 *   grounding (0.5) — the share of claimed fileIds that are real community files. This is the same
 *     rule `@codeflow/arena`'s file-grounding verifier applies; it is the one thing that must never
 *     be traded away, hence the largest weight.
 *   coverage  (0.3) — the share of the community's files the findings actually touch. A candidate
 *     that says one true thing about one file is worse than one that covers the group.
 *   substance (0.2) — findings with real detail and stated importance. Weakest weight because it is
 *     the most gameable: length is not insight, so it is capped rather than rewarded linearly.
 *
 * No model in the loop, on purpose. Best-of-N already costs N times as much; paying a judge per
 * candidate on top would make it unaffordable, and a scorer that varies run to run would make the
 * winner unreproducible — the two problems compound.
 */
export function createGroundingScorer(): NonNullable<FanOutDeps["scoreCandidate"]> {
  return (findings, task) => {
    if (findings.length === 0) return 0;
    const allowed = new Set(task.fileIds);

    const claimed = findings.flatMap((finding) => finding.fileIds);
    const grounded = claimed.filter((fileId) => allowed.has(fileId));
    const groundingScore = claimed.length === 0 ? 0 : grounded.length / claimed.length;

    const covered = new Set(grounded);
    const coverageScore = allowed.size === 0 ? 0 : Math.min(1, covered.size / allowed.size);

    const withDetail = findings.filter((finding) => finding.detail.trim().length >= 40).length;
    const substanceScore = Math.min(1, withDetail / findings.length);

    return groundingScore * 0.5 + coverageScore * 0.3 + substanceScore * 0.2;
  };
}

/**
 * Observed peak concurrency.
 *
 * Why a counter and not a stopwatch: a wall-clock comparison is the number a reader wants, but it is
 * flaky on a loaded machine and can pass by accident. A counter is exact — if `peak` is 5, five
 * calls were genuinely in flight at once. Both are reported; only this one gates.
 */
function createConcurrencyTracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async track<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
  };
}

/**
 * Run `work` over `items` with at most `limit` in flight.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than chunking into batches of
 * `limit`: batching would idle the whole pool waiting for one slow call in each batch, which on a
 * provider with variable latency is most of the wall-clock saving thrown away.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await work(items[index], index);
    }
  });
  await Promise.all(runners);
}
