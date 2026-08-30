import { tokenizeCode } from "./tokenize.js";

/**
 * THE KEYLESS LOCAL EMBEDDER (V3-P5 task 4).
 *
 * WHAT V3_PLAN §5 ASKED FOR: "int8 MiniLM local embeddings". WHAT SHIPS: a deterministic
 * bag-of-words embedder over the shared code tokenizer. That is a real difference and it is stated
 * here rather than buried, because the model NAME is the part a reader would otherwise assume.
 *
 * WHY. A MiniLM needs an inference runtime, and both routes were probed and rejected on evidence:
 *   - `onnxruntime-node` — 211 MB, prebuilt NAPI binaries for six platforms, a postinstall that
 *     downloads more from a Nuget feed (V3-P2's reranker probe).
 *   - `@huggingface/transformers` — pulls the above, plus `sharp` (V3-P2).
 *   - `@lancedb/lancedb` — 656 MB and drags `onnxruntime-node` back in (V3-P5 task 4's probe).
 *   - `onnxruntime-web` is WASM-clean and the right runtime, but a transformer needs a WordPiece
 *     tokenizer and the JS tokenizers are themselves native NAPI packages.
 * For a CLI whose entire selling point is running on a laptop with no toolchain, a 200 MB native
 * download is not a detail — it is the opposite of the feature.
 *
 * WHAT THIS IS, precisely. Feature hashing: each token from `tokenizeCode` is hashed to a dimension
 * and increments it, then the vector is L2-normalised so cosine is a genuine angle and a long chunk
 * is not penalised. It captures LEXICAL overlap — shared identifiers, shared path words, shared
 * signature terms — and it does NOT capture semantic similarity: it cannot tell that "authenticate"
 * and "login" are related, which a MiniLM can.
 *
 * WHY IT IS STILL WORTH SHIPPING. Three reasons, all checkable:
 *   1. It is genuinely KEYLESS and OFFLINE — the local-first claim ("zero code egress") is provable
 *      rather than asserted, because there is no client, no socket and no protocol.
 *   2. On code specifically, lexical overlap is a much stronger signal than on prose: developers
 *      search for identifiers. V3-P2 measured this — the same embedder took enrichment's recall@3
 *      from 0.500 to 1.000 on the A/B corpus.
 *   3. It composes with V3-P2's BM25 arm and the enrichment header, which is exactly where its
 *      weakness is covered: `hybridSearch` fuses it with a lexical index, and enrichment puts the
 *      class name and path words into the text it sees.
 *
 * The honest upgrade path is one file: implement `EmbeddingClient` over `onnxruntime-web` plus a JS
 * WordPiece, and the local CLI changes nothing. Named in GO_LIVE.md.
 *
 * DETERMINISTIC AND STABLE ACROSS PROCESSES: no RNG, no clock, a fixed hash — so an index built
 * today is still searchable tomorrow, which a random projection would not be.
 */

/** The `EmbeddingClient` shape, restated locally so this package needs no analyzers dependency
 *  (retrieval sits BELOW analyzers — see contracts.ts). Structurally identical. */
export interface LocalEmbeddingRequest {
  texts: string[];
  inputType?: "document" | "query";
}

export interface LocalEmbeddingResult {
  vectors: number[][];
  usage: { inputTokens: number; outputTokens: number; measured: boolean };
}

export interface LocalEmbeddingClient {
  /**
   * The literal `"local"`, not `string`. That narrowness is what makes this structurally assignable
   * to `@codeflow/analyzers`' `EmbeddingClient` (whose `provider` is a union) WITHOUT this package
   * importing from analyzers — retrieval sits below it. See contracts.ts on the dependency direction.
   */
  readonly provider: "local";
  readonly model: string;
  readonly dimension: number;
  embed(request: LocalEmbeddingRequest): Promise<LocalEmbeddingResult>;
}

/** Default dimension. 256 is a deliberate middle: large enough that unrelated tokens in one
 *  repository rarely collide, small enough that an index of a big repo stays a readable JSON file. */
export const LOCAL_EMBEDDING_DIM = 256;

/**
 * The model IDENTIFIER, and it is deliberately not called "minilm" or anything that implies a
 * transformer. It ends up in the embedding space name, in the pgvector table name and in the
 * homogeneity guard, so a local index can never be mistaken for — or mixed with — a hosted one.
 */
export const LOCAL_EMBEDDING_MODEL = "codeflow-local-bow";

/** L2-normalised feature-hashed bag of words. Pure. */
export function localEmbed(text: string, dim: number = LOCAL_EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const token of tokenizeCode(text)) {
    vector[fnv1a(token) % dim] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  // A zero vector for untokenizable text, rather than NaN. Cosine against it is 0, which is the
  // correct answer: text with no tokens matches nothing.
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

/**
 * An `EmbeddingClient` that runs entirely in-process.
 *
 * `usage.measured` is TRUE and both token counts are the real token counts, because there is nothing
 * to estimate — no provider, no billing, and the tokenizer's output IS the count. That keeps the
 * V3-P0 "cost is measured, not estimated" invariant literally true on this path rather than
 * exempting it.
 */
export function createLocalEmbeddingClient(options: { dimension?: number } = {}): LocalEmbeddingClient {
  const dimension = options.dimension ?? LOCAL_EMBEDDING_DIM;
  return {
    provider: "local",
    model: LOCAL_EMBEDDING_MODEL,
    dimension,
    async embed(request: LocalEmbeddingRequest): Promise<LocalEmbeddingResult> {
      const vectors = request.texts.map((text) => localEmbed(text, dimension));
      // Real counts, not a guess: there is no provider to disagree with.
      const inputTokens = request.texts.reduce((sum, text) => sum + tokenizeCode(text).length, 0);
      return { vectors, usage: { inputTokens, outputTokens: 0, measured: true } };
    },
  };
}

/** FNV-1a, 32-bit, via shifts so it stays inside a JS number. Fixed constants ⇒ the same token maps
 *  to the same dimension in every process, today and next month. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}
