import type { DegradationNotice } from "@codeflow/shared-types";
import { isMongoConnected } from "../db/connectMongo.js";

/**
 * Report Mongo-down as a VISIBLE degradation (V3-P0).
 *
 * The API silently falls back to per-process in-memory Maps for jobs, analyses, repos and
 * the SSE replay log when Mongo is unavailable. That keeps the service answering, which is
 * the right call — but it was completely invisible: a user got a job id that would vanish on
 * restart, a "cached" analysis no other replica could see, and no indication why. The
 * fallback stays; the silence does not.
 *
 * This is deliberately computed at READ time rather than stored: whether persistence is
 * degraded is a property of the process right now, not of the job record, and a stored flag
 * would go stale the moment Mongo came back.
 */
export function persistenceDegradation(): DegradationNotice | null {
  if (isMongoConnected()) return null;
  return {
    reason: "mongo-unavailable",
    detail:
      "The database is unavailable, so this run is held in memory only: it will not survive a restart and is not shared across API instances. Check MONGO_URI.",
  };
}

/**
 * Merge the live persistence degradation into a run's stored degradations, de-duplicated by
 * reason so a repeated read cannot pile up copies.
 */
export function withPersistenceDegradation(stored: DegradationNotice[] | undefined): DegradationNotice[] {
  const live = persistenceDegradation();
  if (!live) return stored ?? [];
  const existing = stored ?? [];
  return existing.some((notice) => notice.reason === live.reason) ? existing : [...existing, live];
}
