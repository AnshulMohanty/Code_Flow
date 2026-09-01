import { createHash } from "node:crypto";
import { stripCodeFence } from "../llm/completionText.js";
import type {
  FileMetrics,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  ReadingStep,
  RepoGraph,
  Synthesis,
  StageResult,
  TokenUsage,
} from "@codeflow/shared-types";
import type { LlmClient } from "../llm/llmClient.js";
import { BudgetExceededError } from "../pipeline/errors.js";
import { estimateTokens, sumUsage } from "../util/tokens.js";

export interface SynthesizeDependencies {
  /** Injectable LLM client — tests mock it (no real API calls). */
  client: LlmClient;
  /** Max LLM attempts (1 initial + retries). Default 3. */
  maxAttempts?: number;
  /** Output token cap passed to the client. */
  maxTokens?: number;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

// Bounded prompt-view sizes. These cap the LLM INPUT only — the stored slices
// (metrics/inventory/graph) stay uncapped; this is prompt construction, not data loss.
const TOP_KEY_FILES = 30;
const TOP_IMPACT = 10;
const TOP_CYCLES = 15;
const MAX_ENTRY_POINTS = 50;
const README_HEAD_CHARS = 1200;

const SYSTEM_PROMPT =
  "You are a senior engineer writing an onboarding guide for a newcomer to a codebase. " +
  "You are given DETERMINISTIC facts about the repository (languages, layout, entry points, " +
  "the most central files, dependency cycles, and per-file metrics). Using ONLY these facts, " +
  "produce a short 'what is this and where do I start' guide and a ranked reading order. " +
  "Every reading-order entry MUST cite a fileId taken verbatim from the provided file list — " +
  "never invent a path. Respond with a SINGLE JSON object and nothing else (no markdown, no " +
  "code fences, no commentary). Schema: " +
  '{"summary": string, "readingOrder": [{"fileId": string, "order": number, "reason": string}], "keyConcepts"?: string[]}.';

/**
 * Stage 7 — Synthesize (AI; the FIRST AI stage). Reads the deterministic facts (stages
 * 2–6) and produces a grounded "where do I start" onboarding narrative + ranked reading
 * order under `result.ai.synthesis`. The LLM output is parsed, schema-validated, and
 * GROUNDING-checked deterministically (every cited fileId must exist in graph.nodes;
 * ungrounded steps are dropped). Completions are cached on (commitSha + prompt hash) so
 * re-runs spend zero API. No graph algorithms, no new metrics — judgment over facts only.
 *
 * Error contract (AI): on exhausted retries / thrown client / empty-after-grounding the
 * stage THROWS; the orchestrator records it as an AI failure → run status "partial" with
 * all deterministic slices intact.
 */
export function createSynthesizeStage(deps: SynthesizeDependencies): PipelineStage<"aiSynthesis"> {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 3;

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
      const nodeIds = new Set(graph.nodes.map((node) => node.id));

      const prompt = buildSynthesisPrompt(ctx);
      // v2: provider+model scoped. Without them, switching providers would serve a
      // completion from the WRONG model (cache poisoning); now a switch misses + re-runs.
      const cacheKey = `synthesis/v2/${deps.client.provider}/${deps.client.model}/${ctx.commitSha ?? "no-sha"}/${sha256(prompt)}`;

      // Cache READ before any LLM call (wallet defense).
      const cachedCompletion = await ctx.cache.get<string>(cacheKey);
      if (cachedCompletion != null) {
        try {
          return finish(deriveSynthesis(cachedCompletion, nodeIds), { cached: true });
        } catch {
          // A cached completion no longer grounds (e.g. graph changed) — fall through.
          ctx.logger.warn("Synthesis cache entry no longer valid; re-calling the model.");
        }
      }

      // Guard 5 — CACHE-BEFORE-BUDGET: we only reach here on a cache MISS, so a real call
      // is imminent. Pre-check the global daily LLM budget with a deterministic estimate
      // (chars/4). If exhausted, degrade gracefully — throw budget-exhausted ⇒ orchestrator
      // "partial" (deterministic slices intact) — WITHOUT calling the provider.
      const estimatedTokens = estimateTokens(SYSTEM_PROMPT + "\n" + prompt);
      if (ctx.budget && !(await ctx.budget.check(estimatedTokens))) {
        throw new BudgetExceededError("Daily LLM budget exhausted; synthesis skipped (demo at capacity).");
      }

      let lastError: unknown;
      /** Every attempt's usage — so the terminal event reports what the STAGE spent, not one call. */
      const totalUsage: TokenUsage[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let completion: string;
        let usage: TokenUsage;
        try {
          // `cachePrefix` marks the STABLE prefix for the provider's prompt cache. Only
          // SYSTEM_PROMPT is stable across repos; the per-repo facts are already protected
          // by the SHA-keyed completion cache above, which is strictly cheaper than a
          // provider cache hit (zero tokens vs discounted tokens). Whether the provider
          // actually cached is read back below, never assumed.
          const completed = await deps.client.complete({
            cachePrefix: SYSTEM_PROMPT,
            prompt,
            temperature: 0,
            maxTokens: deps.maxTokens,
          });
          completion = completed.text;
          usage = completed.usage;
        } catch (error) {
          lastError = error;
          ctx.logger.warn("Synthesis LLM call failed; retrying if attempts remain.", {
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        // CHARGED THE MOMENT THE CALL SUCCEEDS, before the output is judged — FIXED V3-FINAL.
        //
        // This used to sit AFTER `deriveSynthesis`, inside the try below, so a completion rejected by
        // the schema or grounding check was never recorded. The provider charged for it either way,
        // which meant three rejected attempts spent real money against a daily ceiling that never saw
        // a token of it: the wallet guard was blind to exactly the failure mode that retries most.
        // The retry loop makes this a multiple, not a rounding error.
        totalUsage.push(usage);
        if (ctx.budget) await ctx.budget.record(usage, "chat");
        if (!usage.measured) {
          ctx.logger.warn("Synthesis: provider reported no usage; budget recorded an ESTIMATE.", {
            provider: deps.client.provider,
          });
        }
        // An INTERIM event carrying the usage, so a failed or retried stage's spend still reaches the
        // trace. The terminal event only exists on the success path, so without this a run that spent
        // money and then failed would report a cost of zero — the same dishonesty in a new place.
        ctx.emit?.({
          jobId: input.jobId,
          stage: "synthesize",
          stageIndex: 7,
          stageCount: 7,
          kind: "ai",
          status: "running",
          label: "Synthesizing",
          detail: `Provider call ${attempt}/${maxAttempts} completed.`,
          progress: 0,
          startedAt: new Date(startedAt).toISOString(),
          // The pricing table is keyed by model, so a usage report without it prices as UNKNOWN.
          preview: { model: deps.client.model, attempt },
          usage,
          emittedAt: new Date(now()).toISOString(),
        });

        try {
          const synthesis = deriveSynthesis(completion, nodeIds);
          await ctx.cache.set(cacheKey, completion); // cache only valid+grounded completions
          return finish(synthesis, { cached: false, usage: sumUsage(totalUsage) });
        } catch (error) {
          lastError = error;
          ctx.logger.warn("Synthesis output rejected (schema/grounding); retrying if attempts remain.", {
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      throw new Error(
        `Synthesis failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );

      function finish(
        synthesis: Synthesis,
        meta: { cached: boolean; usage?: TokenUsage },
      ): StageResult<"aiSynthesis"> {
        const event: ProgressEvent = {
          jobId: input.jobId,
          stage: "synthesize",
          stageIndex: 7,
          stageCount: 7,
          kind: "ai",
          status: "completed",
          label: "Synthesizing",
          detail: `Synthesized onboarding guide (${synthesis.readingOrder.length} reading steps${
            synthesis.droppedCitations ? `, ${synthesis.droppedCitations} ungrounded dropped` : ""
          }).`,
          progress: 0,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: now() - startedAt,
          preview: {
            readingSteps: synthesis.readingOrder.length,
            droppedCitations: synthesis.droppedCitations ?? 0,
            cached: meta.cached,
            model: deps.client.model,
          },
          // Absent on a cache hit, which is the honest shape: a served completion spent nothing, and
          // reporting zero tokens would be indistinguishable from a free provider call.
          ...(meta.usage ? { usage: meta.usage } : {}),
          emittedAt: new Date(now()).toISOString(),
        };
        return { partial: { aiSynthesis: synthesis }, event };
      }
    },
  };
}

// --- Parse + schema-validate + ground ---------------------------------------

/** Parse the raw completion, schema-validate it, then drop ungrounded reading steps.
 *  Throws on malformed JSON, schema miss, or an empty-after-grounding reading order. */
export function deriveSynthesis(raw: string, nodeIds: Set<string>): Synthesis {
  const cleaned = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Synthesis output was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Synthesis output was not a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new Error("Synthesis output is missing a non-empty `summary`.");
  }
  if (!Array.isArray(obj.readingOrder)) {
    throw new Error("Synthesis output is missing a `readingOrder` array.");
  }

  const steps: ReadingStep[] = obj.readingOrder.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`readingOrder[${index}] is not an object.`);
    }
    const step = entry as Record<string, unknown>;
    if (typeof step.fileId !== "string" || step.fileId === "") {
      throw new Error(`readingOrder[${index}].fileId is missing.`);
    }
    if (typeof step.reason !== "string") {
      throw new Error(`readingOrder[${index}].reason is missing.`);
    }
    const order = typeof step.order === "number" ? step.order : index + 1;
    return { fileId: step.fileId, order, reason: step.reason };
  });

  let keyConcepts: string[] | undefined;
  if (obj.keyConcepts !== undefined) {
    if (!Array.isArray(obj.keyConcepts) || obj.keyConcepts.some((value) => typeof value !== "string")) {
      throw new Error("`keyConcepts` must be an array of strings when present.");
    }
    keyConcepts = obj.keyConcepts as string[];
  }

  // GROUNDING: keep only steps whose fileId is a real graph node; renumber deterministically.
  const grounded = steps
    .filter((step) => nodeIds.has(step.fileId))
    .sort((a, b) => a.order - b.order || a.fileId.localeCompare(b.fileId))
    .map((step, index) => ({ ...step, order: index + 1 }));
  const droppedCitations = steps.length - grounded.length;

  if (grounded.length === 0) {
    throw new Error("Synthesis reading order was empty after grounding (all citations ungrounded).");
  }

  return {
    summary: obj.summary.trim(),
    readingOrder: grounded,
    ...(keyConcepts ? { keyConcepts } : {}),
    ...(droppedCitations > 0 ? { droppedCitations } : {}),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic token estimate for the budget pre-check (~4 chars/token). Precise
 *  provider tokenization is a P7 refinement; this is the wallet-guard estimate. */


// --- Bounded prompt construction (reads uncapped slices read-only) ----------

/**
 * Assemble the LLM prompt from a BOUNDED selection of the deterministic facts. The
 * stored slices stay uncapped; this view never includes the full symbol/node list —
 * only orientation, layout, metric summary, the top key files (with their metrics),
 * entry points, top cycles, and the highest-impact files.
 */
export function buildSynthesisPrompt(ctx: PipelineContext): string {
  const orientation = ctx.prior.orientation;
  const structure = ctx.prior.structure;
  const inventory = ctx.prior.inventory;
  const graph = ctx.prior.graph as RepoGraph; // guarded by the caller
  const metrics = ctx.prior.metrics;

  const metricsByFile = new Map<string, FileMetrics>((metrics?.perFile ?? []).map((file) => [file.fileId, file]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const lines: string[] = [];

  lines.push("## Project");
  if (orientation) {
    lines.push(`- projectType: ${orientation.projectType}`);
    lines.push(`- languages: ${orientation.languages.join(", ") || "unknown"}`);
    lines.push(`- frameworks: ${orientation.frameworks.join(", ") || "none detected"}`);
  }
  if (structure) {
    lines.push(`- layout: ${structure.layout}`);
    lines.push(`- fileCount: ${structure.fileCount}`);
  }
  if (metrics) {
    const s = metrics.summary;
    lines.push(
      `- graph: ${s.fileCount} files, ${s.edgeCount} edges, ${s.cycleCount} cycles, ${s.isolatedFileCount} isolated, maxBlastRadius ${s.maxBlastRadius}`,
    );
  }

  if (orientation?.readme?.text) {
    lines.push("\n## README (head)");
    lines.push(orientation.readme.text.slice(0, README_HEAD_CHARS));
  }

  const entryPoints = inventory?.entryPoints ?? [];
  if (entryPoints.length) {
    lines.push("\n## Entry points");
    for (const entry of entryPoints.slice(0, MAX_ENTRY_POINTS)) {
      lines.push(`- ${entry.filePath} (${entry.kind}, evidence: ${entry.evidence})`);
    }
  }

  const keyFiles = (metrics?.keyFiles ?? []).slice(0, TOP_KEY_FILES);
  if (keyFiles.length) {
    lines.push(`\n## Most central files (top ${keyFiles.length}, by degree centrality)`);
    for (const fileId of keyFiles) {
      const m = metricsByFile.get(fileId);
      const node = nodeById.get(fileId);
      const detail = m
        ? `centrality ${m.centrality}, fanIn ${m.fanIn}, fanOut ${m.fanOut}, blastRadius ${m.blastRadius}`
        : "";
      lines.push(`- ${fileId} [${node?.language ?? "?"}, ${node?.lines ?? 0} loc] ${detail}`);
    }
  }

  const impactful = [...(metrics?.perFile ?? [])]
    .sort((a, b) => b.blastRadius - a.blastRadius || a.fileId.localeCompare(b.fileId))
    .filter((file) => file.blastRadius > 0)
    .slice(0, TOP_IMPACT);
  if (impactful.length) {
    lines.push(`\n## Highest-impact files (top ${impactful.length}, by blast radius)`);
    for (const file of impactful) {
      lines.push(`- ${file.fileId} (blastRadius ${file.blastRadius})`);
    }
  }

  const cycles = (metrics?.cycles ?? []).slice(0, TOP_CYCLES);
  if (cycles.length) {
    lines.push(`\n## Dependency cycles (top ${cycles.length})`);
    for (const cycle of cycles) {
      lines.push(`- ${cycle.files.join(" -> ")}`);
    }
  }

  lines.push(
    "\n## Task\nWrite the onboarding guide. `readingOrder` fileIds MUST be chosen from the file lists above. Return JSON only.",
  );

  return lines.join("\n");
}
