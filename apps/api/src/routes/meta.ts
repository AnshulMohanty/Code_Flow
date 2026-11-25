import { Router } from "express";
import { aiStatusFromEnv } from "@codeflow/analyzers";
import { ANALYZER_VERSION } from "@codeflow/config";
import type { DailyCapLimits } from "../middleware/dailyCap.js";
import { answerLatency } from "../services/answerLatency.js";
import { listIndexedAnalyses } from "../services/analysisCacheService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * `/api/meta` — the facts the UI chrome needs, and NOTHING it could otherwise invent (V3-FINAL).
 *
 * WHY AN ENDPOINT AT ALL. The design's nav, HUD and footer show a version, a build identity, a p50
 * answer latency and a list of already-indexed repositories. A component with no source for those
 * has exactly two options, and one of them is to make them up — which is precisely what a shipped
 * UI must never do. So each one is either read from something real or reported as unknown, and the
 * component renders an honest em-dash for the second case rather than a plausible number.
 *
 * WHAT IS REAL HERE:
 *   `analyzerVersion`  the constant the pipeline stamps on every result. The thing that actually
 *                      determines whether a cached analysis is reusable, so it is the honest
 *                      "version" for a page about analyses.
 *   `build`            the git SHA, when the deployment supplied one. NOT invented from a timestamp:
 *                      a build id nobody can look up is decoration.
 *   `answerLatency`    measured, per-process, with its sample count and scope stated — see
 *                      `answerLatency.ts` on why the scope is reported rather than implied.
 *   `indexed`          repositories this deployment has ACTUALLY analysed, newest first. The design
 *                      shows a "recents" list; a hardcoded one would be the prototype's sample data
 *                      shipped as if it were the user's history.
 *
 * WHAT IS DELIBERATELY ABSENT: a cold-index time. The design's "~41s cold index" is a measured
 * figure on the prototype's sample repo, and this deployment has no equivalent measurement — the
 * per-stage durations on a result are for THAT repo at THAT size. The UI renders the real per-run
 * total when it has a result and says nothing when it does not.
 */
/** Recents shown by the workbench entry step. Bounded — this is a convenience list, not a feed. */
export const META_INDEXED_LIMIT = 8;

/**
 * `ai` says which modes a visitor can pick (map only is always available; "map + AI" only when a
 * provider key is configured) and which model answers — read from the same env the worker uses, so
 * the badge cannot claim a model the pipeline is not running. `limits` are the per-visitor daily caps,
 * so the UI can say "3 AI analyses a day" instead of surprising someone with a 429.
 */
export function metaRouter(limits: DailyCapLimits = { aiAnalyses: null, questions: null }): Router {
  const router = Router();
  router.get(
    "/api/meta",
    asyncHandler(async (_req, res) => {
      const indexed = await listIndexedAnalyses(META_INDEXED_LIMIT);
      res.json({
        analyzerVersion: ANALYZER_VERSION,
        // Read from env, absent when unset. A deployment that wants a build shown supplies one;
        // fabricating it from the process start time would put an unlookuppable id in the footer.
        build: process.env.GIT_SHA || process.env.SOURCE_COMMIT || null,
        answerLatency: answerLatency(),
        indexed,
        // Not a guess: `null` means this process has never been asked, and the UI says so.
        serverTime: new Date().toISOString(),
        ai: aiStatusFromEnv(process.env),
        limits: { dailyAiAnalysesPerIp: limits.aiAnalyses, dailyQuestionsPerIp: limits.questions },
      });
    }),
  );
  return router;
}
