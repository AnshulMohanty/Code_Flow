import { MMR_LAMBDA } from "@codeflow/config";
import { cosineSimilarity } from "./vectorMath.js";

/**
 * Maximal Marginal Relevance (V3-P2) — the diversity pass, and the last stage before the
 * chunks reach a prompt.
 *
 * THE PROBLEM IT SOLVES. Relevance ranking alone is systematically redundant on code: the
 * top-5 for "how does auth work" is frequently five adjacent chunks of the same file, because
 * they genuinely are the five most similar things to the query. The prompt then contains one
 * fact five times and the answer cannot mention the other file that mattered. MMR trades a
 * little relevance for coverage, selecting greedily by
 *
 *     lambda * relevance(candidate)  -  (1 - lambda) * max similarity(candidate, already chosen)
 *
 * so the second pick is penalised for looking like the first.
 *
 * lambda = MMR_LAMBDA (0.7): relevance-leaning. A low lambda diversifies so aggressively that
 * it starts returning weakly-relevant chunks from unrelated files, which reads as retrieval
 * getting worse. Flagged for tuning against the real scored eval.
 *
 * Pure, deterministic, no I/O. Ties broken by id, so equal-scoring candidates always resolve
 * the same way.
 */

export interface MmrCandidate {
  id: string;
  /** Relevance, already normalised to a comparable scale by the caller (see `mmrSelect`). */
  relevance: number;
  /** The candidate's vector, for the redundancy term. */
  vector?: readonly number[];
  /** Fallback redundancy key when no vector is available (see `mmrSelect`). */
  groupKey?: string;
}

/**
 * Select up to `k` candidates by MMR.
 *
 * TWO REDUNDANCY MODES, because the query path does not always have vectors to hand. When a
 * candidate carries a `vector`, redundancy is cosine similarity to the already-selected set —
 * the real thing. When it does not, redundancy falls back to `groupKey` equality (the query
 * path passes the fileId): a candidate from a file already represented is treated as fully
 * redundant, otherwise not at all. That is coarser, but it is the same *direction* of
 * correction and it needs no extra round trip to the vector store. Which mode ran is
 * observable — a caller that wants the exact version supplies vectors.
 *
 * `relevance` must already be on a comparable scale across candidates, because it is
 * subtracted against a cosine in [-1, 1]. The caller normalises; doing it here would mean
 * guessing what the incoming scale was.
 */
export function mmrSelect(candidates: readonly MmrCandidate[], k: number, lambda: number = MMR_LAMBDA): MmrCandidate[] {
  if (k <= 0 || candidates.length === 0) return [];
  if (candidates.length <= k && lambda >= 1) return [...candidates];

  const remaining = [...candidates];
  const selected: MmrCandidate[] = [];

  while (selected.length < k && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const redundancy = selected.length === 0 ? 0 : maxRedundancy(candidate, selected);
      const score = lambda * candidate.relevance - (1 - lambda) * redundancy;
      // Strict `>` plus an id tie-break keeps the selection total and order-independent.
      if (score > bestScore || (score === bestScore && candidate.id.localeCompare(remaining[bestIndex].id) < 0)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}

function maxRedundancy(candidate: MmrCandidate, selected: readonly MmrCandidate[]): number {
  let max = 0;
  for (const chosen of selected) {
    let similarity: number;
    if (candidate.vector && chosen.vector) {
      similarity = cosineSimilarity(candidate.vector, chosen.vector);
    } else if (candidate.groupKey !== undefined && chosen.groupKey !== undefined) {
      similarity = candidate.groupKey === chosen.groupKey ? 1 : 0;
    } else {
      // Nothing to compare on — treat as non-redundant rather than inventing a similarity.
      similarity = 0;
    }
    if (similarity > max) max = similarity;
  }
  return max;
}

/**
 * Normalise a set of scores into [0, 1] for use as MMR relevance.
 *
 * Min-max over the CANDIDATE SET only — which is legitimate here and would not be for fusion
 * (see rrf.ts): MMR compares candidates against each other within one query, so a per-query
 * scale is exactly the right scale. An all-equal set maps to 1 rather than to 0/0, so a
 * degenerate case does not silently zero out the relevance term and leave pure diversity.
 */
export function normalizeScores(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const score of scores) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  const range = max - min;
  if (range === 0) return scores.map(() => 1);
  return scores.map((score) => (score - min) / range);
}
