import type {
  AiAnalysis,
  AnalysisResult,
  AnalysisResultSlices,
  AnalysisSliceKey,
  AnalysisCacheHandle,
  BudgetHandle,
  PipelineContext,
  PipelineInput,
  PipelineLogger,
  PipelineRunSummary,
  PipelineStage,
  PipelineStageId,
  PipelineStatusReason,
  ProgressEvent,
  RepositoryRef,
  StageEmbeddingTarget,
  StageRunRecord,
  StageStatus,
} from "@codeflow/shared-types";
import { statusReasonOf } from "./errors.js";
import { deriveSummary } from "./summary.js";

/** A sink for progress events (e.g. the SSE writer in the worker). */
export type PipelineEmitter = (event: ProgressEvent) => void;

/**
 * Looks up a previously-saved AnalysisResult by commit SHA (the Mongo analysis
 * cache). The orchestrator consults this once Ingest has populated ctx.commitSha;
 * a hit short-circuits the run. Distinct from PipelineContext.cache (content/prompt
 * cache). Kept behind an interface so tests can fake it.
 */
export interface CachedAnalysisLookup {
  findCached(input: {
    repositoryRef: RepositoryRef;
    commitSha: string;
    analyzerVersion: string;
  }): Promise<AnalysisResult | null>;
}

export interface RunPipelineOptions {
  /** Authoritative progress sink. Also wired onto ctx.emit for interim events. */
  emit?: PipelineEmitter;
  logger?: PipelineLogger;
  /** Generic content/prompt cache handed to stages via ctx.cache (NOT the Mongo
   *  analysis-by-SHA cache). Defaults to an in-memory no-op. */
  cache?: AnalysisCacheHandle;
  /** Global daily LLM-spend ceiling (Guard 5), handed to AI stages via ctx.budget.
   *  Undefined ⇒ no budget guard (the AI stages call providers unconditionally). */
  budget?: BudgetHandle;
  /** Mongo analysis-by-SHA cache. Checked once Ingest populates ctx.commitSha; a hit
   *  short-circuits the run and returns the cached result. */
  cacheLookup?: CachedAnalysisLookup;
  signal?: AbortSignal;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

export interface PipelineRunResult {
  result: AnalysisResult;
  /** True when Ingest found a cached analysis and short-circuited the run. */
  cached: boolean;
}

const SLICE_VERSION = 1;

/**
 * Run stages in declared order. Assembles the AnalysisResult by per-key slice
 * assignment (never a deep-merge), emits one ProgressEvent per stage, and applies
 * the error contract (see @codeflow/shared-types):
 *   - deterministic stage fails  → run "failed", dependents skipped, partial returned
 *   - AI stage fails             → run "partial", deterministic result intact
 *   - abort signal               → remaining stages skipped
 */
export async function runPipeline(
  stages: readonly PipelineStage[],
  input: PipelineInput,
  options: RunPipelineOptions = {},
): Promise<PipelineRunResult> {
  const now = options.now ?? Date.now;
  const emit = options.emit;
  const logger = options.logger ?? noopLogger;
  const signal = options.signal;

  const runStartedAt = now();
  const slices: Partial<AnalysisResultSlices> = {};
  const records: StageRunRecord[] = [];
  const warnings: string[] = [];

  const ctx: PipelineContext = {
    prior: {},
    cache: options.cache ?? createMemoryCache(),
    budget: options.budget,
    logger,
    signal: signal ?? new AbortController().signal,
    emit,
  };

  let deterministicFailed = false;
  let aiFailed = false;
  let aborted = false;
  let statusReason: PipelineStatusReason | undefined;
  let cacheChecked = false;
  const stageCount = stages.length;
  // Stage IDs already covered by a reused cached result (AI-only retry) — these are NOT
  // re-run; their slices are seeded from the cache. Populated by the cache decision below.
  let coveredStageIds = new Set<PipelineStageId>();

  // --- Pre-Ingest cache decision ---------------------------------------------
  // The cloner resolves the commit SHA only by cloning, so to skip the clone on a hit /
  // AI-only retry the decision MUST happen before Ingest, keyed on the caller-known SHA.
  if (options.cacheLookup && input.requestedCommitSha) {
    const cached = await options.cacheLookup.findCached({
      repositoryRef: input.repositoryRef,
      commitSha: input.requestedCommitSha,
      analyzerVersion: input.analyzerVersion,
    });
    const decision = decideCacheAction(cached, stages);
    if (decision.action === "full-hit") {
      logger.info("Cache full hit (pre-ingest); returning cached result, no stages run.", {
        commitSha: input.requestedCommitSha,
      });
      return { result: decision.result, cached: true };
    }
    if (decision.action === "ai-retry") {
      logger.info("Cache AI-only retry (pre-ingest); seeding deterministic slices, skipping clone.", {
        commitSha: input.requestedCommitSha,
        uncoveredAiStages: [...decision.uncoveredAiStageIds],
      });
      coveredStageIds = coveredStageIdSet(decision.result, stages);
      seedSlicesFromResult(slices, decision.result, coveredStageIds);
      ctx.commitSha = decision.result.commitSha ?? input.requestedCommitSha;
      cacheChecked = true; // do not re-check post-ingest
    }
    // miss → fall through to a normal run; leave cacheChecked false so the post-ingest
    // check can still try by the RESOLVED sha (covers a branch/unknown-sha first analysis).
  }

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stageIndex = i + 1;
    const progress = stageIndex / stageCount;

    // Covered by a reused cached result (AI-only retry): do NOT run — record it completed
    // so the re-stamped producedBy stays honest, and emit a "reused" event. For Ingest this
    // is exactly what avoids the clone on an AI-only retry.
    if (coveredStageIds.has(stage.id)) {
      records.push({ stage: stage.id, kind: stage.kind, status: "completed" });
      emitEvent(emit, {
        input,
        stage,
        stageIndex,
        stageCount,
        status: "completed",
        progress,
        startedAt: now(),
        durationMs: 0,
        now,
        detail: "Reused from cache.",
      });
      continue;
    }

    // Once aborted or a required stage has failed, every remaining stage is skipped.
    if (aborted || signal?.aborted) {
      aborted = true;
      records.push({ stage: stage.id, kind: stage.kind, status: "skipped" });
      emitEvent(emit, {
        input,
        stage,
        stageIndex,
        stageCount,
        status: "skipped",
        progress,
        startedAt: now(),
        durationMs: 0,
        now,
        detail: "Skipped: pipeline aborted.",
      });
      continue;
    }
    if (deterministicFailed) {
      records.push({ stage: stage.id, kind: stage.kind, status: "skipped" });
      emitEvent(emit, {
        input,
        stage,
        stageIndex,
        stageCount,
        status: "skipped",
        progress,
        startedAt: now(),
        durationMs: 0,
        now,
        detail: "Skipped: an earlier required stage failed.",
      });
      continue;
    }

    // Expose accumulated slices to this stage as a read-only snapshot.
    ctx.prior = { ...slices };
    const startedAt = now();

    try {
      const stageResult = await stage.run(input, ctx);

      // Per-key slice assignment — NOT a deep merge.
      for (const key of stage.owns) {
        const value = (stageResult.partial as Partial<AnalysisResultSlices>)[key];
        if (value !== undefined) {
          assignSlice(slices, key, value);
        }
      }

      const durationMs = now() - startedAt;
      records.push({ stage: stage.id, kind: stage.kind, status: "completed", startedAt: iso(startedAt), durationMs });
      emitEvent(emit, {
        input,
        stage,
        stageIndex,
        stageCount,
        status: "completed",
        progress,
        startedAt,
        durationMs,
        now,
        detail: stageResult.event.detail,
        preview: stageResult.event.preview,
      });

      // Post-Ingest cache decision (by the RESOLVED sha) — the fallback for when the SHA
      // was not known upfront (branch / first analysis), so the clone was unavoidable.
      // Same three-way decision; an AI-only retry here still skips parse/graph/metrics.
      if (!cacheChecked && options.cacheLookup && ctx.commitSha) {
        cacheChecked = true;
        const cached = await options.cacheLookup.findCached({
          repositoryRef: input.repositoryRef,
          commitSha: ctx.commitSha,
          analyzerVersion: input.analyzerVersion,
        });
        const decision = decideCacheAction(cached, stages);
        if (decision.action === "full-hit") {
          logger.info("Cache full hit (post-ingest); short-circuiting the pipeline.", { commitSha: ctx.commitSha });
          return { result: decision.result, cached: true };
        }
        if (decision.action === "ai-retry") {
          logger.info("Cache AI-only retry (post-ingest); seeding deterministic slices, skipping their recompute.", {
            commitSha: ctx.commitSha,
            uncoveredAiStages: [...decision.uncoveredAiStageIds],
          });
          coveredStageIds = coveredStageIdSet(decision.result, stages);
          seedSlicesFromResult(slices, decision.result, coveredStageIds);
        } else if (cached) {
          logger.info("Stale cache (deterministic coverage insufficient); full re-run.", {
            commitSha: ctx.commitSha,
            producedBy: cached.producedBy ?? [],
          });
        }
      }
    } catch (error) {
      const durationMs = now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown stage error.";
      // Capture a typed guardrail reason (repo-too-large / budget-exhausted) if the stage
      // threw one, so the run summary can carry a distinct, machine-readable cause.
      const reason = statusReasonOf(error);
      if (reason) statusReason = reason;
      records.push({ stage: stage.id, kind: stage.kind, status: "failed", startedAt: iso(startedAt), durationMs, error: message });
      emitEvent(emit, {
        input,
        stage,
        stageIndex,
        stageCount,
        status: "failed",
        progress,
        startedAt,
        durationMs,
        now,
        error: { message },
      });

      if (stage.kind === "deterministic") {
        deterministicFailed = true;
        warnings.push(`Required stage "${stage.id}" failed: ${message}`);
        logger.error(`Required stage failed: ${stage.id}`, { error: message });
      } else {
        aiFailed = true;
        warnings.push(`AI stage "${stage.id}" failed (degraded result): ${message}`);
        logger.warn(`AI stage failed: ${stage.id}`, { error: message });
      }
    }
  }

  if (aborted) {
    warnings.push("Pipeline aborted; remaining stages were skipped.");
  }

  // Explicit reconciliation: fold Inventory's hard-evidence project-type verdict into
  // the SINGLE canonical orientation.projectType. No stage reaches into another's slice
  // — the orchestrator owns this cross-slice resolution. Inventory wins on hard
  // evidence (it only emits a signal then); otherwise Orient's heuristic stands.
  reconcileProjectType(slices, logger);

  const status: PipelineRunSummary["status"] = deterministicFailed
    ? "failed"
    : aborted
      ? "aborted"
      : aiFailed
        ? "partial"
        : "completed";

  const runSummary: PipelineRunSummary = {
    stages: records,
    status,
    ...(statusReason ? { statusReason } : {}),
    startedAt: iso(runStartedAt),
    completedAt: iso(now()),
  };

  const result = assembleResult(input, ctx, slices, runSummary, warnings, now);
  return { result, cached: false };
}

/**
 * Reconcile the canonical project type. Inventory emits a `projectTypeSignal` ONLY on
 * hard entry-point evidence (a package.json `bin` ⇒ cli). When present, it overrides
 * Orient's heuristic in place on the single `orientation.projectType` field; otherwise
 * Orient's value stands. Requires both slices — a no-op if either is absent.
 */
function reconcileProjectType(slices: Partial<AnalysisResultSlices>, logger: PipelineLogger): void {
  const signal = slices.inventory?.projectTypeSignal;
  const orientation = slices.orientation;
  if (!signal || !orientation) return;
  if (orientation.projectType === signal.projectType) return;
  logger.info("Reconciled projectType from Inventory hard evidence.", {
    from: orientation.projectType,
    to: signal.projectType,
    evidence: signal.evidence,
  });
  slices.orientation = { ...orientation, projectType: signal.projectType };
}

/** Stage IDs that completed (produced their contribution), sorted + deduped. */
function producedStageIds(pipeline: PipelineRunSummary): PipelineStageId[] {
  const completed = pipeline.stages.filter((record) => record.status === "completed").map((record) => record.stage);
  return [...new Set(completed)].sort();
}

// ── Two-tier cache coverage (the wallet fix) ─────────────────────────────────
// producedBy stays an honest sorted list of completed stages; only the INTERPRETATION
// is two-tier. Partition the configured stages by their first-class `kind`:
//   detCovered = configured.deterministic ⊆ producedBy
//   aiCovered  = configured.ai          ⊆ producedBy
// Decision:
//   detCovered && aiCovered  → FULL HIT  (return cached; run nothing; spend nothing)
//   detCovered && !aiCovered → AI-ONLY RETRY (seed from cache, run only uncovered AI stages)
//   !detCovered              → MISS      (full re-analyze)
// Empty configured.ai ⇒ aiCovered trivially true ⇒ collapses to a deterministic-only hit.
// Reusability keys on DETERMINISTIC completeness: a "partial" run (AI failed, all
// deterministic done) is persisted with det-only producedBy and reused as an AI-retry; a
// "failed" run (a deterministic stage failed) is never persisted, so it always misses.

type CacheAction =
  | { action: "full-hit"; result: AnalysisResult }
  | { action: "ai-retry"; result: AnalysisResult; uncoveredAiStageIds: Set<PipelineStageId> }
  | { action: "miss" };

function decideCacheAction(cached: AnalysisResult | null, configured: readonly PipelineStage[]): CacheAction {
  if (!cached || !cached.producedBy) return { action: "miss" };
  const have = new Set(cached.producedBy);
  const detStages = configured.filter((stage) => stage.kind === "deterministic");
  const aiStages = configured.filter((stage) => stage.kind === "ai");

  const detCovered = detStages.every((stage) => have.has(stage.id));
  if (!detCovered) return { action: "miss" };

  const uncoveredAi = aiStages.filter((stage) => !aiStageReusable(stage, cached, have)).map((stage) => stage.id);
  if (uncoveredAi.length === 0) return { action: "full-hit", result: cached };
  return { action: "ai-retry", result: cached, uncoveredAiStageIds: new Set(uncoveredAi) };
}

/**
 * Is the cached contribution of this AI stage REUSABLE under the current configuration?
 * Presence in `producedBy` is necessary but not always sufficient: RAG also requires
 * embedding-space homogeneity — a cached `result.ai.rag` whose `embeddingModel`/
 * `embeddingDim` differs from the currently-selected stage's target is NOT reusable
 * (would mix vector spaces), so RAG counts as uncovered ⇒ re-embed. Derived from the
 * stage's `embeddingTarget` + the cached slice's existing fields (no new flag).
 */
function aiStageReusable(stage: PipelineStage, cached: AnalysisResult, have: Set<PipelineStageId>): boolean {
  if (!have.has(stage.id)) return false;
  const target = (stage as StageEmbeddingTarget).embeddingTarget;
  if (stage.id === "rag" && target) {
    const rag = cached.ai?.rag;
    if (!rag) return false; // producedBy claims rag but the slice is absent → rebuild
    if (rag.embeddingModel !== target.model || rag.embeddingDim !== target.dim) return false;
  }
  return true;
}

/** The configured stages whose cached contribution is reusable (skipped + seeded on
 *  resume). Deterministic stages key on presence; AI stages also pass `aiStageReusable`
 *  (so a vector-space-mismatched RAG slice is NOT treated as covered). */
function coveredStageIdSet(cached: AnalysisResult, configured: readonly PipelineStage[]): Set<PipelineStageId> {
  const have = new Set(cached.producedBy ?? []);
  const covered = new Set<PipelineStageId>();
  for (const stage of configured) {
    const reusable = stage.kind === "deterministic" ? have.has(stage.id) : aiStageReusable(stage, cached, have);
    if (reusable) covered.add(stage.id);
  }
  return covered;
}

/**
 * Seed the slice accumulator from a cached result (AI-only retry resume). Copies the
 * deterministic slices + any AI sub-slices the cached result already carries; the
 * uncovered AI stage(s) then run off this hydrated `ctx.prior`. This is why an AI-only
 * retry reuses the cached deterministic facts instead of recomputing them.
 */
function seedSlicesFromResult(
  slices: Partial<AnalysisResultSlices>,
  result: AnalysisResult,
  covered: Set<PipelineStageId>,
): void {
  if (result.orientation) slices.orientation = result.orientation;
  if (result.structure) slices.structure = result.structure;
  if (result.inventory) slices.inventory = result.inventory;
  if (result.graph) slices.graph = result.graph;
  if (result.metrics) slices.metrics = result.metrics;
  if (result.summary) slices.summary = result.summary;
  if (result.issues) slices.issues = result.issues;
  // Orient's AI summary rides its (deterministic) stage; the true AI stages are seeded
  // ONLY when covered, so an uncovered slice (e.g. a vector-space-mismatched RAG) is NOT
  // hydrated — it must be rebuilt by the re-run, never returned stale if that re-run fails.
  if (result.ai?.projectSummary) slices.aiProjectSummary = result.ai.projectSummary;
  if (covered.has("synthesize") && result.ai?.synthesis) slices.aiSynthesis = result.ai.synthesis;
  if (covered.has("rag") && result.ai?.rag) slices.aiRag = result.ai.rag;
}

/** Per-key assignment helper. Keeps the union-keyed write type-safe at the boundary. */
function assignSlice<K extends AnalysisSliceKey>(
  slices: Partial<AnalysisResultSlices>,
  key: K,
  value: AnalysisResultSlices[K],
): void {
  slices[key] = value;
}

/**
 * Assemble the final AnalysisResult. Deterministic slices map onto same-named
 * fields; the `ai*` slices nest under `result.ai`. Required deterministic fields
 * that no stage produced this run get honest empty defaults.
 */
function assembleResult(
  input: PipelineInput,
  ctx: PipelineContext,
  slices: Partial<AnalysisResultSlices>,
  pipeline: PipelineRunSummary,
  warnings: string[],
  now: () => number,
): AnalysisResult {
  return {
    id: input.jobId,
    repository: input.repositoryRef,
    mode: input.mode,
    createdAt: iso(now()),
    commitSha: ctx.commitSha,
    warnings,
    schemaVersion: SLICE_VERSION,
    producedBy: producedStageIds(pipeline),

    // deterministic slices (empty defaults when not yet produced)
    // `summary` is DERIVED from the other slices at assembly (no stage owns it) — see
    // deriveSummary. An explicit slice, if a stage ever produces one, still wins.
    summary: slices.summary ?? deriveSummary(input, slices),
    // `files` is a DERIVED view of the graph's nodes (single FileNode[] home — Connect
    // owns `graph`, not a separate `files` slice). Falls back to any explicit slice.
    files: slices.graph?.nodes ?? slices.files ?? [],
    symbols: slices.symbols ?? [],
    dependencies: slices.dependencies ?? [],
    issues: slices.issues ?? [],
    metrics: slices.metrics ?? emptyMetrics(),
    graph: slices.graph,
    orientation: slices.orientation,
    structure: slices.structure,
    inventory: slices.inventory,
    entryPoints: slices.entryPoints,

    // AI slice (clearly separated; assembled from the ai* slice keys)
    ai: buildAi(slices),

    pipeline,
  };
}

function buildAi(slices: Partial<AnalysisResultSlices>): AiAnalysis | undefined {
  const { aiProjectSummary, aiSynthesis, aiRag } = slices;
  if (!aiProjectSummary && !aiSynthesis && !aiRag) {
    return undefined;
  }
  return {
    projectSummary: aiProjectSummary,
    synthesis: aiSynthesis,
    rag: aiRag,
  };
}

/** Honest empty metrics for a run where Analyze did not (yet) produce a slice. */
function emptyMetrics(): AnalysisResultSlices["metrics"] {
  return {
    perFile: [],
    keyFiles: [],
    hotspots: [],
    cycles: [],
    summary: { fileCount: 0, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
  };
}

interface EmitArgs {
  input: PipelineInput;
  stage: PipelineStage;
  stageIndex: number;
  stageCount: number;
  status: StageStatus;
  progress: number;
  startedAt: number;
  durationMs: number;
  now: () => number;
  detail?: string;
  preview?: ProgressEvent["preview"];
  error?: ProgressEvent["error"];
}

/** Build the authoritative ProgressEvent (orchestrator owns index/count/progress/timing). */
function emitEvent(emit: PipelineEmitter | undefined, args: EmitArgs): void {
  if (!emit) return;
  const event: ProgressEvent = {
    jobId: args.input.jobId,
    stage: args.stage.id,
    stageIndex: args.stageIndex,
    stageCount: args.stageCount,
    kind: args.stage.kind,
    status: args.status,
    label: args.stage.label,
    detail: args.detail,
    progress: args.progress,
    startedAt: iso(args.startedAt),
    durationMs: args.durationMs,
    preview: args.preview,
    error: args.error,
    emittedAt: iso(args.now()),
  };
  emit(event);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const noopLogger: PipelineLogger = {
  info() {},
  warn() {},
  error() {},
};

function createMemoryCache(): AnalysisCacheHandle {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (store.has(key) ? (store.get(key) as T) : null);
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
  };
}
