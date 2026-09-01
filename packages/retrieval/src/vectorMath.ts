// THE one retrieval primitive, shared by the production query path, the in-memory vector
// store, MMR, and the eval harness — so eval's recall@k measures production behaviour rather
// than a parallel implementation of it. (Authored in P18 inside @codeflow/eval, hoisted to
// @codeflow/analyzers, and moved DOWN here in V3-P2 so the store implementations and MMR can
// use it without a dependency cycle. `@codeflow/analyzers` re-exports it, so there is still
// exactly one definition and every existing import path still resolves.)

/**
 * Cosine similarity of two vectors. Returns 0 for a zero-magnitude vector (undefined
 * direction) rather than NaN, so ranking stays total and deterministic.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
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

/** The minimum shape `retrieve` needs: something with an id and a vector. */
export interface Embedded {
  id: string;
  embedding: number[];
}

/**
 * Pure cosine top-k retrieval. Deterministic: ranks by cosine descending, ties broken by `id`
 * ascending. Safe when k is at least the item count (returns all) and when k is 0 or negative
 * (returns none). No I/O, no answer generation.
 *
 * Generic over the item type (V3-P2) rather than fixed to `RagChunk`, because `RagChunk` no
 * longer carries a vector — the vector lives in the store, and the things being ranked are
 * now `IndexedChunk`s in flight or an eval fixture. The ranking logic is identical either way,
 * and a second copy of it would be a second thing to keep in step.
 */
export function retrieve<T extends Embedded>(items: readonly T[], queryVector: readonly number[], k: number): T[] {
  if (k <= 0 || items.length === 0) return [];
  const scored = items.map((item) => ({ item, score: cosineSimilarity(queryVector, item.embedding) }));
  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, k).map((entry) => entry.item);
}
