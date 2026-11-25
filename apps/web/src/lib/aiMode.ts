import type { AnalysisResult, DegradationReason } from "@codeflow/shared-types";
import type { MetaState } from "./useMeta";

/**
 * THE TWO MODES — "Map only" and "Map + AI" — and every sentence the UI says about them.
 *
 * Map only runs the deterministic stages and spends nothing. Map + AI adds the guide and the Q&A
 * index, which cost provider credits and are capped per visitor per day. The SERVER decides what is
 * possible (`/api/meta` → `ai`); the visitor decides what to ask for; the RESULT says what actually
 * ran (`runMode`, `degradations`). Those are three different facts and this file keeps them apart.
 *
 * ONE RULE FOR THE COPY: plain language, no developer jargon, and never an environment variable
 * name. The worker's own `detail` strings are written for operators ("check MONGO_URI") and are
 * never shown to a visitor — each reason maps to a sentence written here instead.
 */

export type AiChoice = "map-only" | "map-ai";

export interface AiAvailability {
  /** True when this server told us (its `/api/meta` carries `ai`). */
  known: boolean;
  /** Whether "Map + AI" can be chosen. False ONLY when the server said so. */
  enabled: boolean;
  chatModel: string | null;
  /** Per-visitor daily caps the server reported, or null when it did not say. */
  dailyAiAnalyses: number | null;
  dailyQuestions: number | null;
  /**
   * Whether to offer the switch at all. An OLDER server (meta answered, but without `ai`) cannot
   * honour `withAi`, so a switch there would be a control that does nothing — it is hidden and the
   * request is sent exactly as before. While meta is still loading or failed we cannot know, so the
   * switch is shown and the server enforces what it can do.
   */
  offerSwitch: boolean;
}

export function aiAvailability(meta: MetaState): AiAvailability {
  const facts = meta.status === "ready" ? meta.facts : null;
  const ai = facts?.ai;
  const limits = facts?.limits;
  return {
    known: Boolean(ai),
    enabled: ai ? ai.enabled : true,
    chatModel: ai?.chatModel ?? null,
    dailyAiAnalyses: limits?.dailyAiAnalysesPerIp ?? null,
    dailyQuestions: limits?.dailyQuestionsPerIp ?? null,
    offerSwitch: meta.status !== "ready" || Boolean(ai),
  };
}

/** The default choice: Map + AI when the server can do it, Map only otherwise. */
export function defaultChoice(availability: AiAvailability): AiChoice {
  return availability.enabled ? "map-ai" : "map-only";
}

/**
 * The choice actually in force. A visitor's pick wins, except that "Map + AI" can never be in force
 * on a server that said AI is off — the option is disabled, and this makes the state agree with it.
 */
export function effectiveChoice(picked: AiChoice | null, availability: AiAvailability): AiChoice {
  if (!availability.enabled) return "map-only";
  return picked ?? defaultChoice(availability);
}

/**
 * The `withAi` field for `POST /api/analyze`, or undefined to omit it. Omitted when the switch is
 * not offered (an older server), so the request is byte-for-byte what it was before the modes.
 */
export function withAiFor(choice: AiChoice, availability: AiAvailability): boolean | undefined {
  if (!availability.offerSwitch) return undefined;
  return choice === "map-ai";
}

/** The nav / workbench badge. Null when there is no mode to report (an older server). */
export function modeBadge(choice: AiChoice, availability: AiAvailability): { label: string; title: string; ai: boolean } | null {
  if (!availability.offerSwitch) return null;
  if (!availability.enabled) {
    return { label: "Map only", title: "AI is off on this server. The map is free and complete.", ai: false };
  }
  if (choice === "map-only") {
    return { label: "Map only", title: "Map only: the deterministic graph, nothing spent.", ai: false };
  }
  return availability.chatModel
    ? { label: `AI · ${availability.chatModel}`, title: `Map + AI: the guide and Q&A are written by ${availability.chatModel}.`, ai: true }
    : { label: "Map + AI", title: "Map + AI: the guide and Q&A use this server's AI provider.", ai: true };
}

// ── Degradations, in a visitor's words ─────────────────────────────────────────

export type BannerTone = "info" | "partial" | "refused";

export interface VisitorBanner {
  reason: DegradationReason | "deterministic-only";
  tone: BannerTone;
  text: string;
}

export const MAP_ONLY_COPY = "Map only — no AI was used. Switch to Map + AI to add the guide and Q&A.";
export const AI_UNAVAILABLE_COPY = "AI is unavailable right now (limit or credit reached). The map is complete.";
export const BUDGET_COPY =
  "Demo at capacity — the daily AI budget has been reached. The map is complete and unaffected.";

/** One sentence per reason. Exhaustive over the union, so a new reason is a type error here. */
export function degradationCopy(reason: DegradationReason): { tone: BannerTone; text: string } {
  switch (reason) {
    case "map-only":
      return { tone: "info", text: MAP_ONLY_COPY };
    case "ai-unavailable":
      return { tone: "partial", text: AI_UNAVAILABLE_COPY };
    case "budget-exhausted":
      return { tone: "partial", text: BUDGET_COPY };
    case "no-chat-provider":
      return { tone: "partial", text: "No AI guide on this run — this server has no AI set up. The map is complete." };
    case "no-embedding-provider":
      return { tone: "partial", text: "No Q&A on this run — this server has no search index set up. The map is complete." };
    case "mongo-unavailable":
      return {
        tone: "partial",
        text: "Storage is down, so this run is kept in memory only and will not be saved. Everything shown is complete.",
      };
    case "redis-unavailable":
      return { tone: "partial", text: "The job queue was unavailable for part of this run. Everything shown is complete." };
  }
}

/** Short form for a pipeline row or a `cause:` line. */
export function degradationShort(reason: DegradationReason): string {
  switch (reason) {
    case "map-only":
      return "map only — AI not requested";
    case "ai-unavailable":
      return "AI unavailable — limit or credit reached";
    case "budget-exhausted":
      return "daily AI budget reached";
    case "no-chat-provider":
      return "no AI set up on this server";
    case "no-embedding-provider":
      return "no search index set up on this server";
    case "mongo-unavailable":
      return "storage down — run not saved";
    case "redis-unavailable":
      return "job queue unavailable";
  }
}

/**
 * The banners a result warrants, de-duplicated by reason and in a stable order (what the visitor
 * chose first, then what went wrong). A deterministic-only run that names no reason still gets one
 * line, because silence there would read as a full run.
 */
export function visitorBanners(result: AnalysisResult | null): VisitorBanner[] {
  if (!result) return [];
  const seen = new Set<string>();
  const banners: VisitorBanner[] = [];
  for (const notice of result.degradations ?? []) {
    if (seen.has(notice.reason)) continue;
    seen.add(notice.reason);
    banners.push({ reason: notice.reason, ...degradationCopy(notice.reason) });
  }
  if (banners.length === 0 && result.runMode === "deterministic-only") {
    banners.push({
      reason: "deterministic-only",
      tone: "info",
      text: "The AI stages did not run on this analysis, so there is no guide or Q&A. The map is complete.",
    });
  }
  const order: Record<string, number> = { "map-only": 0, "ai-unavailable": 1, "budget-exhausted": 2 };
  return banners.sort((a, b) => (order[a.reason] ?? 9) - (order[b.reason] ?? 9));
}

/** Whether this result was a Map-only run by the visitor's own choice. */
export function isMapOnlyRun(result: AnalysisResult | null): boolean {
  return Boolean(result?.degradations?.some((notice) => notice.reason === "map-only"));
}

// ── Operator text never reaches a visitor ─────────────────────────────────────

/** `ANTHROPIC_API_KEY`, `MONGO_URI`, `LLM_PRICING`… — an upper-case token with an underscore. */
const ENV_VAR = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

/** True when a server string names an environment variable (operator advice, not visitor copy). */
export function mentionsEnvVar(text: string): boolean {
  return ENV_VAR.test(text);
}

/** Warnings safe to show a visitor, verbatim. Operator-facing ones are dropped, not rewritten. */
export function visitorWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !mentionsEnvVar(warning));
}

// ── The daily cap ─────────────────────────────────────────────────────────────

export const DAILY_LIMIT_CODE = "DAILY_LIMIT";

export const DAILY_LIMIT_ANALYZE_COPY =
  "Daily limit reached — you have used today's AI analyses. Map only is free and still works: switch to Map only and analyze again.";

export const DAILY_LIMIT_ASK_COPY =
  "Daily limit reached — you have used today's questions. The map, the numbers and every module view still work.";

// ── Q&A coverage ──────────────────────────────────────────────────────────────

/**
 * One honest line when the Q&A index was CAPPED (large repos on the hosted demo index their most
 * connected files first). Null when the index covers everything — absent means full coverage, and
 * saying so would be noise.
 */
export function ragCoverageNote(result: AnalysisResult | null): string | null {
  const capped = result?.ai?.rag?.capped;
  if (!capped) return null;
  const n = (value: number) => value.toLocaleString("en-US");
  return `Q&A covers the ${n(capped.indexedFiles)} most-connected of ${n(capped.totalFiles)} files.`;
}
