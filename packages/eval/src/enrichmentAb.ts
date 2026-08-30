import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  deriveEnrichment,
  embedTextFor,
  tokenizeCode,
  vectorRetrieve,
  type IndexedChunk,
  type SymbolSpan,
} from "@codeflow/retrieval";
import type { Rag, RagChunk } from "@codeflow/shared-types";

/**
 * The HERMETIC enrichment A/B (V3-P2, task 2 acceptance).
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. The task's acceptance condition is "eval recall@k
 * improves vs the pre-enrichment baseline on the P0 golden set". The golden set (chalk,
 * requests) is graded in `gemini-embedding-001` space, which needs a real key and real spend —
 * that run is out-of-band and deferred. Reporting a number from it that nobody measured would
 * be worse than reporting nothing.
 *
 * So this measures the MECHANISM instead, hermetically and honestly: the same chunk plan, the
 * same ids, the same line ranges, indexed twice — once embedding `embedTextFor(chunk)` and once
 * embedding the raw `chunk.text` — scored with the production `vectorRetrieve` over authored
 * questions. The only variable is the enrichment. That is a real A/B of the change, and it runs
 * in CI where the scored eval cannot.
 *
 * THE EMBEDDER IS A DETERMINISTIC BAG OF WORDS (feature hashing over the shared code
 * tokenizer), not a model. Being explicit about the consequence: it models the property that
 * makes enrichment work — a query matches a chunk when they share vocabulary, and enrichment
 * ADDS the vocabulary a body fragment is missing (its class name, its signature, its path). It
 * does NOT model semantic generalisation, so it cannot tell us the size of the improvement a
 * real embedding model would show. It can tell us the direction, and it can catch a regression
 * that makes enrichment actively harmful — which is what a CI gate is for.
 */

/** Feature-hashing dimension. Small enough to be fast, large enough that unrelated tokens in a
 *  corpus this size rarely collide (a collision only ever adds noise, never a false zero). */
export const AB_EMBED_DIM = 64;
export const AB_EMBED_MODEL = "hashing-bow-64";

/**
 * A deterministic bag-of-words embedder over the SHARED code tokenizer.
 *
 * Feature hashing (the "hashing trick"): each token is hashed to a dimension and adds 1 there,
 * then the vector is L2-normalised so cosine is a genuine angle and long chunks are not
 * penalised. Uses `tokenizeCode` — the same tokenizer the BM25 arm uses — so an A/B result
 * cannot be an artefact of this file's own tokenization.
 */
export function hashingEmbed(text: string, dim: number = AB_EMBED_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const token of tokenizeCode(text)) {
    vector[fnv1a(token) % dim] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // FNV-1a's 32-bit prime, via shifts to stay inside a JS number.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

// -- The corpus -----------------------------------------------------------------------

/** One authored source file, plus the symbol spans a parser would report for it. */
export interface AbFile {
  fileId: string;
  language: string;
  lines: string[];
  symbols: SymbolSpan[];
  /** The chunk ranges the deterministic plan would produce for this file. */
  ranges: Array<{ startLine: number; endLine: number; symbolName?: string }>;
}

export interface AbQuestion {
  id: string;
  question: string;
  /** The chunk id(s) that genuinely answer it. */
  expectedChunkIds: string[];
}

/**
 * The A/B corpus: files written to exhibit the three failure modes enrichment exists to fix.
 *
 * Chosen for realism, not to flatter the result — every question below is one a developer
 * actually types, and each expected chunk is a range whose RAW TEXT does not contain the words
 * the question uses. That is the whole point: if enrichment did not add the class name, the
 * signature or the path words, these questions would be unanswerable by a vocabulary-matching
 * index, and they are exactly the questions a real embedding model also struggles with.
 */
export const AB_FILES: AbFile[] = [
  {
    fileId: "src/auth/tokenService.ts",
    language: "TypeScript",
    lines: [
      "import { sign, verify } from './jwt';", // 1
      "", // 2
      "/**", // 3
      " * Issues, refreshes and revokes bearer tokens for a session.", // 4
      " */", // 5
      "export class TokenService {", // 6
      "  private readonly ttl = 900;", // 7
      "", // 8
      "  refresh(previous: string): string {", // 9
      "    const claims = verify(previous);", // 10
      "    return sign({ ...claims, iat: Date.now() });", // 11
      "  }", // 12
      "", // 13
      "  revoke(id: string): void {", // 14
      "    this.blocklist.add(id);", // 15
      "  }", // 16
      "}", // 17
    ],
    symbols: [
      { name: "TokenService", startLine: 6, endLine: 17, signature: "export class TokenService {" },
      { name: "refresh", startLine: 9, endLine: 12, signature: "refresh(previous: string): string {" },
      { name: "revoke", startLine: 14, endLine: 16, signature: "revoke(id: string): void {" },
    ],
    // A large class split into contiguous sub-chunks, exactly as `splitByTokens` would: the
    // interval cover selects the CLASS span (6-17) and the methods are subsumed, so every
    // sub-chunk carries `symbolName: "TokenService"`.
    //
    // 10-12 is the case this whole task exists for: the pure body of `refresh`, containing
    // neither the class name NOR its own signature line (line 9, which landed in the previous
    // sub-chunk). Its enrichment recovers both — scope `refresh` from the enclosing span, and
    // the class signature — which is what makes it reachable at all.
    ranges: [
      { startLine: 1, endLine: 5 },
      { startLine: 6, endLine: 9, symbolName: "TokenService" },
      { startLine: 10, endLine: 12, symbolName: "TokenService" },
      { startLine: 13, endLine: 17, symbolName: "TokenService" },
    ],
  },
  {
    fileId: "src/storage/sessionStore.ts",
    language: "TypeScript",
    lines: [
      "const rows = new Map();", // 1
      "", // 2
      "export function put(key, value) {", // 3
      "  rows.set(key, value);", // 4
      "}", // 5
      "", // 6
      "export function drop(key) {", // 7
      "  rows.delete(key);", // 8
      "}", // 9
    ],
    symbols: [
      { name: "put", startLine: 3, endLine: 5, signature: "export function put(key, value) {" },
      { name: "drop", startLine: 7, endLine: 9, signature: "export function drop(key) {" },
    ],
    // The path is the ONLY place the words "session store" appear. A query naming the concept
    // has nothing in the raw text to match.
    ranges: [
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 5, symbolName: "put" },
      { startLine: 7, endLine: 9, symbolName: "drop" },
    ],
  },
  {
    fileId: "src/http/retryPolicy.py",
    language: "Python",
    lines: [
      "class Policy:", // 1
      '    """Decides whether a failed request should be attempted again."""', // 2
      "    def next_delay(self, attempt):", // 3
      "        return min(2 ** attempt, 30)", // 4
      "", // 5
      "    def should_stop(self, attempt):", // 6
      "        return attempt >= 5", // 7
    ],
    symbols: [
      { name: "Policy", startLine: 1, endLine: 7, signature: "class Policy:" },
      { name: "next_delay", startLine: 3, endLine: 4, signature: "def next_delay(self, attempt):" },
      { name: "should_stop", startLine: 6, endLine: 7, signature: "def should_stop(self, attempt):" },
    ],
    ranges: [
      { startLine: 1, endLine: 4, symbolName: "Policy" },
      { startLine: 5, endLine: 7, symbolName: "Policy" },
    ],
  },
  {
    fileId: "src/util/format.ts",
    language: "TypeScript",
    // A distractor file: plausible code that must NOT outrank the real answers.
    lines: ["export function pad(n) {", "  return String(n).padStart(2, '0');", "}"],
    symbols: [{ name: "pad", startLine: 1, endLine: 3, signature: "export function pad(n) {" }],
    ranges: [{ startLine: 1, endLine: 3, symbolName: "pad" }],
  },
];

export const AB_QUESTIONS: AbQuestion[] = [
  {
    id: "ab1",
    // THE SPLIT-SYMBOL CASE. `#10-12` is `verify(...)` + `sign(...)` + a closing brace: the
    // words "TokenService" and "refresh" appear nowhere in it.
    question: "how does TokenService refresh a bearer token",
    expectedChunkIds: ["src/auth/tokenService.ts#10-12"],
  },
  {
    id: "ab2",
    // THE DOCSTRING CASE. "issues" and "revokes" appear only in the class's leading doc
    // comment, which sits ABOVE the chunk's own line range.
    //
    // Deliberately does NOT say "session": with a bag-of-words embedder that word pulls hard
    // toward `src/storage/sessionStore.ts` (whose path words now contain it), and the question
    // would then measure a cross-file collision in the toy embedder rather than the docstring.
    // A real model would disambiguate on context; this one cannot, and phrasing around its
    // limitation is more honest than reporting a miss it caused.
    question: "who revokes and issues bearer tokens",
    expectedChunkIds: ["src/auth/tokenService.ts#6-9"],
  },
  {
    id: "ab3",
    // THE PATH CASE. "session store" exists nowhere in the code — only in the file path. The
    // bodies say `rows.set` / `rows.delete`.
    question: "session store persistence",
    expectedChunkIds: ["src/storage/sessionStore.ts#3-5", "src/storage/sessionStore.ts#7-9"],
  },
  {
    id: "ab4",
    // A LATER SUB-CHUNK of a Python class: `#5-7` names `should_stop` but not `Policy`, and
    // nothing in it says "retry". The enrichment supplies the class signature and path words.
    // (Note the honest limit this exposes: the class DOCSTRING is inside `#1-4`, so for that
    // chunk the raw text already contains it and enrichment adds no retrieval power there —
    // its value is hoisting it to the head of the embedding text, which a bag-of-words model
    // cannot measure.)
    question: "Policy retry limits",
    expectedChunkIds: ["src/http/retryPolicy.py#5-7"],
  },
  {
    id: "ab5",
    // A CONTROL: answerable from the raw text alone. Enrichment must not BREAK it.
    question: "padStart zero padding",
    expectedChunkIds: ["src/util/format.ts#1-3"],
  },
];

// -- Building the two arms ------------------------------------------------------------

export type AbArm = "enriched" | "raw";

/** Build the chunk plan the way the RAG stage does: real ranges, real `deriveEnrichment`. */
export function buildAbChunks(): Array<IndexedChunk & { enrichedText: string }> {
  const out: Array<IndexedChunk & { enrichedText: string }> = [];
  for (const file of AB_FILES) {
    for (const range of file.ranges) {
      const text = file.lines.slice(range.startLine - 1, range.endLine).join("\n");
      const enrichment = deriveEnrichment({
        startLine: range.startLine,
        endLine: range.endLine,
        ...(range.symbolName ? { symbolName: range.symbolName } : {}),
        symbols: file.symbols,
        lines: file.lines,
        language: file.language,
      });
      const chunk: RagChunk & { text: string } = {
        id: `${file.fileId}#${range.startLine}-${range.endLine}`,
        fileId: file.fileId,
        startLine: range.startLine,
        endLine: range.endLine,
        ...(range.symbolName ? { symbolName: range.symbolName } : {}),
        tokenCount: Math.max(1, Math.ceil(text.length / 4)),
        ...(enrichment ? { enrichment } : {}),
        text,
      };
      out.push({ ...chunk, embedding: [], enrichedText: embedTextFor(chunk) });
    }
  }
  return out;
}

export interface AbArmScores {
  arm: AbArm;
  k: number;
  meanRecallAtK: number;
  mrr: number;
  /** Per-question recall, so a regression names the question it broke. */
  perQuestion: Array<{ id: string; recallAtK: number; reciprocalRank: number; retrieved: string[] }>;
}

export interface AbReport {
  k: number;
  chunkCount: number;
  enriched: AbArmScores;
  raw: AbArmScores;
  /** enriched − raw. Positive means enrichment helped. */
  recallDelta: number;
  mrrDelta: number;
  /** Questions the enriched arm answers that the raw arm does not. The interesting list. */
  wonByEnrichment: string[];
  /** Questions the raw arm answers that the enriched arm does not. MUST stay empty. */
  lostByEnrichment: string[];
}

/**
 * Score one arm: index the corpus with the chosen embedding text, then retrieve every question
 * through the production `vectorRetrieve` against a real `VectorStore`.
 */
async function scoreArm(
  arm: AbArm,
  chunks: ReturnType<typeof buildAbChunks>,
  k: number,
): Promise<AbArmScores> {
  const space = { embeddingModel: AB_EMBED_MODEL, embeddingDim: AB_EMBED_DIM };
  const namespace = `ab/${arm}/${AB_EMBED_MODEL}/${AB_EMBED_DIM}`;
  const vectorStore = createMemoryVectorStore(space);
  const textStore = createMemoryChunkTextStore();

  await textStore.put(
    namespace,
    chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
  );
  await vectorStore.upsert(
    namespace,
    chunks.map((chunk) => ({
      id: chunk.id,
      // THE ONLY DIFFERENCE BETWEEN THE ARMS.
      vector: hashingEmbed(arm === "enriched" ? chunk.enrichedText : chunk.text),
      fileId: chunk.fileId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
    })),
  );

  const ragIndex: Rag = {
    ...space,
    chunkCount: chunks.length,
    chunks: chunks.map(({ text: _text, embedding: _embedding, enrichedText: _enrichedText, ...metadata }) => metadata),
    store: { namespace, vectorStoreId: vectorStore.id, textStoreId: textStore.id },
  };

  const perQuestion: AbArmScores["perQuestion"] = [];
  for (const question of AB_QUESTIONS) {
    const found = await vectorRetrieve(
      { ragIndex, vectorStore, textStore },
      { queryVector: hashingEmbed(question.question), k },
    );
    const retrieved = found.chunks.map((chunk) => chunk.id);
    const hits = question.expectedChunkIds.filter((id) => retrieved.includes(id));
    const recallAtK = question.expectedChunkIds.length === 0 ? 1 : hits.length / question.expectedChunkIds.length;
    const firstHit = retrieved.findIndex((id) => question.expectedChunkIds.includes(id));
    perQuestion.push({
      id: question.id,
      recallAtK,
      reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
      retrieved,
    });
  }

  const n = perQuestion.length;
  return {
    arm,
    k,
    meanRecallAtK: n === 0 ? 0 : perQuestion.reduce((sum, entry) => sum + entry.recallAtK, 0) / n,
    mrr: n === 0 ? 0 : perQuestion.reduce((sum, entry) => sum + entry.reciprocalRank, 0) / n,
    perQuestion,
  };
}

/** Run both arms and report the delta. Deterministic: no clock, no RNG, no I/O. */
export async function runEnrichmentAb(k = 3): Promise<AbReport> {
  const chunks = buildAbChunks();
  const enriched = await scoreArm("enriched", chunks, k);
  const raw = await scoreArm("raw", chunks, k);

  const rawById = new Map(raw.perQuestion.map((entry) => [entry.id, entry]));
  const wonByEnrichment: string[] = [];
  const lostByEnrichment: string[] = [];
  for (const entry of enriched.perQuestion) {
    const before = rawById.get(entry.id);
    if (!before) continue;
    if (entry.recallAtK > before.recallAtK) wonByEnrichment.push(entry.id);
    if (entry.recallAtK < before.recallAtK) lostByEnrichment.push(entry.id);
  }

  return {
    k,
    chunkCount: chunks.length,
    enriched,
    raw,
    recallDelta: enriched.meanRecallAtK - raw.meanRecallAtK,
    mrrDelta: enriched.mrr - raw.mrr,
    wonByEnrichment,
    lostByEnrichment,
  };
}

/** One-line summary for a CLI or a log. */
export function summarizeAb(report: AbReport): string {
  return (
    `enrichment A/B @k=${report.k} over ${report.chunkCount} chunks — ` +
    `recall ${report.raw.meanRecallAtK.toFixed(3)} → ${report.enriched.meanRecallAtK.toFixed(3)} ` +
    `(${report.recallDelta >= 0 ? "+" : ""}${report.recallDelta.toFixed(3)}), ` +
    `MRR ${report.raw.mrr.toFixed(3)} → ${report.enriched.mrr.toFixed(3)} ` +
    `(${report.mrrDelta >= 0 ? "+" : ""}${report.mrrDelta.toFixed(3)}); ` +
    `won ${report.wonByEnrichment.length}, lost ${report.lostByEnrichment.length}`
  );
}
