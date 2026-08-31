import { Router, type RequestHandler } from "express";
import { BudgetExceededError, type RagAnswer } from "@codeflow/analyzers";
import { getAnalysisJob } from "../services/analysisJobService.js";
import { getAnalysisById } from "../services/analysisCacheService.js";
import { getAskHandler } from "../services/ragQaService.js";
import { recordAnswerLatency } from "../services/answerLatency.js";
import { ApiError } from "../middleware/errorHandler.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * The Ask response: a grounded `RagAnswer`, plus honest flags for the no-index / at-capacity
 * states (the UI branches on these instead of treating them as errors).
 *
 * V3-P3 widened this ADDITIVELY rather than replacing it: the agent's answer is a superset of
 * `RagAnswer`, so the existing UI keeps working untouched and the new fields (`sessionId`,
 * `citedFiles`, `trace`) are there for a client that wants them. An agent that forced a new
 * response shape would have made this phase a frontend change as well.
 */
export type AskResponse = RagAnswer & {
  unavailable?: boolean;
  atCapacity?: boolean;
  /** Echoed back so the client can continue the conversation. */
  sessionId?: string;
  /** File-level citations the agent grounded but that are not line ranges. */
  citedFiles?: string[];
  /** Per-turn agent trace, when the agent path ran. Plain data. */
  trace?: unknown;
};

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
      // RUNTIME validation at an untrusted external boundary (an API body), same rule as
      // `question` above. A session id is used as a STORE KEY, so it is length- and
      // charset-checked rather than trusted: an unbounded key is a memory-exhaustion vector, and
      // a key containing separators could collide with another namespace in a shared Redis.
      const sessionId = readSessionId(req.body?.sessionId);

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
        const startedAt = Date.now();
        const answer = await getAskHandler()({
          result: cached.result,
          question,
          analysisId: job.analysisId,
          ...(sessionId ? { sessionId } : {}),
        });
        // MEASURED HERE because this is the only place that knows (V3-FINAL). Only an ANSWERED
        // response is sampled: a refusal is fast because it does no work, and letting refusals into
        // the window would make the p50 improve the more often the service failed to answer.
        if (answer.answered) recordAnswerLatency(Date.now() - startedAt);
        res.json({ ...answer, ...(sessionId ? { sessionId } : {}) } satisfies AskResponse);
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

/** Max characters of a client-supplied session id. Long enough for a UUID, bounded because the
 *  value becomes a store key. */
const MAX_SESSION_ID_LENGTH = 64;

/**
 * Validate a client-supplied session id, or return undefined for a fresh (stateless) ask.
 *
 * Rejecting rather than sanitising: silently rewriting a bad id would give the client a session it
 * cannot address again, which is a worse outcome than being told the id was invalid.
 */
function readSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "`sessionId` must be a string when present.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SESSION_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `\`sessionId\` must be at most ${MAX_SESSION_ID_LENGTH} characters of [A-Za-z0-9._-].`,
    );
  }
  return trimmed;
}
