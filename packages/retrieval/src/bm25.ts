import { BM25_B, BM25_K1 } from "@codeflow/config";
import { tokenizeCode } from "./tokenize.js";

/**
 * BM25 lexical retrieval (V3-P2) — the other half of hybrid search.
 *
 * WHY A LEXICAL ARM AT ALL, given a vector index. Embeddings are good at "where is
 * authentication handled" and bad at `parseJwtHeader` — a rare identifier is exactly the
 * signal a dense vector averages away, and it is exactly what a developer types. BM25 scores
 * a rare token highly (that is what the IDF term is), so the two arms fail in different
 * directions, which is the only reason fusing them helps.
 *
 * DETERMINISTIC AND HERMETIC BY CONSTRUCTION. No model, no I/O, no clock — an index built
 * from the same chunks always produces the same scores in the same order, so this is unit
 * tested directly rather than mocked. Ties are broken by document id, so the ranking is total.
 *
 * The index is built PER QUERY PATH from the chunk texts already fetched for the namespace,
 * not persisted. That is a deliberate trade: a persisted inverted index would be faster on a
 * huge repo, but it would be a second thing to keep in step with the vector index, and the
 * texts are already in Postgres. Flagged for P5 if a real corpus shows the build cost matters.
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

interface Posting {
  /** Document index into `docIds`. */
  doc: number;
  /** Raw term frequency in that document. */
  tf: number;
}

/**
 * A built BM25 index. Immutable once constructed — `search` does no mutation, so the same
 * index can serve concurrent queries and repeated queries return identical results.
 */
export class Bm25Index {
  private readonly docIds: string[];
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  private readonly postings: Map<string, Posting[]>;

  private constructor(docIds: string[], docLengths: number[], postings: Map<string, Posting[]>) {
    this.docIds = docIds;
    this.docLengths = docLengths;
    this.postings = postings;
    const total = docLengths.reduce((sum, len) => sum + len, 0);
    // An empty corpus would make avgdl 0 and the length-normalisation term NaN.
    this.avgDocLength = docLengths.length === 0 ? 1 : total / docLengths.length || 1;
  }

  get size(): number {
    return this.docIds.length;
  }

  /** Vocabulary size — reported so a caller can tell an index that saw nothing from one that
   *  simply scored nothing. */
  get vocabularySize(): number {
    return this.postings.size;
  }

  /**
   * Build the index. Documents are indexed in the order given, but scoring never depends on
   * that order (ties break on id), so a caller does not have to sort first.
   */
  static build(documents: readonly Bm25Document[]): Bm25Index {
    const docIds: string[] = [];
    const docLengths: number[] = [];
    const postings = new Map<string, Posting[]>();

    for (const document of documents) {
      const doc = docIds.length;
      docIds.push(document.id);
      const tokens = tokenizeCode(document.text);
      docLengths.push(tokens.length);

      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [token, tf] of counts) {
        const bucket = postings.get(token);
        if (bucket) bucket.push({ doc, tf });
        else postings.set(token, [{ doc, tf }]);
      }
    }

    return new Bm25Index(docIds, docLengths, postings);
  }

  /**
   * Score the query against every document that shares at least one term, and return the top
   * `k` by score descending, ties broken by document id ascending.
   *
   * The scoring function is textbook Okapi BM25 with the standard probabilistic IDF, floored
   * at zero. The floor matters: raw probabilistic IDF goes NEGATIVE for a term appearing in
   * more than half the corpus, which would mean a document containing a common word scores
   * WORSE than one that does not contain it at all — nonsense that shows up as a good match
   * being pushed below an unrelated chunk.
   */
  search(query: string, k: number): Bm25Hit[] {
    if (k <= 0 || this.docIds.length === 0) return [];
    const queryTokens = tokenizeCode(query);
    if (queryTokens.length === 0) return [];

    const scores = new Map<number, number>();
    // A repeated query term should not multiply its own contribution, so unique terms only.
    for (const token of new Set(queryTokens)) {
      const bucket = this.postings.get(token);
      if (!bucket) continue;
      const df = bucket.length;
      const idf = Math.max(0, Math.log(1 + (this.docIds.length - df + 0.5) / (df + 0.5)));
      if (idf === 0) continue;
      for (const posting of bucket) {
        const norm = 1 - BM25_B + BM25_B * (this.docLengths[posting.doc] / this.avgDocLength);
        const tfPart = (posting.tf * (BM25_K1 + 1)) / (posting.tf + BM25_K1 * norm);
        scores.set(posting.doc, (scores.get(posting.doc) ?? 0) + idf * tfPart);
      }
    }

    const hits: Bm25Hit[] = [];
    for (const [doc, score] of scores) {
      if (score > 0) hits.push({ id: this.docIds[doc], score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, k);
  }
}
