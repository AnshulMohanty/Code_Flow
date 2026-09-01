import { RRF_K } from "@codeflow/config";

/**
 * Reciprocal Rank Fusion (V3-P2) — how the vector arm and the lexical arm are combined.
 *
 * WHY RRF AND NOT A WEIGHTED SCORE SUM. A cosine similarity of 0.83 and a BM25 score of 11.4
 * are not comparable quantities: BM25 is unbounded and corpus-dependent, cosine is bounded and
 * is not calibrated across queries. Normalising them (min-max over the returned window, say)
 * invents a scale that changes with every result set, so the same document can fuse
 * differently depending on what else came back. RRF throws the magnitudes away and fuses
 * RANKS, which is the only thing the two arms genuinely agree on the meaning of.
 *
 * The cost of that choice, stated plainly: the fused score is ORDINAL. It is not a similarity
 * and must never be compared against the similarity floor. That is why the refusal gate in
 * `hybridSearch` reads the vector arm's cosine, not this number.
 *
 * Pure and deterministic: same rankings in, same fusion out, ties broken by id.
 */

/** One arm's ranking. Order IS the rank — index 0 is rank 1. */
export interface RankedList {
  /** Names the arm, so the fused result can report which arms found a document. */
  source: string;
  ids: readonly string[];
  /** Optional relative weight (default 1). Present for the P5 tuning knob; unused today. */
  weight?: number;
}

export interface FusedResult {
  id: string;
  score: number;
  /** Which arms contained it, in the order the arms were passed. */
  sources: string[];
  /** 1-based rank within each arm that had it, keyed by arm name. Reported because "rank 1 in
   *  lexical, absent from vector" is the diagnosis for a whole class of retrieval misses. */
  ranks: Record<string, number>;
}

/**
 * Fuse ranked lists. A document's score is the sum over the arms that contain it of
 * `weight / (RRF_K + rank)`.
 *
 * `RRF_K` (60, the value from the original TREC paper) controls how sharply rank matters: a
 * larger k flattens the curve so being rank 1 versus rank 5 matters less, which in practice
 * means trusting the AGREEMENT between arms more than either arm's own confidence. That is
 * the behaviour we want here, because neither arm is reliable alone.
 */
export function reciprocalRankFusion(lists: readonly RankedList[], options: { k?: number } = {}): FusedResult[] {
  const k = options.k ?? RRF_K;
  const accumulated = new Map<string, { score: number; sources: string[]; ranks: Record<string, number> }>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    for (let index = 0; index < list.ids.length; index++) {
      const id = list.ids[index];
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const entry = accumulated.get(id);
      if (entry) {
        entry.score += contribution;
        entry.sources.push(list.source);
        entry.ranks[list.source] = rank;
      } else {
        accumulated.set(id, { score: contribution, sources: [list.source], ranks: { [list.source]: rank } });
      }
    }
  }

  const fused: FusedResult[] = [];
  for (const [id, entry] of accumulated) {
    fused.push({ id, score: entry.score, sources: entry.sources, ranks: entry.ranks });
  }
  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused;
}
