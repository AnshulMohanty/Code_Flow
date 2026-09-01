import {
  MMR_LAMBDA,
  RETRIEVAL_ARM_OVERSAMPLE,
  RETRIEVAL_MAX_CANDIDATES,
} from "@codeflow/config";
import type { Rag } from "@codeflow/shared-types";
import { Bm25Index } from "./bm25.js";
import type { ChunkTextStore, Reranker, RetrievedChunk, VectorFilter, VectorStore } from "./contracts.js";
import { mmrSelect, normalizeScores } from "./mmr.js";
import { assertIndexHasStore, indexById } from "./retrieveChunks.js";
import { reciprocalRankFusion, type RankedList } from "./rrf.js";

/**
 * HYBRID SEARCH (V3-P2, task 3) — the full query-side pipeline.
 *
 *   vector arm  ──┐
 *                 ├── RRF fusion ── text fetch ── reranker ── MMR ── top-k
 *   lexical arm ──┘
 *
 * WHY EACH STAGE IS THERE, in one line each:
 *   - VECTOR arm answers "where is authentication handled" and misses `parseJwtHeader`.
 *   - LEXICAL arm (BM25) answers `parseJwtHeader` and misses paraphrases. The two fail in
 *     DIFFERENT directions, which is the only thing that makes fusing them worth the cost.
 *   - RRF fuses RANKS, not scores: a cosine of 0.83 and a BM25 of 11.4 are not comparable
 *     quantities, and normalising them invents a scale that shifts with every result set.
 *   - The RERANKER sees query and document together, which is strictly more informative than
 *     comparing two independently-computed embeddings — and far too slow to run over an index,
 *     hence after fusion on a few dozen candidates.
 *   - MMR trades a little relevance for coverage, because the top-5 for a code question is
 *     otherwise routinely five adjacent chunks of one file.
 *
 * THE REFUSAL FLOOR IS UNCHANGED, and that is the most important invariant here. It is compared
 * against the VECTOR arm's best cosine — a real similarity — never against a fused or reranked
 * score. RRF output is ordinal and reranker scales are model-specific; comparing either to a
 * 0.2 threshold would be meaningless, and the failure mode would be the worst kind: answering
 * confidently on a question the repository cannot answer. The gate is evaluated BEFORE any
 * reranking, so refusal also costs nothing.
 */

export interface HybridSearchDeps {
  /** The index metadata slice (`result.ai.rag`) — the grounding authority for coordinates. */
  ragIndex: Rag;
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
  /** Optional. Omitted ⇒ the fused order is returned as-is (see `createIdentityReranker`). */
  reranker?: Reranker;
}

export interface HybridSearchQuery {
  /** The question text — the lexical arm and the reranker both need it. */
  text: string;
  /** The question embedded on the QUERY side, in the index's space. */
  vector: number[];
  /** Final result count. */
  k: number;
  /** Minimum cosine of the best VECTOR hit required to return anything at all. */
  minSimilarity: number;
  filter?: VectorFilter;
  /** Diversity/relevance trade-off for the MMR pass. Defaults to MMR_LAMBDA. */
  mmrLambda?: number;
  /** Candidates each arm returns before fusion. Defaults to k * RETRIEVAL_ARM_OVERSAMPLE,
   *  capped at RETRIEVAL_MAX_CANDIDATES. */
  armCandidates?: number;
}

/** Per-stage counts and outcomes. Reported, not logged away: "the lexical arm found what the
 *  vector arm missed" is the entire argument for hybrid retrieval, and it has to be visible. */
export interface HybridSearchTrace {
  armCandidates: number;
  vectorHits: number;
  lexicalHits: number;
  /** Candidates after fusion, before the candidate cap. */
  fusedCandidates: number;
  /** Candidates actually handed to the reranker (after the cap and the text fetch). */
  rerankedCandidates: number;
  /** Ids the lexical arm surfaced that the vector arm did not, and vice versa. */
  lexicalOnly: string[];
  vectorOnly: string[];
  rerankerId: string | null;
  /** Set when a reranker was configured but FAILED; the fused order was used instead. */
  rerankerError?: string;
  /** Best VECTOR cosine — the number the floor is compared against. */
  topVectorScore: number;
  /** True when the floor was not met, so nothing was returned. */
  refused: boolean;
  /** Hits dropped because the index metadata had no such id, or the text store had no text. */
  droppedUnknownIds: string[];
  droppedMissingText: string[];
  mmrLambda: number;
}

export interface HybridSearchResult {
  chunks: RetrievedChunk[];
  trace: HybridSearchTrace;
}

export async function hybridSearch(
  deps: HybridSearchDeps,
  query: HybridSearchQuery,
): Promise<HybridSearchResult> {
  const store = assertIndexHasStore(deps.ragIndex);
  const mmrLambda = query.mmrLambda ?? MMR_LAMBDA;
  const armCandidates = Math.max(
    query.k,
    Math.min(query.armCandidates ?? query.k * RETRIEVAL_ARM_OVERSAMPLE, RETRIEVAL_MAX_CANDIDATES),
  );

  const emptyTrace = (): HybridSearchTrace => ({
    armCandidates,
    vectorHits: 0,
    lexicalHits: 0,
    fusedCandidates: 0,
    rerankedCandidates: 0,
    lexicalOnly: [],
    vectorOnly: [],
    rerankerId: deps.reranker?.id ?? null,
    topVectorScore: 0,
    refused: false,
    droppedUnknownIds: [],
    droppedMissingText: [],
    mmrLambda,
  });

  if (query.k <= 0) return { chunks: [], trace: emptyTrace() };

  // --- Arm 1: vector -------------------------------------------------------
  const vectorHits = await deps.vectorStore.search(store.namespace, {
    vector: query.vector,
    k: armCandidates,
    ...(query.filter ? { filter: query.filter } : {}),
  });
  const topVectorScore = vectorHits.length > 0 ? vectorHits[0].score : 0;

  // THE REFUSAL GATE, on the vector arm's real cosine, before any further work. An honest
  // "not in this repository" beats a confident answer built from unrelated code, and checking
  // it here means a refusal costs one vector search and nothing else.
  if (vectorHits.length === 0 || topVectorScore < query.minSimilarity) {
    return {
      chunks: [],
      trace: { ...emptyTrace(), vectorHits: vectorHits.length, topVectorScore, refused: true },
    };
  }

  // --- Arm 2: lexical (BM25 over the candidate corpus) ---------------------
  // The corpus is the chunk TEXT for this namespace. Built from the metadata slice's ids, so
  // the lexical arm can surface a chunk the vector arm ranked nowhere near the top — which is
  // the whole point of having it, and would be impossible if it only re-ranked arm 1's output.
  const byId = indexById(deps.ragIndex.chunks);
  const lexicalIds = candidateIdsForLexicalArm(deps.ragIndex, query.filter);
  const lexicalTexts = await deps.textStore.get(store.namespace, lexicalIds);
  const lexical = Bm25Index.build(
    lexicalIds
      .filter((id) => lexicalTexts.has(id))
      .map((id) => ({ id, text: lexicalTexts.get(id) as string })),
  );
  const lexicalHits = lexical.search(query.text, armCandidates);

  // --- Fusion --------------------------------------------------------------
  const lists: RankedList[] = [
    { source: "vector", ids: vectorHits.map((hit) => hit.id) },
    { source: "lexical", ids: lexicalHits.map((hit) => hit.id) },
  ];
  const fused = reciprocalRankFusion(lists);

  const vectorScoreById = new Map(vectorHits.map((hit) => [hit.id, hit.score]));
  const lexicalScoreById = new Map(lexicalHits.map((hit) => [hit.id, hit.score]));
  const vectorIds = new Set(vectorScoreById.keys());
  const lexicalIdSet = new Set(lexicalScoreById.keys());

  // --- Resolve metadata + text for the capped candidate set ----------------
  const capped = fused.slice(0, RETRIEVAL_MAX_CANDIDATES);
  const droppedUnknownIds: string[] = [];
  const known = capped.filter((entry) => {
    if (byId.has(entry.id)) return true;
    // A store/document disagreement — a stale row from an older chunk plan. The METADATA is the
    // grounding authority; synthesising coordinates from the store instead would let a stale
    // row cite a line range the current plan never produced.
    droppedUnknownIds.push(entry.id);
    return false;
  });

  const texts = await deps.textStore.get(
    store.namespace,
    known.map((entry) => entry.id),
  );
  const droppedMissingText: string[] = [];
  const candidates: RetrievedChunk[] = [];
  for (const entry of known) {
    const text = texts.get(entry.id);
    if (text === undefined) {
      // An empty string here would reach the prompt as a chunk with no content, and the model
      // would cite a file whose code it never read.
      droppedMissingText.push(entry.id);
      continue;
    }
    const metadata = byId.get(entry.id) as NonNullable<ReturnType<typeof byId.get>>;
    const vectorScore = vectorScoreById.get(entry.id);
    const lexicalScore = lexicalScoreById.get(entry.id);
    candidates.push({
      ...metadata,
      text,
      ...(vectorScore !== undefined ? { vectorScore } : {}),
      ...(lexicalScore !== undefined ? { lexicalScore } : {}),
      fusedScore: entry.score,
      sources: entry.sources as Array<"vector" | "lexical">,
    });
  }

  // --- Rerank --------------------------------------------------------------
  let ordered = candidates;
  let rerankerError: string | undefined;
  if (deps.reranker && candidates.length > 1) {
    try {
      const ranked = await deps.reranker.rerank(
        query.text,
        candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
      );
      const scoreById = new Map(ranked.map((entry) => [entry.id, entry.score]));
      const order = new Map(ranked.map((entry, index) => [entry.id, index]));
      ordered = candidates
        .map((candidate) => ({ ...candidate, rerankScore: scoreById.get(candidate.id) }))
        // A candidate the reranker did not mention keeps its fused position at the END rather
        // than being dropped: losing a real result to a reranker's omission is worse than
        // ranking it last.
        .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    } catch (error) {
      // DEGRADE, and say so. The fused order is a perfectly usable answer; silently returning
      // it without recording that the reranker failed is what makes "broken" look like "no
      // opinion". The reranker itself rejects rather than falling back, precisely so this
      // decision lives here, where the trace can carry it.
      rerankerError = error instanceof Error ? error.message : String(error);
      ordered = candidates;
    }
  }

  // --- MMR diversity -------------------------------------------------------
  // Relevance comes from the CURRENT order (reranked when a reranker ran, fused otherwise),
  // min-max normalised over this candidate set — legitimate here, unlike in fusion, because MMR
  // compares candidates against each other within one query.
  //
  // Redundancy uses fileId as the group key rather than cosine between candidate vectors: the
  // vectors are in the store, not in hand, and fetching them back for ~40 candidates to compute
  // a pairwise matrix would be a second round trip for a correction that fileId already makes
  // in the right direction. Documented as the coarser mode it is (see `mmrSelect`).
  const relevance = normalizeScores(ordered.map((_, index) => ordered.length - index));
  const selected = mmrSelect(
    ordered.map((candidate, index) => ({
      id: candidate.id,
      relevance: relevance[index],
      groupKey: candidate.fileId,
    })),
    query.k,
    mmrLambda,
  );
  const orderedById = new Map(ordered.map((candidate) => [candidate.id, candidate]));
  const chunks = selected
    .map((entry) => orderedById.get(entry.id))
    .filter((candidate): candidate is RetrievedChunk => candidate !== undefined);

  return {
    chunks,
    trace: {
      armCandidates,
      vectorHits: vectorHits.length,
      lexicalHits: lexicalHits.length,
      fusedCandidates: fused.length,
      rerankedCandidates: candidates.length,
      lexicalOnly: [...lexicalIdSet].filter((id) => !vectorIds.has(id)).sort(),
      vectorOnly: [...vectorIds].filter((id) => !lexicalIdSet.has(id)).sort(),
      rerankerId: deps.reranker?.id ?? null,
      ...(rerankerError ? { rerankerError } : {}),
      topVectorScore,
      refused: false,
      droppedUnknownIds,
      droppedMissingText,
      mmrLambda,
    },
  };
}

/**
 * Which chunk ids the lexical arm indexes.
 *
 * Every chunk in the namespace, minus anything the filter excludes. Stated plainly because it is
 * the one place hybrid search does work proportional to the INDEX rather than to k: it fetches
 * the text for the whole namespace to build the BM25 index per query.
 *
 * That is a deliberate trade for now — the alternative is a persisted inverted index, which is a
 * second structure to keep in step with the vector index, and the texts are already in Postgres.
 * It is bounded in practice by the filter (Phase 3's graph tools scope by file) and flagged for
 * P5 if a real corpus shows the per-query build cost matters. Bounding it by silently sampling
 * the corpus would be worse than the cost: the lexical arm's value is finding the rare
 * identifier, and a sampled corpus is exactly where a rare thing goes missing.
 */
function candidateIdsForLexicalArm(ragIndex: Rag, filter?: VectorFilter): string[] {
  if (!filter?.fileIds) return ragIndex.chunks.map((chunk) => chunk.id);
  // An explicitly EMPTY filter means nothing is allowed — not "no filter".
  const allowed = new Set(filter.fileIds);
  return ragIndex.chunks.filter((chunk) => allowed.has(chunk.fileId)).map((chunk) => chunk.id);
}
