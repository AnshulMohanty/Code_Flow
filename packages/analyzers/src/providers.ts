// Env-based provider selection for the AI layer. Both adapters sit behind the existing
// injectable interfaces (LlmClient / EmbeddingClient), so the provider is the ONLY thing
// that varies — selected here, no vendor lock-in. A single GEMINI_API_KEY can power both
// synthesis and RAG. These helpers are pure given an env record (tests pass a fake env);
// the worker calls them with process.env.

import {
  createAnthropicClient,
  createGeminiClient,
  createOpenAiClient,
  type LlmClient,
  type LlmProvider,
} from "./llm/llmClient.js";
import {
  createGeminiEmbeddingClient,
  createOpenAiEmbeddingClient,
  createVoyageClient,
  DEFAULT_GEMINI_EMBED_DIM,
  DEFAULT_OPENAI_EMBED_MODEL,
  DEFAULT_VOYAGE_DIM,
  openAiEmbeddingDimension,
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
  /** Powers BOTH roles, like GEMINI_API_KEY: chat when LLM_PROVIDER=openai, embeddings when
   *  EMBEDDING_PROVIDER=openai. One key, two independent choices. */
  OPENAI_API_KEY?: string;
  // model overrides (all optional; sensible defaults applied)
  SYNTHESIS_MODEL?: string;
  GEMINI_MODEL?: string;
  VOYAGE_MODEL?: string;
  OPENAI_MODEL?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  GEMINI_EMBEDDING_DIM?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  /** Truncation override for the Matryoshka v3 models. Unset ⇒ the model's NATIVE width. */
  OPENAI_EMBEDDING_DIM?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/** The chat providers, and the key each one needs. Order is the order an error lists them in. */
const CHAT_PROVIDER_KEYS = [
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["gemini", "GEMINI_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
] as const;

/** The embedding providers, and the key each one needs. `local` is not here: it is keyless and is
 *  selected by the local-first CLI directly, never inferred from an environment. */
const EMBEDDING_PROVIDER_KEYS = [
  ["voyage", "VOYAGE_API_KEY"],
  ["gemini", "GEMINI_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
] as const;

/**
 * The shared selection rule, written once for both roles.
 *
 * EXPLICIT WINS, AND AN AMBIGUOUS CONFIG REFUSES TO GUESS. With one key present the provider is
 * unambiguous and is inferred; with several, picking one would silently decide which vendor a
 * deployment pays and — on the embedding side — which embedding space its index lives in. That is
 * not a default anyone should inherit by accident, so it throws and names both the keys it found and
 * the variable that settles it.
 *
 * Generalised from a two-provider if/else when OpenAI was added: the old form said "both keys are
 * set", which stops being true at three and would have had to be reworded in four places.
 */
function selectProvider<P extends string>(
  table: ReadonlyArray<readonly [P, string]>,
  env: ProviderEnv,
  explicitRaw: string | undefined,
  explicitVar: string,
): P | null {
  const valid = table.map(([provider]) => provider);
  const explicit = explicitRaw?.trim().toLowerCase();
  if (explicit) {
    const match = valid.find((provider) => provider === explicit);
    if (!match) {
      throw new Error(`${explicitVar} must be one of ${valid.join(" | ")} (got "${explicitRaw}").`);
    }
    return match;
  }
  const configured = table.filter(([, key]) => Boolean((env as Record<string, string | undefined>)[key]));
  if (configured.length > 1) {
    throw new Error(
      `${configured.map(([, key]) => key).join(" and ")} are set; set ${explicitVar} to disambiguate.`,
    );
  }
  return configured[0]?.[0] ?? null;
}

/**
 * Resolve the selected chat provider from env. Explicit `LLM_PROVIDER` wins (validated);
 * otherwise infer from whichever key is present. MORE THAN ONE key + no explicit provider
 * ⇒ throw a clear config error (ambiguous — refuse to guess). Returns null when no
 * provider can be selected (no key at all).
 */
export function resolveChatProvider(env: ProviderEnv): LlmProvider | null {
  return selectProvider(CHAT_PROVIDER_KEYS, env, env.LLM_PROVIDER, "LLM_PROVIDER");
}

/**
 * Build the chat client for the selected provider, or undefined when the SELECTED
 * provider's key is absent (⇒ Synthesize is not registered). Throws only on an ambiguous
 * config (several keys, no explicit provider).
 */
export function createLlmClientFromEnv(env: ProviderEnv): LlmClient | undefined {
  const provider = resolveChatProvider(env);
  if (!provider) return undefined;
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return undefined;
    return createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.SYNTHESIS_MODEL || DEFAULT_ANTHROPIC_MODEL });
  }
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return undefined;
    // OPENAI_MODEL is this provider's own override, parallel to GEMINI_MODEL. SYNTHESIS_MODEL is
    // NOT read here on purpose: it defaults to an Anthropic model id, and a deployment that set it
    // for Anthropic and then flipped LLM_PROVIDER would otherwise send "claude-opus-4-8" to OpenAI
    // and get a 404 that reads like an outage.
    return createOpenAiClient({ apiKey: env.OPENAI_API_KEY, ...(env.OPENAI_MODEL ? { model: env.OPENAI_MODEL } : {}) });
  }
  if (!env.GEMINI_API_KEY) return undefined;
  return createGeminiClient({ apiKey: env.GEMINI_API_KEY, ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}) });
}

/**
 * Resolve the selected embedding provider from env — same inference + ambiguity rule as chat, and
 * INDEPENDENT of it: `LLM_PROVIDER=openai` with `EMBEDDING_PROVIDER=voyage` is a supported pairing,
 * and so is the reverse. (A Gemini-only setup has only GEMINI_API_KEY ⇒ infers "gemini" for both.)
 */
export function resolveEmbeddingProvider(env: ProviderEnv): EmbeddingProvider | null {
  return selectProvider(EMBEDDING_PROVIDER_KEYS, env, env.EMBEDDING_PROVIDER, "EMBEDDING_PROVIDER");
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
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return undefined;
    const openAiDim = positiveInt(env.OPENAI_EMBEDDING_DIM);
    // The dimension is NOT defaulted to a constant here. It comes from the selected MODEL (1536 for
    // text-embedding-3-small, 3072 for -large) and `OPENAI_EMBEDDING_DIM` only truncates it. That
    // number is what becomes `EmbeddingSpace.embeddingDim` and therefore the pgvector table name, so
    // a wrong default would not be a wrong default — it would be a table nothing can read.
    return createOpenAiEmbeddingClient({
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_EMBEDDING_MODEL ? { model: env.OPENAI_EMBEDDING_MODEL } : {}),
      ...(openAiDim !== undefined ? { dimension: openAiDim } : {}),
    });
  }
  if (!env.GEMINI_API_KEY) return undefined;
  const dim = env.GEMINI_EMBEDDING_DIM ? Number(env.GEMINI_EMBEDDING_DIM) : undefined;
  return createGeminiEmbeddingClient({
    apiKey: env.GEMINI_API_KEY,
    ...(env.GEMINI_EMBEDDING_MODEL ? { model: env.GEMINI_EMBEDDING_MODEL } : {}),
    ...(dim && Number.isFinite(dim) ? { dimension: dim } : {}),
  });
}

/**
 * THE EMBEDDING WIDTH A GIVEN ENV WILL PRODUCE, without building a client or needing a key.
 *
 * It exists so a deployment can be told which pgvector table its configuration addresses BEFORE it
 * writes a vector into it — `codeflow_vectors_<dim>` — which is the one fact that makes an embedding
 * provider switch safe to reason about. Returns null when no embedding provider is selected.
 */
export function resolveEmbeddingDimension(env: ProviderEnv): number | null {
  const provider = resolveEmbeddingProvider(env);
  if (!provider) return null;
  if (provider === "voyage") return DEFAULT_VOYAGE_DIM;
  if (provider === "openai") {
    return positiveInt(env.OPENAI_EMBEDDING_DIM) ?? openAiEmbeddingDimension(env.OPENAI_EMBEDDING_MODEL || DEFAULT_OPENAI_EMBED_MODEL);
  }
  if (provider === "gemini") return positiveInt(env.GEMINI_EMBEDDING_DIM) ?? DEFAULT_GEMINI_EMBED_DIM;
  return null;
}

/** A positive integer from an env string, or undefined. "" / "0" / "abc" / "1.5" all mean unset —
 *  an override that cannot be honoured must not become a silent 0-dimension table name. */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
