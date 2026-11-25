import { tokenizeCode } from "./tokenize.js";

/**
 * The keyless local embedder: feature hashing over `tokenizeCode` tokens, L2-normalised. Deterministic
 * (no RNG, no clock), so an index built today is searchable tomorrow.
 *
 * It is NOT MiniLM. Every MiniLM runtime probed needed a large native download (onnxruntime-node
 * 211 MB, @lancedb/lancedb 656 MB, native tokenizers for onnxruntime-web), which defeats a CLI that
 * runs on a bare laptop. What it captures is LEXICAL overlap — shared identifiers and path words — not
 * meaning ("authenticate" vs "login"). On code that is a strong signal (it took enrichment's recall@3
 * from 0.500 to 1.000 in V3-P2), and `hybridSearch` pairs it with BM25. Upgrade path: an
 * `EmbeddingClient` over onnxruntime-web + a JS WordPiece; nothing else changes.
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
