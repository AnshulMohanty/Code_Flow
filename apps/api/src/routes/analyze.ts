import { Router } from "express";
import { aiStatusFromEnv, lacksAvailableAi } from "@codeflow/analyzers";
import { env } from "../config/env.js";
import type { DailyCaps } from "../middleware/dailyCap.js";
import { findCachedAnalysis } from "../services/analysisCacheService.js";
import { createAnalysisJob, updateAnalysisJob } from "../services/analysisJobService.js";
import { normalizeRepositoryForCache, upsertRepository } from "../services/repositoryService.js";
import { enqueueAnalysisJob } from "../queues/analysisQueue.js";
import type { AnalyzeRequestBody } from "../types/api.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../middleware/errorHandler.js";
import { getRequestedCommitSha, validateAnalyzeRequest } from "../utils/repoRef.js";

/**
 * `POST /api/analyze`. Two modes (2026-11-25): `withAi: false` is "map only" — the deterministic
 * stages, nothing spent — and anything else asks for the AI stages too, which run only when this
 * server has a provider key. The daily per-visitor cap is charged ONLY for a run that will actually
 * spend: a cache hit and a map-only run are free, so they never count against it.
 */
export function createAnalyzeRouter(dailyCaps?: DailyCaps): Router {
  const analyzeRouter = Router();

  analyzeRouter.post(
    "/api/analyze",
    asyncHandler(async (req, res) => {
      const body = req.body as AnalyzeRequestBody;
      const { mode, repository } = validateAnalyzeRequest(body);
      const normalized = normalizeRepositoryForCache(repository);
      const requestedCommitSha = getRequestedCommitSha(body);
      if (body.withAi !== undefined && typeof body.withAi !== "boolean") {
        throw new ApiError(400, "INVALID_REQUEST", "`withAi` must be a boolean when present.");
      }
      const ai = aiStatusFromEnv(process.env);
      const withAi = body.withAi !== false && ai.enabled;
      const found = requestedCommitSha
        ? await findCachedAnalysis({
            repoFullName: normalized.fullName,
            commitSha: requestedCommitSha,
            analyzerVersion: env.analyzerVersion,
          })
        : null;
      // A map-only result does not answer a request for AI on a server that has AI.
      const cached =
        found && withAi && lacksAvailableAi(found.result, { chat: Boolean(ai.chatModel), embeddings: Boolean(ai.embeddingModel) })
          ? null
          : found;

      if (cached) {
        const fileCount = cached.summary.files;
        const job = await createAnalysisJob({
          mode,
          repositoryRef: normalized.repository,
          repoFullName: normalized.fullName,
          commitSha: cached.commitSha,
          analyzerVersion: env.analyzerVersion,
          analysisId: cached.id,
          cached: true,
          status: "completed",
          progress: 1,
          currentStep: "Cached analysis returned.",
          parsedFiles: fileCount,
          totalFiles: fileCount,
        });

        res.status(202).json({
          jobId: job.jobId,
          status: job.status,
          cached: true,
          analysisId: cached.id,
          message: "Cached analysis returned.",
        });
        return;
      }

      if (withAi && dailyCaps) {
        const cap = await dailyCaps.consume("ai-analysis", req.ip ?? "unknown");
        if (!cap.allowed) {
          throw new ApiError(
            429,
            "DAILY_LIMIT",
            `You have used today's ${cap.limit} AI analyses. "Map only" is free and still available; AI analyses reset at midnight UTC.`,
            { limit: cap.limit, resetAt: cap.resetAt },
          );
        }
      }

      await upsertRepository(normalized);
      const job = await createAnalysisJob({
        repositoryRef: normalized.repository,
        repoFullName: normalized.fullName,
        mode,
        commitSha: requestedCommitSha ?? normalized.commitSha,
        analyzerVersion: env.analyzerVersion,
      });

      const enqueueResult = await enqueueAnalysisJob({
        jobId: job.jobId,
        mode,
        repositoryRef: normalized.repository,
        commitSha: requestedCommitSha ?? normalized.commitSha,
        analyzerVersion: env.analyzerVersion,
        withAi,
      });

      if (enqueueResult.enqueued) {
        res.status(202).json({
          jobId: job.jobId,
          status: "queued",
          cached: false,
          message: "Analysis job queued.",
        });
        return;
      }

      // The job queue is unavailable (e.g. Redis is down). Fail honestly — do NOT
      // fabricate a result or write fake data to Mongo. Mark the job failed and return 503.
      // TODO (deferred): add a real inline pipeline runner that executes the REAL analysis
      // synchronously when the queue is unavailable — never a mock.
      const reason = enqueueResult.reason ?? "The analysis queue is currently unavailable.";
      console.warn(`Analysis queue unavailable; returning 503. ${reason}`.trim());
      await updateAnalysisJob(job.jobId, {
        status: "failed",
        progress: 0,
        currentStep: "Analysis queue unavailable.",
        error: reason,
      });

      throw new ApiError(503, "QUEUE_UNAVAILABLE", "The analysis queue is currently unavailable. Please try again shortly.", {
        jobId: job.jobId,
        reason,
      });
    }),
  );

  return analyzeRouter;
}
