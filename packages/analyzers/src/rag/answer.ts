import { createHash } from "node:crypto";
import { RAG_MIN_SIMILARITY, RAG_TOP_K } from "@codeflow/config";
import type { AnalysisCacheHandle, BudgetHandle, Rag, RagChunk } from "@codeflow/shared-types";
import type { LlmClient } from "../llm/llmClient.js";
import type { EmbeddingClient } from "../embedding/embeddingClient.js";
import { BudgetExceededError } from "../pipeline/errors.js";
import { embedCacheKey, type CachedEmbedding } from "./embedCache.js";
import { assertEmbeddingSpace } from "./homogeneity.js";
import { cosineSimilarity, retrieve } from "./retrieve.js";

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
}

export interface AnswerQuestionDeps {
  question: string;
  /** The already-built index (`result.ai.rag`) — its chunks carry embeddings. */
  ragIndex: Rag;
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

  const queryVector = await embedQuery(deps);

  const retrieved = retrieve(ragIndex.chunks, queryVector, k);
  const retrievedChunkIds = retrieved.map((c) => c.id);
  const topScore = retrieved.length ? cosineSimilarity(queryVector, retrieved[0].embedding) : 0;

  // Honest no-answer: empty or below the floor ⇒ refuse, do NOT call the answer LLM.
  if (retrieved.length === 0 || topScore < minSimilarity) {
    return { answer: NO_ANSWER, citations: [], retrievedChunkIds, answered: false };
  }

  // Answer cache (cache-before-budget): a hit costs zero LLM and never touches the budget.
  const qaKey = `qa/v1/${chatClient.provider}/${chatClient.model}/${deps.commitSha ?? "no-sha"}/${sha256(
    `${question}\n${retrievedChunkIds.join(",")}`,
  )}`;
  const cached = await cache.get<RagAnswer>(qaKey);
  if (cached) return cached;

  const prompt = buildAnswerPrompt(question, retrieved);
  const estimate = estimateTokens(`${SYSTEM_PROMPT}\n${prompt}`);
  if (deps.budget && !(await deps.budget.check(estimate))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; Q&A skipped (demo at capacity).");
  }

  const completion = await chatClient.complete({ system: SYSTEM_PROMPT, prompt, temperature: 0, maxTokens: deps.maxTokens });
  const answer = deriveAnswer(completion, retrieved, retrievedChunkIds);

  await cache.set(qaKey, answer);
  if (deps.budget) await deps.budget.record(estimate);
  return answer;
}

/** Embed the question on the QUERY side, content-addressed cache, cache-before-budget. */
async function embedQuery(deps: AnswerQuestionDeps): Promise<number[]> {
  const { embeddingClient, cache, question } = deps;
  const key = embedCacheKey(embeddingClient.provider, embeddingClient.model, embeddingClient.dimension, "query", question);
  const hit = await cache.get<CachedEmbedding>(key);
  if (hit && Array.isArray(hit.embedding)) return hit.embedding;

  const estimate = estimateTokens(question);
  if (deps.budget && !(await deps.budget.check(estimate))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; Q&A skipped (demo at capacity).");
  }
  const [vector] = await embeddingClient.embed({ texts: [question], inputType: "query" });
  await cache.set(key, { embedding: vector, model: embeddingClient.model, dim: embeddingClient.dimension });
  if (deps.budget) await deps.budget.record(estimate);
  return vector;
}

/** Bounded prompt of the RETRIEVED chunks ONLY — never the full index. */
function buildAnswerPrompt(question: string, retrieved: RagChunk[]): string {
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
export function deriveAnswer(raw: string, retrieved: RagChunk[], retrievedChunkIds: string[]): RagAnswer {
  const byId = new Map(retrieved.map((c) => [c.id, c]));
  let parsed: { answer?: unknown; answered?: unknown; citations?: unknown } | null = null;
  try {
    parsed = JSON.parse(stripCodeFences(raw).trim());
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

function stripCodeFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fence ? fence[1] : text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
