// Env-based provider selection for the AI layer. Both adapters sit behind the existing
// injectable interfaces (LlmClient / EmbeddingClient), so the provider is the ONLY thing
// that varies — selected here, no vendor lock-in. A single GEMINI_API_KEY can power both
// synthesis and RAG. These helpers are pure given an env record (tests pass a fake env);
// the worker calls them with process.env.

import {
  createAnthropicClient,
  createGeminiClient,
  type LlmClient,
  type LlmProvider,
} from "./llm/llmClient.js";
import {
  createGeminiEmbeddingClient,
  createVoyageClient,
  type EmbeddingClient,
  type EmbeddingProvider,
} from "./embedding/embeddingClient.js";

/** The subset of env vars the selection helpers read. */
export interface ProviderEnv {
  LLM_PROVIDER?: string;
  EMBEDDING_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  // model overrides (all optional; sensible defaults applied)
  SYNTHESIS_MODEL?: string;
  GEMINI_MODEL?: string;
  VOYAGE_MODEL?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  GEMINI_EMBEDDING_DIM?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/**
 * Resolve the selected chat provider from env. Explicit `LLM_PROVIDER` wins (validated);
 * otherwise infer from whichever key is present. Both keys present + no explicit provider
 * ⇒ throw a clear config error (ambiguous — refuse to guess). Returns null when no
 * provider can be selected (no key at all).
 */
export function resolveChatProvider(env: ProviderEnv): LlmProvider | null {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (explicit !== "anthropic" && explicit !== "gemini") {
      throw new Error(`LLM_PROVIDER must be "anthropic" or "gemini" (got "${env.LLM_PROVIDER}").`);
    }
    return explicit;
  }
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;
  const hasGemini = !!env.GEMINI_API_KEY;
  if (hasAnthropic && hasGemini) {
    throw new Error("Both ANTHROPIC_API_KEY and GEMINI_API_KEY are set; set LLM_PROVIDER to disambiguate.");
  }
  if (hasAnthropic) return "anthropic";
  if (hasGemini) return "gemini";
  return null;
}

/**
 * Build the chat client for the selected provider, or undefined when the SELECTED
 * provider's key is absent (⇒ Synthesize is not registered). Throws only on an ambiguous
 * config (both keys, no explicit provider).
 */
export function createLlmClientFromEnv(env: ProviderEnv): LlmClient | undefined {
  const provider = resolveChatProvider(env);
  if (!provider) return undefined;
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return undefined;
    return createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.SYNTHESIS_MODEL || DEFAULT_ANTHROPIC_MODEL });
  }
  if (!env.GEMINI_API_KEY) return undefined;
  return createGeminiClient({ apiKey: env.GEMINI_API_KEY, ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}) });
}

/**
 * Resolve the selected embedding provider from env — same inference + both-set error rule
 * as chat. (A Gemini-only setup has only GEMINI_API_KEY ⇒ infers "gemini" for both.)
 */
export function resolveEmbeddingProvider(env: ProviderEnv): EmbeddingProvider | null {
  const explicit = env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (explicit !== "voyage" && explicit !== "gemini") {
      throw new Error(`EMBEDDING_PROVIDER must be "voyage" or "gemini" (got "${env.EMBEDDING_PROVIDER}").`);
    }
    return explicit;
  }
  const hasVoyage = !!env.VOYAGE_API_KEY;
  const hasGemini = !!env.GEMINI_API_KEY;
  if (hasVoyage && hasGemini) {
    throw new Error("Both VOYAGE_API_KEY and GEMINI_API_KEY are set; set EMBEDDING_PROVIDER to disambiguate.");
  }
  if (hasVoyage) return "voyage";
  if (hasGemini) return "gemini";
  return null;
}

/**
 * Build the embedding client for the selected provider, or undefined when the SELECTED
 * provider's key is absent (⇒ RAG is not registered).
 */
export function createEmbeddingClientFromEnv(env: ProviderEnv): EmbeddingClient | undefined {
  const provider = resolveEmbeddingProvider(env);
  if (!provider) return undefined;
  if (provider === "voyage") {
    if (!env.VOYAGE_API_KEY) return undefined;
    return createVoyageClient({ apiKey: env.VOYAGE_API_KEY, ...(env.VOYAGE_MODEL ? { model: env.VOYAGE_MODEL } : {}) });
  }
  if (!env.GEMINI_API_KEY) return undefined;
  const dim = env.GEMINI_EMBEDDING_DIM ? Number(env.GEMINI_EMBEDDING_DIM) : undefined;
  return createGeminiEmbeddingClient({
    apiKey: env.GEMINI_API_KEY,
    ...(env.GEMINI_EMBEDDING_MODEL ? { model: env.GEMINI_EMBEDDING_MODEL } : {}),
    ...(dim && Number.isFinite(dim) ? { dimension: dim } : {}),
  });
}
