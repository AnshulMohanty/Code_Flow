import { Router } from "express";
import { getAnalysisJob, getAnalysisJobProgress } from "../services/analysisJobService.js";
import { getAnalysisById } from "../services/analysisCacheService.js";
import { ApiError } from "../middleware/errorHandler.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const resultsRouter = Router();

resultsRouter.get(
  "/api/result/:id",
  asyncHandler(async (req, res) => {
    const jobId = String(req.params.id);
    const job = await getAnalysisJob(jobId);
    const progress = await getAnalysisJobProgress(jobId);

    if (progress.status !== "completed") {
      if (progress.status === "failed") {
        throw new ApiError(500, "INTERNAL_ERROR", progress.error ?? "Analysis job failed.", { jobId });
      }
      res.status(202).json({
        status: "pending",
        jobId: job.jobId,
        message: "Analysis is not completed yet.",
      });
      return;
    }

    if (!job.analysisId) {
      // A completed job must reference a persisted analysis. If it does not, that is a
      // real server-side inconsistency — surface it honestly rather than fabricating a result.
      throw new ApiError(500, "INTERNAL_ERROR", "Completed job has no associated analysis result.", {
        jobId: job.jobId,
      });
    }

    const cached = await getAnalysisById(job.analysisId);
    if (!cached) {
      throw new ApiError(404, "NOT_FOUND", `Analysis result not found: ${job.analysisId}`, {
        analysisId: job.analysisId,
      });
    }
    res.json(cached.result);
  }),
);

resultsRouter.get(
  "/api/analysis/:analysisId",
  asyncHandler(async (req, res) => {
    const analysisId = String(req.params.analysisId);
    const cached = await getAnalysisById(analysisId);
    if (!cached) {
      throw new ApiError(404, "NOT_FOUND", `Analysis result not found: ${analysisId}`, { analysisId });
    }
    res.json(cached.result);
  }),
);
