import type { Rag, RagChunk } from "@codeflow/shared-types";
import type { ChunkTextStore, RetrievedChunk, VectorFilter, VectorStore } from "./contracts.js";

/**
 * The vector arm of retrieval, joined back to metadata and text (V3-P2).
 *
 * This is the piece that replaces the old brute-force cosine scan over `rag.chunks[].embedding`.
 * The shape of the work is now: ask the store for ranked ids, join those ids to the metadata
 * the analysis document still holds, fetch the text for exactly those ids, and hand back
 * `RetrievedChunk`s.
 *
 * THREE THINGS IT REFUSES TO PAPER OVER, because each one would otherwise surface as a
 * confidently wrong answer rather than as an error:
 *   1. An index with no `store` reference is PRE-P2 (its vectors were inline and are gone).
 *      That is not an empty result, it is an unusable index, and it says so.
 *   2. A hit whose id is not in the index metadata is a store/document disagreement. Dropped
 *      and counted, never fabricated from the hit's own coordinates — the metadata is the
 *      grounding authority, and trusting the store instead would let a stale row cite a line
 *      range the current plan never produced.
 *   3. A hit with no text in the text store is dropped and counted. An empty string would
 *      enter a prompt as a chunk with no content, and the model would cite a file whose code
 *      it never actually read.
 */
export interface VectorRetrieveDeps {
  /** The index metadata slice (`result.ai.rag`) — the grounding authority for coordinates. */
  ragIndex: Rag;
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
}

export interface VectorRetrieveQuery {
  queryVector: number[];
  k: number;
  filter?: VectorFilter;
}

export interface VectorRetrieveResult {
  chunks: RetrievedChunk[];
  /** Cosine similarity of the BEST hit, or 0 when nothing came back. This is the number the
   *  similarity floor is compared against — a real cosine, never a fused or reranked score. */
  topScore: number;
  /** Hits discarded because the index metadata had no such chunk id. */
  droppedUnknownIds: string[];
  /** Hits discarded because the text store had no text for the id. */
  droppedMissingText: string[];
}

export function assertIndexHasStore(ragIndex: Rag): NonNullable<Rag["store"]> {
  if (!ragIndex.store) {
    throw new Error(
      "This Q&A index predates the V3-P2 store split: its vectors were stored inline in the " +
        "analysis document and are no longer present. Re-analyse the repository to rebuild it.",
    );
  }
  return ragIndex.store;
}

export async function vectorRetrieve(
  deps: VectorRetrieveDeps,
  query: VectorRetrieveQuery,
): Promise<VectorRetrieveResult> {
  const store = assertIndexHasStore(deps.ragIndex);
  if (query.k <= 0) {
    return { chunks: [], topScore: 0, droppedUnknownIds: [], droppedMissingText: [] };
  }

  const hits = await deps.vectorStore.search(store.namespace, {
    vector: query.queryVector,
    k: query.k,
    ...(query.filter ? { filter: query.filter } : {}),
  });
  if (hits.length === 0) {
    return { chunks: [], topScore: 0, droppedUnknownIds: [], droppedMissingText: [] };
  }

  const byId = indexById(deps.ragIndex.chunks);
  const droppedUnknownIds: string[] = [];
  const known: Array<{ metadata: RagChunk; score: number }> = [];
  for (const hit of hits) {
    const metadata = byId.get(hit.id);
    if (!metadata) {
      droppedUnknownIds.push(hit.id);
      continue;
    }
    known.push({ metadata, score: hit.score });
  }

  const texts = await deps.textStore.get(
    store.namespace,
    known.map((entry) => entry.metadata.id),
  );

  const droppedMissingText: string[] = [];
  const chunks: RetrievedChunk[] = [];
  for (const entry of known) {
    const text = texts.get(entry.metadata.id);
    if (text === undefined) {
      droppedMissingText.push(entry.metadata.id);
      continue;
    }
    chunks.push({
      ...entry.metadata,
      text,
      vectorScore: entry.score,
      // Vector-only retrieval: the fused score IS the vector score, so the field is populated
      // rather than left absent and the shape stays identical to the hybrid path's output.
      fusedScore: entry.score,
      sources: ["vector"],
    });
  }

  // topScore is read from the store's ranking, BEFORE the drops above — the best available
  // match is a property of the index, not of whether we could resolve its text.
  return { chunks, topScore: hits[0].score, droppedUnknownIds, droppedMissingText };
}

export function indexById(chunks: readonly RagChunk[]): Map<string, RagChunk> {
  const map = new Map<string, RagChunk>();
  for (const chunk of chunks) map.set(chunk.id, chunk);
  return map;
}
