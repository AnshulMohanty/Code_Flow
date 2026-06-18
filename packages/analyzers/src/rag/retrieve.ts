import type { RagChunk } from "@codeflow/shared-types";

// THE one retrieval primitive — shared by the production query path (answerQuestion) and the
// eval harness, so eval's recall@k actually measures production behaviour. (Hoisted out of
// @codeflow/eval in P18; eval now imports it from here.)

/**
 * Cosine similarity of two vectors. Returns 0 for a zero-magnitude vector (undefined
 * direction) rather than NaN, so ranking stays total + deterministic.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pure cosine top-k retrieval over a chunk index. Deterministic: ranks by cosine descending,
 * ties broken by chunk `id` ascending. Safe when k ≥ chunkCount (returns all) and k ≤ 0
 * (returns none). No I/O, no answer generation.
 */
export function retrieve(chunks: RagChunk[], queryVector: number[], k: number): RagChunk[] {
  if (k <= 0 || chunks.length === 0) return [];
  const scored = chunks.map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.embedding) }));
  scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return scored.slice(0, k).map((entry) => entry.chunk);
}
