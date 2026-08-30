import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  type ChunkTextStore,
  type IndexedChunk,
  type VectorStore,
} from "@codeflow/retrieval";
import type { Rag } from "@codeflow/shared-types";

/**
 * The eval's INDEX SIDECAR (V3-P2).
 *
 * WHY THIS FILE EXISTS. Before P2 an `AnalysisResult` JSON was self-sufficient for the eval:
 * the vectors were inside it. P2 moved them into a store, which is correct for production and
 * inconvenient here — the out-of-band scored run is "produce a result file, then score it",
 * and that workflow must not suddenly require a live Postgres.
 *
 * So the eval accepts a companion file holding the chunks WITH their vectors and text, and
 * hydrates the in-memory stores from it. That keeps the scored run infra-free while scoring
 * the REAL query path (`vectorRetrieve` against a `VectorStore`), and the same harness can be
 * pointed at a live pgvector instead by passing that store directly — which is the deferred
 * integration run.
 *
 * The in-memory store is also the RIGHT store for an eval independent of convenience: it is an
 * exact cosine scan, whereas pgvector's HNSW index is approximate. An eval number that moved
 * because an ANN index made a different guess would be unattributable.
 */

/** Bumped when this sidecar's shape changes in a breaking way. */
export const EVAL_INDEX_SCHEMA_VERSION = 1;

export interface EvalIndexFile {
  indexSchemaVersion: number;
  /** The space these vectors live in. Cross-checked against the dataset and the result. */
  embeddingModel: string;
  embeddingDim: number;
  /** Chunks with text + vectors — i.e. what the RAG stage wrote to the stores. */
  chunks: IndexedChunk[];
}

/**
 * RUNTIME validation for a loaded index sidecar — one of the untrusted external boundaries the
 * V3-P0 contract rule names (a file from disk, like the dataset loader).
 *
 * Each check below exists because getting it wrong produces a SILENTLY WRONG SCORE rather than
 * a crash: a vector of the wrong length still yields a plausible cosine (the loop truncates to
 * the shorter length); a chunk with no text scores retrieval fine and then reaches the answer
 * path as empty context; a duplicate id makes recall depend on Map insertion order.
 */
export function assertEvalIndexShape(value: unknown): asserts value is EvalIndexFile {
  const file = value as Partial<EvalIndexFile> | null;
  if (!file || typeof file !== "object") throw new Error("Eval index must be a JSON object.");
  if (file.indexSchemaVersion !== EVAL_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `Eval index indexSchemaVersion ${String(file.indexSchemaVersion)} != ${EVAL_INDEX_SCHEMA_VERSION} — re-export it.`,
    );
  }
  if (typeof file.embeddingModel !== "string" || !file.embeddingModel) {
    throw new Error("Eval index must declare a non-empty `embeddingModel`.");
  }
  if (!Number.isInteger(file.embeddingDim) || (file.embeddingDim as number) <= 0) {
    throw new Error(`Eval index \`embeddingDim\` must be a positive integer (got ${String(file.embeddingDim)}).`);
  }
  if (!Array.isArray(file.chunks) || file.chunks.length === 0) {
    throw new Error("Eval index must carry a non-empty `chunks` array.");
  }

  const dim = file.embeddingDim as number;
  const seen = new Set<string>();
  for (const [index, chunk] of file.chunks.entries()) {
    const where = `chunks[${index}]`;
    if (!chunk || typeof chunk !== "object") throw new Error(`${where} must be an object.`);
    if (typeof chunk.id !== "string" || !chunk.id) throw new Error(`${where} needs a non-empty string \`id\`.`);
    if (seen.has(chunk.id)) throw new Error(`${where} duplicates the chunk id "${chunk.id}".`);
    seen.add(chunk.id);
    if (typeof chunk.fileId !== "string" || !chunk.fileId) throw new Error(`${where} (${chunk.id}) needs a \`fileId\`.`);
    if (!Number.isInteger(chunk.startLine) || !Number.isInteger(chunk.endLine)) {
      throw new Error(`${where} (${chunk.id}) needs integer \`startLine\`/\`endLine\`.`);
    }
    if (chunk.startLine < 1 || chunk.endLine < chunk.startLine) {
      throw new Error(`${where} (${chunk.id}) has an impossible range ${chunk.startLine}-${chunk.endLine}.`);
    }
    if (typeof chunk.text !== "string" || chunk.text === "") {
      throw new Error(`${where} (${chunk.id}) needs non-empty \`text\` — an empty chunk cannot ground an answer.`);
    }
    if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== dim) {
      throw new Error(
        `${where} (${chunk.id}) has a ${Array.isArray(chunk.embedding) ? String(chunk.embedding.length) : "missing"}-dim ` +
          `embedding but the index declares ${dim}. Cosine over mismatched dimensions silently truncates.`,
      );
    }
    for (const component of chunk.embedding) {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        throw new Error(`${where} (${chunk.id}) has a non-finite embedding component.`);
      }
    }
  }
}

/** Populated in-memory stores plus the namespace they were written under. */
export interface HydratedEvalIndex {
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
  namespace: string;
}

/**
 * Build in-memory stores from chunks-with-vectors, under the namespace the analysis result
 * itself declares.
 *
 * Using `rag.store.namespace` rather than inventing one is what makes this a faithful stand-in:
 * `vectorRetrieve` reads the namespace off the index slice, so if we wrote under a different
 * one the eval would search an empty namespace and report recall 0 for every question — a
 * failure that looks exactly like the retrieval being broken.
 */
export function hydrateEvalIndex(rag: Rag, chunks: readonly IndexedChunk[]): Promise<HydratedEvalIndex> {
  if (!rag.store) {
    throw new Error(
      "This AnalysisResult's ai.rag has no `store` reference: it is a pre-V3-P2 inline index. " +
        "Re-run the pipeline to produce one the current retrieval path can read.",
    );
  }
  return hydrateInto(rag.store.namespace, { embeddingModel: rag.embeddingModel, embeddingDim: rag.embeddingDim }, chunks);
}

async function hydrateInto(
  namespace: string,
  space: { embeddingModel: string; embeddingDim: number },
  chunks: readonly IndexedChunk[],
): Promise<HydratedEvalIndex> {
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
      vector: chunk.embedding,
      fileId: chunk.fileId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
    })),
  );
  return { vectorStore, textStore, namespace };
}
