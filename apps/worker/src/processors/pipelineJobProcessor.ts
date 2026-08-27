import {
  createAnalyzeStage,
  createConnectStage,
  createIngestStage,
  createInventoryStage,
  createMapStructureStage,
  createOrientStage,
  createRagStage,
  createSynthesizeStage,
  runPipeline,
  type CachedAnalysisLookup,
  type EmbeddingClient,
  type LlmClient,
  type RepoCloner,
  type WalkEntry,
} from "@codeflow/analyzers";
import type {
  AnalysisCacheHandle,
  AnalysisJobPayload,
  AnalysisResult,
  BudgetHandle,
  EventLogStore,
  JobStatus,
  PipelineInput,
  PipelineRunStatus,
  PipelineStage,
  PipelineStageId,
  ProgressPublisher,
} from "@codeflow/shared-types";
import type { WorkerAnalysisService } from "../services/workerAnalysisService.js";

export interface PipelineJobDependencies {
  service: WorkerAnalysisService;
  cloner: RepoCloner;
  publisher: ProgressPublisher;
  /** Reads repo-relative files for Orient (manifests + README) and Map-structure (.gitignore). */
  readFile: (repoPath: string, relativePath: string) => Promise<string | null>;
  /** Lists immediate children of a repo-relative dir for Map-structure's tree walk. */
  readDir: (repoPath: string, relativeDir: string) => Promise<WalkEntry[]>;
  /** Guard 1 — measures the cloned tree so Ingest can enforce the repo-size cap. */
  measureRepoSize?: (repoPath: string) => Promise<{ fileCount: number; totalBytes: number }>;
  /** Guard 5 — global daily LLM-spend ceiling, passed to the AI stages via ctx.budget. */
  budget?: BudgetHandle;
  /** SSE replay buffer (#20): every emitted ProgressEvent + the terminal done is appended
   *  so a late-connecting client can replay from Ingest. Omitted ⇒ no persistence. */
  eventLog?: EventLogStore;
  /** Optional cleanup of the cloned working tree once the run finishes. */
  cleanupRepo?: (repoPath: string) => Promise<void>;
  /** LLM client for the Synthesize (AI) stage. When absent, Synthesize is NOT registered
   *  and the pipeline runs deterministic-only (no API key configured ⇒ no AI stage). */
  synthesisClient?: LlmClient;
  /** Embedding client for the RAG (AI) stage. When absent (no VOYAGE_API_KEY), RAG is NOT
   *  registered and `configured.ai` simply omits it (the P10 coverage partition stays
   *  correct — an ANTHROPIC-only setup runs Synthesize but not RAG). */
  embeddingClient?: EmbeddingClient;
  /** Persistent cache for AI completions (LLM-output cache). Defaults to the orchestrator's
   *  per-run in-memory cache when omitted. */
  cache?: AnalysisCacheHandle;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

export interface PipelineJobOutcome {
  analysisId?: string;
  cached: boolean;
  status: PipelineRunStatus;
  /** AI stages that never ran because no provider was configured (see skippedAiStages). */
  skippedStages: PipelineStageId[];
}

/** Human-readable note per skippable AI stage, appended to result.warnings. */
const AI_STAGE_NOTES: Record<"synthesize" | "rag", string> = {
  synthesize:
    'AI stage "synthesize" was skipped: no chat provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY). The onboarding guide is unavailable; the deterministic analysis is complete.',
  rag: 'AI stage "rag" was skipped: no embedding provider configured (set VOYAGE_API_KEY or GEMINI_API_KEY). Ask-the-repo Q&A is unavailable; the deterministic analysis is complete.',
};

/**
 * Which AI stages produced nothing because their provider was never configured?
 *
 * A stage counts as skipped only when BOTH its client is absent AND the final result
 * carries no output for it — so a cache hit that already holds an AI slice is never
 * mislabelled "skipped". This is the signal the UI needs to distinguish "still working"
 * from "never going to run"; without it stages 7-8 sit at "pending" forever while the run
 * reports "completed".
 */
function skippedAiStages(deps: PipelineJobDependencies, result: AnalysisResult): PipelineStageId[] {
  const skipped: PipelineStageId[] = [];
  if (!deps.synthesisClient && !result.ai?.synthesis) skipped.push("synthesize");
  if (!deps.embeddingClient && !result.ai?.rag) skipped.push("rag");
  return skipped;
}

/**
 * Run one analysis job through the pipeline orchestrator
 * ([ingest, orient, map-structure, inventory, connect, analyze]).
 *
 * - Emits each ProgressEvent over the publisher (→ SSE), plus a terminal done event.
 * - Cache hit (orchestrator-detected) → return cached, do NOT re-save.
 * - Cache miss with a usable result (completed/partial) → persist to Mongo keyed on
 *   the resolved commit SHA (the same key the orchestrator's cache lookup reads).
 * - failed/aborted runs are NOT persisted (incomplete data must not poison the cache).
 * - Surfaces the run status onto the job record.
 */
export async function runAnalysisJob(
  payload: AnalysisJobPayload,
  deps: PipelineJobDependencies,
): Promise<PipelineJobOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let clonedPath: string | undefined;

  // Wrap the cloner so we can clean up the working tree afterwards (the resolved
  // repoPath lives on ctx, which the caller doesn't see).
  const cloner: RepoCloner = {
    clone: async (request) => {
      const cloned = await deps.cloner.clone(request);
      clonedPath = cloned.repoPath;
      return cloned;
    },
  };

  const cacheLookup: CachedAnalysisLookup = {
    findCached: async ({ commitSha }) => {
      const cached = await deps.service.findCachedAnalysis({ payload: { ...payload, commitSha }, commitSha });
      return cached?.result ?? null;
    },
  };

  const input: PipelineInput = {
    jobId: payload.jobId,
    repositoryRef: payload.repositoryRef,
    mode: payload.mode,
    analyzerVersion: payload.analyzerVersion,
    requestedCommitSha: payload.commitSha,
  };

  await deps.service.updateJob(payload.jobId, {
    status: "cloning",
    progress: 0.1,
    currentStep: "Ingesting repository.",
  });

  try {
    const stages: PipelineStage[] = [
      createIngestStage({ cloner, measureRepoSize: deps.measureRepoSize, now }),
      createOrientStage({ readFile: deps.readFile, now }),
      createMapStructureStage({ readDir: deps.readDir, readFile: deps.readFile, now }),
      createInventoryStage({ readFile: deps.readFile, now }),
      createConnectStage({ readFile: deps.readFile, now }),
      createAnalyzeStage({ now }),
    ];
    // Synthesize (AI) is registered only when an LLM client is configured (owner's keys).
    // Without it the pipeline runs deterministic-only; with it, an AI failure degrades to
    // "partial" (deterministic slices intact), never "failed".
    if (deps.synthesisClient) {
      stages.push(createSynthesizeStage({ client: deps.synthesisClient, now }));
    }
    // RAG (AI, stage 8) registers only when an embedding client is configured. It reuses
    // the same readFile abstraction (disk path) and the same cache handle (both the
    // embedding cache and the SHA-keyed chunk-plan cache live there, namespaced).
    if (deps.embeddingClient) {
      stages.push(createRagStage({ client: deps.embeddingClient, readFile: deps.readFile, now }));
    }
    const { result: ranResult, cached } = await runPipeline(stages, input, {
      emit: (event) => {
        void deps.publisher.publishProgress(payload.jobId, event);
        // Persist to the replay buffer (#20) so a late connection still sees this stage.
        void deps.eventLog?.append(payload.jobId, { kind: "progress", jobId: payload.jobId, event });
      },
      cacheLookup,
      cache: deps.cache,
      budget: deps.budget,
      now,
    });

    // An unconfigured AI stage is recorded on the result itself (warnings, persisted with
    // the analysis) as well as on the job record below, so the omission survives a reload
    // and a cache hit instead of living only in this process's stdout.
    const skippedStages = skippedAiStages(deps, ranResult);
    // `warnings` is required by the contract but a cached document persisted by an older
    // analyzer may predate it, so treat it as optional here rather than trusting the type.
    const existingWarnings = ranResult.warnings ?? [];
    const notes = skippedStages
      .map((stage) => AI_STAGE_NOTES[stage as "synthesize" | "rag"])
      .filter((note) => note && !existingWarnings.includes(note));
    const result: AnalysisResult = notes.length
      ? { ...ranResult, warnings: [...existingWarnings, ...notes] }
      : ranResult;

    const status: PipelineRunStatus = cached ? "completed" : result.pipeline?.status ?? "completed";
    let analysisId = cached ? result.id : undefined;

    const shouldSave = !cached && (status === "completed" || status === "partial");
    if (shouldSave) {
      const saved = await deps.service.saveAnalysis({
        payload: { ...payload, commitSha: result.commitSha ?? payload.commitSha },
        result,
        durationMs: now() - startedAt,
        commitSha: result.commitSha,
      });
      analysisId = saved.analysisId;
    }

    // A guardrail outcome (repo-too-large / budget-exhausted) carries a distinct typed
    // reason so the UI can say "too large" / "at capacity" rather than a generic failure.
    const statusReason = cached ? undefined : result.pipeline?.statusReason;
    await deps.service.updateJob(payload.jobId, {
      status: toJobStatus(status),
      runStatus: status,
      ...(statusReason ? { runStatusReason: statusReason } : {}),
      ...(skippedStages.length ? { skippedStages } : {}),
      progress: 1,
      currentStep: cached ? "Cached analysis returned." : `Analysis ${status}.`,
      analysisId,
      cached,
      commitSha: result.commitSha,
    });

    await deps.eventLog?.append(payload.jobId, { kind: "done", jobId: payload.jobId, status });
    await deps.publisher.publishDone(payload.jobId, status);
    return { analysisId, cached, status, skippedStages };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analysis error.";
    await deps.service.updateJob(payload.jobId, {
      status: "failed",
      runStatus: "failed",
      progress: 0,
      currentStep: "Analysis failed.",
      error: message,
    });
    await deps.eventLog?.append(payload.jobId, { kind: "done", jobId: payload.jobId, status: "failed" });
    await deps.publisher.publishDone(payload.jobId, "failed");
    throw error;
  } finally {
    if (clonedPath && deps.cleanupRepo) {
      await deps.cleanupRepo(clonedPath).catch(() => undefined);
    }
  }
}

/** Job lifecycle enum has no partial/aborted; map run status onto completed/failed. */
function toJobStatus(status: PipelineRunStatus): JobStatus {
  return status === "failed" || status === "aborted" ? "failed" : "completed";
}
