// Embedding access for the RAG stage, behind a tiny injectable interface so unit tests
// mock it and make ZERO real API calls (mirrors LlmClient). The model + key are
// configuration (owner's keys per the plan) — never hardcoded.

import type { TokenUsage } from "@codeflow/shared-types";
import { estimatedUsage, measuredUsage, sumUsage, usageNumber } from "../util/tokens.js";

export interface EmbeddingRequest {
  /** Texts to embed, in order. The returned vectors align 1:1 with this array. */
  texts: string[];
  /**
   * Indexing side uses "document"; the future ask-the-repo query path uses "query".
   * Voyage prepends a task-specific prompt before vectorization for retrieval quality.
   */
  inputType: "document" | "query";
}

/** An embedding provider identifier (part of the embedding cache key + RAG index
 *  homogeneity check, so vectors from different spaces are never mixed or mis-served). */
export type EmbeddingProvider = "voyage" | "gemini";

/**
 * One vector per input text plus what the call cost. Widened from a bare `number[][]` in
 * V3-P0 so embedding spend is measured rather than estimated (mirrors LlmCompletionResult).
 */
export interface EmbeddingResult {
  /** One vector per input text, in input order (the stage stores them as-is). */
  vectors: number[][];
  /** Provider-reported usage where available; `measured: false` when estimated. */
  usage: TokenUsage;
}

/** Returns one vector per input text, in input order, with its real token cost. */
export interface EmbeddingClient {
  /** Vendor identifier — scopes the embedding cache key (see rag.ts). */
  readonly provider: EmbeddingProvider;
  readonly model: string;
  /** The model's vector length — stored as `Rag.embeddingDim`. */
  readonly dimension: number;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface VoyageClientOptions {
  apiKey: string;
  /** Voyage's current best CODE embedding model. Defaults to "voyage-code-3". */
  model?: string;
  /**
   * Output vector length. voyage-code-3 supports 256/512/1024/2048; 1024 is the
   * documented default and what `Rag.embeddingDim` records. Confirmed against
   * https://docs.voyageai.com/docs/embeddings (June 2026).
   */
  dimension?: number;
  /** Override for tests/proxies; defaults to the public API. */
  baseUrl?: string;
}

const DEFAULT_VOYAGE_MODEL = "voyage-code-3";
const DEFAULT_VOYAGE_DIM = 1024;

/**
 * Minimal `fetch`-based Voyage embeddings client — no SDK dependency. This is the
 * production adapter wired in the worker when `VOYAGE_API_KEY` is configured; it is NOT
 * exercised by unit tests (those inject a mock EmbeddingClient), so it is deliberately
 * small and side-effect-only at call time.
 *
 * Request/response shape confirmed against the current Voyage docs (June 2026):
 *   POST https://api.voyageai.com/v1/embeddings
 *   Authorization: Bearer <key>;  body { input: string[], model, input_type, output_dimension }
 *   → { data: [{ embedding: number[], index: number }, ...], usage: { total_tokens } }
 * Per-request limits: ≤1000 texts and ≤120K total tokens (the stage batches under these).
 */
export function createVoyageClient(options: VoyageClientOptions): EmbeddingClient {
  const baseUrl = options.baseUrl ?? "https://api.voyageai.com";
  const model = options.model ?? DEFAULT_VOYAGE_MODEL;
  const dimension = options.dimension ?? DEFAULT_VOYAGE_DIM;

  return {
    provider: "voyage",
    model,
    dimension,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      if (request.texts.length === 0) {
        return { vectors: [], usage: { inputTokens: 0, outputTokens: 0, measured: true } };
      }

      const response = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          input: request.texts,
          model,
          input_type: request.inputType,
          output_dimension: dimension,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Voyage API error ${response.status}: ${detail.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
        usage?: { total_tokens?: unknown };
      };
      const data = json.data ?? [];
      if (data.length !== request.texts.length) {
        throw new Error(`Voyage API returned ${data.length} embeddings for ${request.texts.length} inputs.`);
      }

      // Re-order by `index` (the API documents an index per embedding) so vectors align
      // to the input order regardless of response ordering.
      const vectors: number[][] = new Array(request.texts.length);
      data.forEach((entry, i) => {
        const at = typeof entry.index === "number" ? entry.index : i;
        if (!Array.isArray(entry.embedding)) {
          throw new Error(`Voyage API returned a non-array embedding at index ${at}.`);
        }
        vectors[at] = entry.embedding;
      });

      // Voyage reports `usage.total_tokens` — all input (embeddings have no output tokens).
      const totalTokens = usageNumber(json.usage?.total_tokens);
      const usage =
        totalTokens !== undefined
          ? measuredUsage(totalTokens, 0)
          : estimatedUsage(request.texts.join("\n"));

      return { vectors, usage };
    },
  };
}

export interface GeminiEmbeddingClientOptions {
  apiKey: string;
  /** Defaults to "gemini-embedding-001". */
  model?: string;
  /**
   * Output vector length. Defaults to 768 (recommended — ~0.26% quality loss vs 3072,
   * 4× smaller vectors, and eases the Mongo 16MB BSON-size ledger item). Reported as
   * `Rag.embeddingDim`.
   */
  dimension?: number;
  /** Override for tests/proxies; defaults to the public API. */
  baseUrl?: string;
}

const DEFAULT_GEMINI_EMBED_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_EMBED_DIM = 768;
// Gemini's batchEmbedContents accepts up to ~100 requests per call; cap conservatively.
// The RAG stage already batches by its own limits, then this client re-chunks under this.
const GEMINI_EMBED_MAX_BATCH = 100;

/**
 * Minimal `fetch`-based Google Gemini embeddings client — no SDK, mirroring
 * `createVoyageClient`. Behind the SAME `EmbeddingClient` interface, so the RAG stage
 * (chunking / grounding / caching) is unchanged. Indexing uses taskType
 * "RETRIEVAL_DOCUMENT" (the future query path would use "RETRIEVAL_QUERY").
 *
 * batchEmbedContents shape:
 *   POST .../v1beta/models/{model}:batchEmbedContents   header x-goog-api-key
 *   body { requests: [{ model: "models/{model}", content: { parts: [{ text }] },
 *          taskType, outputDimensionality }] }  → { embeddings: [{ values: number[] }] }
 */
export function createGeminiEmbeddingClient(options: GeminiEmbeddingClientOptions): EmbeddingClient {
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com";
  const model = options.model ?? DEFAULT_GEMINI_EMBED_MODEL;
  const dimension = options.dimension ?? DEFAULT_GEMINI_EMBED_DIM;

  return {
    provider: "gemini",
    model,
    dimension,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      if (request.texts.length === 0) {
        return { vectors: [], usage: { inputTokens: 0, outputTokens: 0, measured: true } };
      }
      const taskType = request.inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";

      const vectors: number[][] = [];
      const usageParts: TokenUsage[] = [];
      for (let offset = 0; offset < request.texts.length; offset += GEMINI_EMBED_MAX_BATCH) {
        const batch = request.texts.slice(offset, offset + GEMINI_EMBED_MAX_BATCH);
        const response = await fetch(`${baseUrl}/v1beta/models/${model}:batchEmbedContents`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": options.apiKey,
          },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType,
              outputDimensionality: dimension,
            })),
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Gemini embeddings API error ${response.status}: ${detail.slice(0, 500)}`);
        }

        const json = (await response.json()) as {
          embeddings?: Array<{ values?: number[] }>;
          // Not documented for batchEmbedContents today; read it opportunistically so the
          // usage becomes MEASURED for free if Google starts reporting it.
          usageMetadata?: { totalTokenCount?: unknown; promptTokenCount?: unknown };
        };
        const embeddings = json.embeddings ?? [];
        if (embeddings.length !== batch.length) {
          throw new Error(`Gemini API returned ${embeddings.length} embeddings for ${batch.length} inputs.`);
        }
        for (const entry of embeddings) {
          if (!Array.isArray(entry.values)) {
            throw new Error("Gemini API returned a non-array embedding.");
          }
          vectors.push(entry.values);
        }

        // HONEST GAP: the Gemini batch-embed endpoint reports no usage today, so this batch
        // is ESTIMATED and flagged `measured: false` rather than recorded as if it were
        // real. That flag is what keeps the "cost is measured" claim truthful instead of
        // making an estimate indistinguishable from a provider number.
        const reported =
          usageNumber(json.usageMetadata?.totalTokenCount) ?? usageNumber(json.usageMetadata?.promptTokenCount);
        usageParts.push(reported !== undefined ? measuredUsage(reported, 0) : estimatedUsage(batch.join("\n")));
      }

      return { vectors, usage: sumUsage(usageParts) };
    },
  };
}
