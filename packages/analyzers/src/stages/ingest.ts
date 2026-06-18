import { MAX_BYTES, MAX_FILES } from "@codeflow/config";
import type {
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepositoryRef,
  StageResult,
} from "@codeflow/shared-types";
import { RepoTooLargeError } from "../pipeline/errors.js";

/** Result of cloning + resolving a repository to a concrete commit. */
export interface ClonedRepo {
  repoPath: string;
  commitSha: string;
}

/**
 * Validates + shallow-clones a public repo and resolves its real HEAD commit SHA.
 * Kept behind an interface so tests can fake it (no real network / git).
 */
export interface RepoCloner {
  clone(input: { repositoryRef: RepositoryRef; requestedCommitSha?: string }): Promise<ClonedRepo>;
}

/** Cheap size measure of the cloned working tree (file count + total bytes). */
export interface RepoSize {
  fileCount: number;
  totalBytes: number;
}

export interface IngestDependencies {
  cloner: RepoCloner;
  /**
   * Guard 1 — measures the cloned tree so Ingest can enforce the size cap POST-CLONE,
   * BEFORE any parsing (Map-structure/Inventory). Injectable (real fs walk in the worker;
   * mocked in tests). When omitted the cap is skipped (back-compat).
   */
  measureRepoSize?: (repoPath: string) => Promise<RepoSize>;
  /** Cap overrides (default to @codeflow/config — the canonical P7-tunable values). */
  maxFiles?: number;
  maxBytes?: number;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

/**
 * Stage 1 — Ingest (PLAN §4): validate URL, shallow clone, resolve the real commit
 * SHA. Pure: owns NO result slice; it bootstraps the run by writing the resolved
 * repoPath + commitSha onto ctx for downstream stages. The CACHE READ now lives in
 * the orchestrator (it checks the cache once ctx.commitSha is populated) — Ingest
 * itself no longer touches the cache and never short-circuits.
 */
export function createIngestStage(deps: IngestDependencies): PipelineStage<never> {
  const now = deps.now ?? Date.now;
  const maxFiles = deps.maxFiles ?? MAX_FILES;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;

  return {
    id: "ingest",
    kind: "deterministic",
    label: "Ingesting repository",
    owns: [], // no result slice — Ingest bootstraps ctx
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<never>> {
      const startedAt = now();

      const { repoPath, commitSha } = await deps.cloner.clone({
        repositoryRef: input.repositoryRef,
        requestedCommitSha: input.requestedCommitSha,
      });

      // Write resolved values into ctx so stages 2+ (and the orchestrator's cache
      // check) can rely on them.
      ctx.repoPath = repoPath;
      ctx.commitSha = commitSha;

      // Guard 1 — authoritative size cap, POST-CLONE and BEFORE parsing. Over cap ⇒ a
      // typed RepoTooLargeError; the orchestrator marks the run "failed" + statusReason
      // "repo-too-large" and skips dependents (a clean refusal, not a crash mid-parse).
      if (deps.measureRepoSize) {
        const size = await deps.measureRepoSize(repoPath);
        if (size.fileCount > maxFiles || size.totalBytes > maxBytes) {
          throw new RepoTooLargeError(
            size.fileCount,
            size.totalBytes,
            `Repository is too large to analyze: ${size.fileCount} files / ${size.totalBytes} bytes ` +
              `(cap ${maxFiles} files / ${maxBytes} bytes).`,
          );
        }
      }

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "ingest",
        // stageIndex/stageCount/progress are authoritative on the orchestrator; the
        // stage cannot know its position. These are placeholders the orchestrator
        // overrides — only `detail`/`preview` here are stage-authored.
        stageIndex: 1,
        stageCount: 1,
        kind: "deterministic",
        status: "completed",
        label: "Ingesting repository",
        detail: `Resolved commit ${commitSha.slice(0, 12)}.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: { commitSha },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: {}, event };
    },
  };
}
