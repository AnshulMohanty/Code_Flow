import type { RerankCandidate, RerankResult, Reranker } from "./contracts.js";
import { tokenizeCode } from "./tokenize.js";

/**
 * Rerankers (V3-P2, task 3).
 *
 * THE DEPENDENCY PROBE, and why no model ships here. The brief asked for a keyless, in-process,
 * CPU cross-encoder that runs in the pruned `node:20-slim` image with no native toolchain —
 * probed with the same discipline V3-P1 used before adopting `web-tree-sitter`. Every candidate
 * was installed and inspected, and every one was rejected:
 *
 *   - `onnxruntime-node@1.24.3` — installed: **211 MB**, shipping prebuilt NAPI `.node` plus
 *     `.so`/`.dll`/`.dylib` for six platforms, AND a `postinstall` (`node ./script/install`,
 *     with `adm-zip` + `global-agent` as dependencies) that downloads further binaries from a
 *     Nuget feed. No node-gyp compile, so it clears that bar — but a 211 MB, network-at-install,
 *     platform-specific artefact for a reranker is not a trade worth making in an image that
 *     currently ships nothing native at all.
 *   - `@huggingface/transformers@4.2.0` — depends on the above, and additionally on `sharp`
 *     (native image processing, irrelevant to text reranking).
 *   - `fastembed@2.1.0` — depends on `@anush008/tokenizers`, a native Rust NAPI binding.
 *   - `onnxruntime-web@1.29.0` — the one WASM-clean runtime (no install script, no native
 *     binaries), and the exact shape of the `web-tree-sitter` answer. It is the right runtime.
 *     What it cannot supply is a TOKENIZER: a cross-encoder needs WordPiece/BPE, and the
 *     available JS tokenizers are themselves NAPI packages. Writing one is a real task, not a
 *     line of glue, so it belongs to P5 with a named path rather than to a rushed P2.
 *
 * WHAT SHIPS INSTEAD. `createLexicalOverlapReranker` — genuinely in-process, keyless,
 * zero-dependency and deterministic. It is NOT a cross-encoder and does not pretend to be:
 * `kind: "deterministic"` says so in the data, so a report can distinguish a real rerank from
 * this one. What it does is a real improvement over the fused order for the case that matters
 * most in code search — a candidate that literally contains the query's identifiers should
 * outrank one that merely sits near it in vector space.
 *
 * AND THE REAL ONE IS READY TO DROP IN. `createCrossEncoderReranker` takes an injected
 * `CrossEncoderSession`, so the model integration is a matter of supplying a session, the
 * hermetic suite tests the adapter with a fake, and nothing in this package depends on a
 * runtime. Downloading weights and running a live model is in the deferred bucket.
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
