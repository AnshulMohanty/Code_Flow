import type { RerankCandidate, RerankResult, Reranker } from "./contracts.js";
import { tokenizeCode } from "./tokenize.js";

/**
 * Rerankers. No model ships: every in-process cross-encoder runtime probed was native or huge
 * (onnxruntime-node 211 MB with a downloading postinstall; @huggingface/transformers adds sharp;
 * fastembed needs a native tokenizer), and onnxruntime-web — the right, WASM-clean runtime — still
 * needs a WordPiece/BPE tokenizer that only exists natively in JS today.
 *
 * `createLexicalOverlapReranker` is what runs: keyless, deterministic, and labelled `kind:
 * "deterministic"` so a report never mistakes it for a cross-encoder. It lifts candidates that contain
 * the query's identifiers above ones that are merely near in vector space. `createCrossEncoderReranker`
 * takes an injected `CrossEncoderSession`, so a real model drops in without touching this package.
 */

/** The deterministic reranker's id — pinned so a report or a trace can name it. */
export const LEXICAL_RERANKER_ID = "lexical-overlap";

/**
 * The DETERMINISTIC default reranker: symmetric token overlap between query and candidate.
 *
 * Score = |query ∩ candidate| / |query ∪ candidate| over the shared code tokenizer's unique
 * tokens (Jaccard). Two properties earn it the default slot:
 *
 *   1. It rewards a candidate that literally contains the identifiers the developer typed. A
 *      dense vector averages a rare identifier away; this does the opposite, which is the same
 *      asymmetry that makes the BM25 arm worth having.
 *   2. Symmetric normalisation (union, not just query length) stops a very long chunk from
 *      winning by sheer vocabulary size — the same failure BM25's length normalisation exists
 *      to prevent.
 *
 * Deterministic and total: ties break on candidate id, so the same input always yields the same
 * order. No I/O, no model, no clock.
 */
export function createLexicalOverlapReranker(): Reranker {
  return {
    id: LEXICAL_RERANKER_ID,
    kind: "deterministic",
    async rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]> {
      const queryTokens = new Set(tokenizeCode(query));
      const results: RerankResult[] = candidates.map((candidate) => ({
        id: candidate.id,
        score: queryTokens.size === 0 ? 0 : jaccard(queryTokens, new Set(tokenizeCode(candidate.text))),
      }));
      results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return results;
    },
  };
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set — the result is symmetric, so this is free.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * A no-op reranker: preserves the incoming order exactly, scoring by descending rank.
 *
 * Useful as an explicit "reranking is off" value rather than an `undefined` the pipeline has to
 * branch on, and as the control arm when measuring whether a reranker helps at all.
 */
export function createIdentityReranker(): Reranker {
  return {
    id: "identity",
    kind: "deterministic",
    async rerank(_query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]> {
      return candidates.map((candidate, index) => ({ id: candidate.id, score: candidates.length - index }));
    },
  };
}

// -- The real cross-encoder, behind an injected session ------------------------------

/**
 * A loaded cross-encoder, as far as the reranker cares: score (query, document) pairs and
 * return one relevance logit per pair, in order.
 *
 * The whole model — runtime, tokenizer, weights, batching — lives behind this one method. That
 * is what lets the adapter below be written and tested now, with no dependency and no download,
 * and swapped to a real ONNX session later without touching anything that calls it.
 */
export interface CrossEncoderSession {
  /** A stable identifier, e.g. "bge-reranker-base". Reported so a trace names the model. */
  readonly model: string;
  /** One score per pair, same order as `pairs`. Higher is more relevant. */
  score(pairs: ReadonlyArray<{ query: string; document: string }>): Promise<number[]>;
}

export interface CrossEncoderRerankerOptions {
  session: CrossEncoderSession;
  /**
   * Max characters of a candidate handed to the model. Cross-encoders have a short context
   * (512 tokens is typical), and silently letting a long chunk be truncated by the tokenizer
   * means the model scores a prefix while the caller believes it scored the chunk. Truncating
   * here, explicitly and deterministically, at least makes it the same prefix every time.
   */
  maxCandidateChars?: number;
  /** Pairs per model call. Bounded because a cross-encoder is O(n) in real compute. */
  batchSize?: number;
}

const DEFAULT_MAX_CANDIDATE_CHARS = 2_000;
const DEFAULT_BATCH_SIZE = 16;

/**
 * The real reranker: one model call per (query, candidate) pair, batched.
 *
 * INTEGRATION-ONLY today — nothing in this repo constructs a `CrossEncoderSession`. Reported as
 * `kind: "cross-encoder"` so a caller can tell it apart from the deterministic default, and so
 * a quality number measured with a real model is never confused with one measured without.
 *
 * A model failure REJECTS rather than falling back to the fused order. That is deliberate: a
 * silent fallback would make "the reranker is broken" indistinguishable from "the reranker had
 * no opinion", and the caller (`hybridSearch`) is the right place to decide whether to degrade.
 */
export function createCrossEncoderReranker(options: CrossEncoderRerankerOptions): Reranker {
  const maxChars = options.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  return {
    id: `cross-encoder:${options.session.model}`,
    kind: "cross-encoder",
    async rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]> {
      if (candidates.length === 0) return [];
      const scores: number[] = [];
      for (let offset = 0; offset < candidates.length; offset += batchSize) {
        const batch = candidates.slice(offset, offset + batchSize);
        const batchScores = await options.session.score(
          batch.map((candidate) => ({ query, document: candidate.text.slice(0, maxChars) })),
        );
        if (batchScores.length !== batch.length) {
          throw new Error(
            `Cross-encoder ${options.session.model} returned ${batchScores.length} scores for ${batch.length} pairs. ` +
              "A misaligned score array would silently attach each score to the wrong candidate.",
          );
        }
        scores.push(...batchScores);
      }
      const results = candidates.map((candidate, index) => ({ id: candidate.id, score: scores[index] }));
      results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return results;
    },
  };
}
