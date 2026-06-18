import { Router, type RequestHandler } from "express";
import { BudgetExceededError, type RagAnswer } from "@codeflow/analyzers";
import { getAnalysisJob } from "../services/analysisJobService.js";
import { getAnalysisById } from "../services/analysisCacheService.js";
import { getAskHandler } from "../services/ragQaService.js";
import { ApiError } from "../middleware/errorHandler.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** The Ask response: a grounded `RagAnswer`, plus honest flags for the no-index / at-capacity
 *  states (the UI branches on these instead of treating them as errors). */
export type AskResponse = RagAnswer & { unavailable?: boolean; atCapacity?: boolean };

/**
 * Ask-the-repo endpoint (P18). `POST /api/result/:id/ask` loads the stored analysis + its
 * `ai.rag` index and answers the question grounded ONLY in retrieved code. Wallet-guarded:
 * per-IP rate limit (429) + the daily budget (honest "demo at capacity"). 404 for an unknown
 * job; a clear "Q&A unavailable" (not 500) when the run built no index. Non-streamed JSON.
 */
export function askRouter(rateLimit: RequestHandler): Router {
  const router = Router();

  router.post(
    "/api/result/:id/ask",
    rateLimit,
    asyncHandler(async (req, res) => {
      const jobId = String(req.params.id);
      const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
      if (!question) {
        throw new ApiError(400, "INVALID_REQUEST", "A non-empty `question` is required.");
      }

      const job = await getAnalysisJob(jobId); // 404 (JSON) if the job is unknown
      const unavailable = (message: string): AskResponse => ({ answer: message, answered: false, citations: [], retrievedChunkIds: [], unavailable: true });

      if (!job.analysisId) {
        res.json(unavailable("Q&A is unavailable: this analysis is not ready yet."));
        return;
      }
      const cached = await getAnalysisById(job.analysisId);
      if (!cached) {
        throw new ApiError(404, "NOT_FOUND", `Analysis result not found: ${job.analysisId}`, { analysisId: job.analysisId });
      }
      if (!cached.result.ai?.rag) {
        res.json(unavailable("Q&A is unavailable for this analysis (no searchable index was built — e.g. a deterministic-only or partial run)."));
        return;
      }

      try {
        const answer = await getAskHandler()({ result: cached.result, question });
        res.json(answer satisfies AskResponse);
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const atCapacity: AskResponse = {
            answer: "Demo at capacity — the daily AI budget has been reached. Please try again later.",
            answered: false,
            citations: [],
            retrievedChunkIds: [],
            atCapacity: true,
          };
          res.json(atCapacity);
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
