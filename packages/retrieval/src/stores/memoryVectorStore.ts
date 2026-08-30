import type {
  EmbeddingSpace,
  VectorQuery,
  VectorRecord,
  VectorSearchHit,
  VectorStore,
} from "../contracts.js";
import { assertVectorDimension } from "../homogeneity.js";
import { cosineSimilarity } from "../vectorMath.js";

/**
 * The in-memory `VectorStore` — the HERMETIC DEFAULT (V3-P2).
 *
 * This is not a toy: it is the implementation the entire test suite and the eval harness run
 * against, and it is what makes "no real network call in the suite" achievable while still
 * exercising the real query path. It is an exhaustive cosine scan, which is O(n) per query and
 * therefore wrong for a large repo — that is precisely what the pgvector adapter is for. What
 * it must be is EXACT and DETERMINISTIC, so that a ranking difference between it and pgvector
 * is attributable to the index (ANN recall) and not to a difference in the maths.
 *
 * It is also the honest fallback when Postgres is not configured: a single-container demo
 * still answers questions, at the cost of holding the index in the worker's heap. Which one is
 * running is visible through `store.id`.
 */
export function createMemoryVectorStore(space: EmbeddingSpace): VectorStore {
  // namespace -> (chunk id -> record). A Map per namespace keeps `drop` O(1) and makes an
  // upsert genuinely an upsert (same id overwrites) rather than an append.
  const namespaces = new Map<string, Map<string, VectorRecord>>();

  return {
    id: "memory-vector-store",
    space,

    async upsert(namespace: string, records: readonly VectorRecord[]): Promise<void> {
      let bucket = namespaces.get(namespace);
      if (!bucket) {
        bucket = new Map<string, VectorRecord>();
        namespaces.set(namespace, bucket);
      }
      for (const record of records) {
        assertVectorDimension(record.vector, space, `memory-vector-store upsert of chunk ${record.id}`);
        // Copy the vector: the caller keeps its own array, and a store whose contents can be
        // mutated from outside is not a store.
        bucket.set(record.id, { ...record, vector: [...record.vector] });
      }
    },

    async search(namespace: string, query: VectorQuery): Promise<VectorSearchHit[]> {
      assertVectorDimension(query.vector, space, "memory-vector-store search");
      const bucket = namespaces.get(namespace);
      if (!bucket || query.k <= 0) return [];

      const allowed = query.filter?.fileIds ? new Set(query.filter.fileIds) : null;
      const hits: VectorSearchHit[] = [];
      for (const record of bucket.values()) {
        if (allowed && !allowed.has(record.fileId)) continue;
        hits.push({
          id: record.id,
          score: cosineSimilarity(query.vector, record.vector),
          fileId: record.fileId,
          startLine: record.startLine,
          endLine: record.endLine,
          ...(record.symbolName ? { symbolName: record.symbolName } : {}),
        });
      }
      // Total order: score descending, ties by id ascending.
      hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return hits.slice(0, query.k);
    },

    async count(namespace: string): Promise<number> {
      return namespaces.get(namespace)?.size ?? 0;
    },

    async drop(namespace: string): Promise<void> {
      namespaces.delete(namespace);
    },
  };
}
