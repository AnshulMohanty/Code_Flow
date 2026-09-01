import type { TokenUsage } from "@codeflow/shared-types";

/**
 * The ONE token-accounting module (V3-P0). Before this there were three identical
 * `Math.ceil(text.length / 4)` copies (synthesize.ts, rag.ts, rag/answer.ts) and no way to
 * tell an estimate from a real cost.
 *
 * The split that matters:
 *
 *   estimateTokens()  — ADMISSION CONTROL only. You have to guess a call's size *before*
 *                       making it, so the pre-flight `budget.check()` is necessarily an
 *                       estimate. It is also used for the DETERMINISTIC chunk plan, where a
 *                       stable arithmetic function is a feature, not a compromise.
 *   TokenUsage        — the real cost, read back from the provider's response after the
 *                       call, and the ONLY thing `budget.record()` should be given on a
 *                       paid path. This is what makes "cost is measured, not estimated"
 *                       true rather than aspirational.
 *
 * WHY NO LOCAL TOKENIZER. The obvious move is to add a BPE tokenizer and count exactly.
 * That would be *worse*: this codebase talks to Anthropic, Gemini, and Voyage, and their
 * vocabularies differ, so any single local tokenizer is precisely wrong for at least two of
 * the three. It would also be a heavy dependency on a path where the authoritative number
 * is already available for free — the provider bills us and tells us what it billed. The
 * estimate stays deliberately cheap and is never used to report cost.
 */

/**
 * Characters per token for the estimate. ~4 is the usual English-text rule of thumb; real
 * code tends to run denser (~3), so this UNDER-estimates code slightly.
 *
 * Deliberately unchanged from the three copies it replaces: `estimateTokens` also drives
 * the RAG chunk plan, so altering it would move chunk boundaries, change every embedding,
 * and invalidate the index — a behaviour change disguised as a refactor. Tuning it is a
 * separate, measured decision (see the deferred ledger).
 */
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * Deterministic token ESTIMATE for admission control and chunk planning.
 * Never use this to report what something cost — use the provider's `TokenUsage`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/** Total billable tokens in a usage record (cache tokens are already counted as input). */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** A usage record built from the ESTIMATE, explicitly flagged `measured: false`. Used only
 *  when a provider reports nothing usable, so the gap is visible instead of implied. */
export function estimatedUsage(inputText: string, outputText = ""): TokenUsage {
  return {
    inputTokens: estimateTokens(inputText),
    outputTokens: outputText ? estimateTokens(outputText) : 0,
    measured: false,
  };
}

/** A usage record from provider-reported numbers. */
export function measuredUsage(
  inputTokens: number,
  outputTokens: number,
  cache: { read?: number; write?: number } = {},
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    measured: true,
    ...(cache.read !== undefined ? { cacheReadTokens: cache.read } : {}),
    ...(cache.write !== undefined ? { cacheWriteTokens: cache.write } : {}),
  };
}

/**
 * Read a non-negative integer out of an untrusted provider response field. Providers
 * occasionally omit a counter or send a string; a NaN silently poisoning the budget ledger
 * is worse than falling back to the estimate, so this returns undefined rather than guessing.
 */
export function usageNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return undefined;
}

/** Sum usage records (e.g. a batched embedding call). `measured` survives only if EVERY
 *  part was measured — one estimated part makes the total an estimate. */
export function sumUsage(parts: TokenUsage[]): TokenUsage {
  if (parts.length === 0) return { inputTokens: 0, outputTokens: 0, measured: true };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let measured = true;
  for (const part of parts) {
    inputTokens += part.inputTokens;
    outputTokens += part.outputTokens;
    cacheRead += part.cacheReadTokens ?? 0;
    cacheWrite += part.cacheWriteTokens ?? 0;
    if (!part.measured) measured = false;
  }
  return {
    inputTokens,
    outputTokens,
    measured,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
