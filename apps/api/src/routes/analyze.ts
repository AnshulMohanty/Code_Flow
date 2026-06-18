import { Router } from "express";
import { env } from "../config/env.js";
import { findCachedAnalysis } from "../services/analysisCacheService.js";
import { createAnalysisJob, updateAnalysisJob } from "../services/analysisJobService.js";
import { normalizeRepositoryForCache, upsertRepository } from "../services/repositoryService.js";
import { enqueueAnalysisJob } from "../queues/analysisQueue.js";
import type { AnalyzeRequestBody } from "../types/api.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../middleware/errorHandler.js";
import { getRequestedCommitSha, validateAnalyzeRequest } from "../utils/repoRef.js";

export const analyzeRouter = Router();

analyzeRouter.post(
  "/api/analyze",
  asyncHandler(async (req, res) => {
    const body = req.body as AnalyzeRequestBody;
    const { mode, repository } = validateAnalyzeRequest(body);
    const normalized = normalizeRepositoryForCache(repository);
    const requestedCommitSha = getRequestedCommitSha(body);
    const cached = requestedCommitSha
      ? await findCachedAnalysis({
          repoFullName: normalized.fullName,
          commitSha: requestedCommitSha,
          analyzerVersion: env.analyzerVersion,
        })
      : null;

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
