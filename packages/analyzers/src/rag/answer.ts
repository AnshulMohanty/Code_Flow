import { createHash } from "node:crypto";
import { stripCodeFence } from "../llm/completionText.js";
import { RAG_MIN_SIMILARITY, RAG_TOP_K } from "@codeflow/config";
import {
  assertEmbeddingSpace,
  createLexicalOverlapReranker,
  hybridSearch,
  type ChunkTextStore,
  type HybridSearchTrace,
  type Reranker,
  type RetrievedChunk,
  type VectorStore,
} from "@codeflow/retrieval";
import type { AnalysisCacheHandle, BudgetHandle, Rag } from "@codeflow/shared-types";
import type { LlmClient } from "../llm/llmClient.js";
import type { EmbeddingClient } from "../embedding/embeddingClient.js";
import { BudgetExceededError } from "../pipeline/errors.js";
import { estimateTokens } from "../util/tokens.js";
import { embedCacheKey, type CachedEmbedding } from "./embedCache.js";

/**
 * The minimum a chunk must expose to be CITED: an id to match the model's claim against, and
 * the real coordinates to resolve it to. Deliberately narrower than `RetrievedChunk` so the
 * grounding step cannot accidentally depend on a score or on the chunk text.
 */
export interface CitableChunk {
  id: string;
  fileId: string;
  startLine: number;
  endLine: number;
}

/** A grounded citation — resolves to a RETRIEVED chunk's real file + line range. */
export interface RagAnswerCitation {
  fileId: string;
  startLine: number;
  endLine: number;
}

export interface RagAnswer {
  /** Grounded prose, or the honest no-answer message. */
  answer: string;
  citations: RagAnswerCitation[];
  retrievedChunkIds: string[];
  /** False ⇒ honest "not found in the repo" (or an LLM refusal) — never fabricated. */
  answered: boolean;
  /** Citations the LLM emitted that didn't map to a retrieved chunk (dropped by grounding). */
  droppedCitations?: { count: number; ids: string[] };
  /**
   * Per-stage retrieval trace (V3-P2): arm hit counts, what each arm found alone, the reranker
   * that ran (or the error that made it degrade), the vector cosine the refusal floor was
   * compared against. Present on every answer, including a refusal — a refusal is exactly when
   * you want to know what retrieval actually saw.
   */
  retrieval?: HybridSearchTrace;
}

export interface AnswerQuestionDeps {
  question: string;
  /** The already-built index (`result.ai.rag`) — chunk METADATA + a `store` reference. Since
   *  V3-P2 the vectors and text live in the two stores below, not in this slice. */
  ragIndex: Rag;
  /** Where the index's vectors live. Injected: memory in the suite, pgvector in production. */
  vectorStore: VectorStore;
  /** Where the index's chunk text lives. Same injection rule. */
  textStore: ChunkTextStore;
  /**
   * Reranker for the hybrid pipeline (V3-P2). Defaults to the deterministic lexical-overlap
   * one — keyless, in-process, zero-dependency (see `reranker.ts` for the probe that ruled out
   * every ONNX cross-encoder for the pruned image). Pass `createIdentityReranker()` to turn
   * reranking off explicitly, or a `createCrossEncoderReranker` once a session exists.
   */
  reranker?: Reranker;
  chatClient: LlmClient;
  embeddingClient: EmbeddingClient;
  cache: AnalysisCacheHandle;
  /** Daily spend ceiling; checked AFTER the caches (a cache hit spends nothing). */
  budget?: BudgetHandle;
  commitSha?: string;
  k?: number;
  minSimilarity?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT =
  "You are a precise code assistant answering questions about ONE repository. Answer the user's " +
  "question USING ONLY the provided code chunks — do NOT use any outside knowledge, and do NOT " +
  "guess. If the chunks do not contain the answer, set \"answered\" to false and say so. Cite the " +
  "chunk ids you actually used. Respond with a SINGLE JSON object and nothing else: " +
  '{"answer": string, "answered": boolean, "citations": [{"chunkId": string}]}.';

const NO_ANSWER =
  "I couldn't find anything about that in this repository's indexed code. Try rephrasing, or ask about a file you can see in the dashboard.";

/**
 * The ask-the-repo query path (P18) — a RUNTIME path, not a pipeline stage. Embeds the question
 * (query side), retrieves top-k from the already-built index, answers GROUNDED ONLY in the
 * retrieved chunks, and cites real file+line. Guards: embedding-space homogeneity, honest
 * no-answer (no LLM call below the similarity floor / on empty retrieval — never fabricates),
 * and cache-before-budget on both the query embed and the answer call.
 */
export async function answerQuestion(deps: AnswerQuestionDeps): Promise<RagAnswer> {
  const { question, ragIndex, chatClient, embeddingClient, cache } = deps;
  const k = deps.k ?? RAG_TOP_K;
  const minSimilarity = deps.minSimilarity ?? RAG_MIN_SIMILARITY;

  // Guard 1 — the question MUST be embedded in the index's space.
  assertEmbeddingSpace(embeddingClient, ragIndex, "RAG index");
  // Guard 1b (V3-P2) — and the STORE holding that index must be in the same space too. Two
  // separate checks because they catch two different mistakes: a client/index mismatch is a
  // stale analysis, a client/store mismatch is a misconfigured deployment.
  assertEmbeddingSpace(embeddingClient, deps.vectorStore.space, `vector store ${deps.vectorStore.id}`);

  const queryVector = await embedQuery(deps);

  // V3-P2: HYBRID retrieval — vector + BM25, fused by RRF, reranked, diversified by MMR. The
  // refusal floor is evaluated INSIDE, on the vector arm's real cosine and before any rerank,
  // so the honest-no-answer behaviour is byte-identical to the pre-hybrid path and a refusal
  // still costs exactly one vector search.
  const found = await hybridSearch(
    {
      ragIndex,
      vectorStore: deps.vectorStore,
      textStore: deps.textStore,
      reranker: deps.reranker ?? createLexicalOverlapReranker(),
    },
    { text: question, vector: queryVector, k, minSimilarity },
  );
  const retrieved = found.chunks;
  const retrievedChunkIds = retrieved.map((c) => c.id);

  // Honest no-answer: refused by the floor, or nothing survived grounding ⇒ do NOT call the
  // answer LLM. The trace travels with the refusal, because "what did retrieval see" is the
  // first question anyone asks about one.
  if (found.trace.refused || retrieved.length === 0) {
    return { answer: NO_ANSWER, citations: [], retrievedChunkIds, answered: false, retrieval: found.trace };
  }

  // Answer cache (cache-before-budget): a hit costs zero LLM and never touches the budget.
  const qaKey = `qa/v1/${chatClient.provider}/${chatClient.model}/${deps.commitSha ?? "no-sha"}/${sha256(
    `${question}\n${retrievedChunkIds.join(",")}`,
  )}`;
  const cached = await cache.get<RagAnswer>(qaKey);
  if (cached) return cached;

  const prompt = buildAnswerPrompt(question, retrieved);
  const estimate = estimateTokens(`${SYSTEM_PROMPT}\n${prompt}`);
  if (deps.budget && !(await deps.budget.check(estimate, "chat"))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; Q&A skipped (demo at capacity).");
  }

  // `cachePrefix` marks SYSTEM_PROMPT for the provider's prompt cache — it is the only part
  // stable across questions (the retrieved chunks differ per question by design). An
  // identical question on the same SHA never reaches here at all: the qa cache above serves
  // it for zero tokens, which beats any provider cache discount.
  const completed = await chatClient.complete({
    cachePrefix: SYSTEM_PROMPT,
    prompt,
    temperature: 0,
    maxTokens: deps.maxTokens,
  });
  const answer = { ...deriveAnswer(completed.text, retrieved, retrievedChunkIds), retrieval: found.trace };

  await cache.set(qaKey, answer);
  // Record the provider's REAL usage, not the pre-flight estimate.
  if (deps.budget) await deps.budget.record(completed.usage, "chat");
  return answer;
}

/** Embed the question on the QUERY side, content-addressed cache, cache-before-budget. */
async function embedQuery(deps: AnswerQuestionDeps): Promise<number[]> {
  const { embeddingClient, cache, question } = deps;
  const key = embedCacheKey(embeddingClient.provider, embeddingClient.model, embeddingClient.dimension, "query", question);
  const hit = await cache.get<CachedEmbedding>(key);
  if (hit && Array.isArray(hit.embedding)) return hit.embedding;

  const estimate = estimateTokens(question);
  if (deps.budget && !(await deps.budget.check(estimate, "embedding"))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; Q&A skipped (demo at capacity).");
  }
  const { vectors, usage } = await embeddingClient.embed({ texts: [question], inputType: "query" });
  const [vector] = vectors;
  await cache.set(key, { embedding: vector, model: embeddingClient.model, dim: embeddingClient.dimension });
  if (deps.budget) await deps.budget.record(usage, "embedding");
  return vector;
}

/** Bounded prompt of the RETRIEVED chunks ONLY — never the full index. */
function buildAnswerPrompt(question: string, retrieved: readonly RetrievedChunk[]): string {
  const lines: string[] = ["## Retrieved code chunks"];
  for (const chunk of retrieved) {
    lines.push(`\n### Chunk ${chunk.id}  (file ${chunk.fileId}, lines ${chunk.startLine}-${chunk.endLine})`);
    lines.push(chunk.text);
  }
  lines.push(`\n## Question\n${question}`);
  lines.push("\nAnswer using ONLY the chunks above. Cite the chunk ids you used. Return JSON only.");
  return lines.join("\n");
}

/** Parse the completion, then GROUND citations: keep only those mapping to a retrieved chunk. */
export function deriveAnswer(
  raw: string,
  retrieved: readonly CitableChunk[],
  retrievedChunkIds: string[],
): RagAnswer {
  const byId = new Map(retrieved.map((c) => [c.id, c]));
  let parsed: { answer?: unknown; answered?: unknown; citations?: unknown } | null = null;
  try {
    parsed = JSON.parse(stripCodeFence(raw).trim());
  } catch {
    parsed = null;
  }

  const answerText = parsed && typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  // Honest no-answer: malformed output, explicit answered=false, or empty answer.
  if (!parsed || parsed.answered === false || answerText === "") {
    return { answer: answerText || NO_ANSWER, citations: [], retrievedChunkIds, answered: false };
  }

  const cited = Array.isArray(parsed.citations) ? parsed.citations : [];
  const grounded: RagAnswerCitation[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const entry of cited) {
    const id = entry && typeof entry === "object" ? (entry as { chunkId?: unknown }).chunkId : undefined;
    const chunk = typeof id === "string" ? byId.get(id) : undefined;
    if (!chunk) {
      dropped.push(typeof id === "string" ? id : String(id));
      continue;
    }
    const key = `${chunk.fileId}#${chunk.startLine}-${chunk.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grounded.push({ fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine });
  }

  return {
    answer: answerText,
    citations: grounded,
    retrievedChunkIds,
    answered: true,
    ...(dropped.length ? { droppedCitations: { count: dropped.length, ids: dropped } } : {}),
  };
}



function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
