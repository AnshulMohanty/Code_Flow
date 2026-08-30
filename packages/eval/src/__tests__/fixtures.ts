import type { AnalysisResult, RagChunk } from "@codeflow/shared-types";
import type { EmbeddingClient, EmbeddingRequest, EmbeddingResult } from "@codeflow/analyzers";
import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  type IndexedChunk,
  type RetrievedChunk,
} from "@codeflow/retrieval";
import type { EvalDataset } from "../dataset.js";
import type { EvalRetrieval } from "../runEval.js";

// Synthetic fixture in a TINY 3-d embedding space whose nearest neighbours are known by
// construction — no real model, no guesses. Basis: auth=[1,0,0], db=[0,1,0], util=[0,0,1].
//
// V3-P2 SPLIT THIS FIXTURE IN THREE, mirroring the three lifetimes the production types now
// have: `INDEXED_CHUNKS` (metadata + text + vector) is what the RAG stage writes to the
// stores, `CHUNK_META` is what the analysis document persists, and `RETRIEVED_CHUNKS` is what
// the query path hands back. Keeping one blob would have let a test read a vector off the
// persisted slice, which is precisely the thing that is no longer possible in production.

export const EMBED_MODEL = "mock-embed";
export const EMBED_DIM = 3;
/** The namespace the fixture index lives under — matches what `retrievalNamespace` produces. */
export const FIXTURE_NAMESPACE = "synthetic/fixture@fixturesha0000000000/mock-embed/3";

function indexed(fileId: string, startLine: number, endLine: number, embedding: number[]): IndexedChunk {
  return {
    id: `${fileId}#${startLine}-${endLine}`,
    fileId,
    startLine,
    endLine,
    text: `// ${fileId} lines ${startLine}-${endLine}`,
    embedding,
    tokenCount: 10,
  };
}

/** The full chunks, as the RAG stage produced them in flight. Written to the stores. */
export const INDEXED_CHUNKS: IndexedChunk[] = [
  indexed("src/auth.ts", 1, 10, [1, 0, 0]),
  indexed("src/db.ts", 1, 10, [0, 1, 0]),
  indexed("src/util.ts", 1, 5, [0, 0, 1]),
];

/** What the analysis document persists: metadata only, no text, no vectors. */
export const CHUNK_META: RagChunk[] = INDEXED_CHUNKS.map(({ text: _text, embedding: _embedding, ...metadata }) => metadata);

/** What the query path returns: metadata + text + the scores that put it there. */
export const RETRIEVED_CHUNKS: RetrievedChunk[] = INDEXED_CHUNKS.map(({ embedding: _embedding, ...rest }) => ({
  ...rest,
  fusedScore: 0,
  sources: ["vector"],
}));

// Question text → authored query vector (deterministic). The mock client is a pure lookup.
export const QUERY_VECTORS: Record<string, number[]> = {
  "How does authentication work?": [0.95, 0.05, 0],
  "Where is the database layer?": [0.05, 0.95, 0],
  "What handles payments?": [0, 0, 1], // nearest is util — but the expected file is NOT indexed → a MISS
};

export const DATASET: EvalDataset = {
  evalSchemaVersion: 1,
  repoUrl: "https://github.com/synthetic/fixture",
  commitSha: "fixturesha0000000000",
  embeddingModel: EMBED_MODEL,
  embeddingDim: EMBED_DIM,
  synthesis: {
    expectedEntryPoints: ["src/index.ts", "src/auth.ts"],
  },
  questions: [
    { id: "q1", question: "How does authentication work?", expectedFiles: ["src/auth.ts"] },
    { id: "q2", question: "Where is the database layer?", expectedFiles: ["src/db.ts"] },
    { id: "q3", question: "What handles payments?", expectedFiles: ["src/payments.ts"] }, // not indexed → miss
  ],
};

/**
 * In-memory stores holding the fixture index, under the namespace `fixtureResult()` declares.
 *
 * This is the same pair `hydrateEvalIndex` builds from a sidecar file; constructed directly
 * here so the fixture stays a fixture. The eval then retrieves through `vectorRetrieve` — the
 * production function — rather than through a test-only ranking helper.
 */
export async function fixtureRetrieval(): Promise<EvalRetrieval> {
  const vectorStore = createMemoryVectorStore({ embeddingModel: EMBED_MODEL, embeddingDim: EMBED_DIM });
  const textStore = createMemoryChunkTextStore();
  await textStore.put(
    FIXTURE_NAMESPACE,
    INDEXED_CHUNKS.map((chunk) => ({ id: chunk.id, text: chunk.text })),
  );
  await vectorStore.upsert(
    FIXTURE_NAMESPACE,
    INDEXED_CHUNKS.map((chunk) => ({
      id: chunk.id,
      vector: chunk.embedding,
      fileId: chunk.fileId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    })),
  );
  return { vectorStore, textStore };
}

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 10, symbolCount: 1 };
}

export function fixtureResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: "result-1",
    repository: { provider: "github", owner: "synthetic", name: "fixture" },
    mode: "public_hosted",
    createdAt: "2026-06-10T00:00:00.000Z",
    commitSha: "fixturesha0000000000",
    warnings: [],
    producedBy: ["ingest", "connect", "analyze", "synthesize", "rag"],
    summary: { repository: { provider: "github", owner: "synthetic", name: "fixture" }, mode: "public_hosted", files: 4, functions: 0, connections: 0, healthScore: null, healthGrade: null },
    files: [node("src/index.ts"), node("src/auth.ts"), node("src/db.ts"), node("src/util.ts")],
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [],
      keyFiles: ["src/index.ts", "src/auth.ts", "src/db.ts", "src/util.ts"],
      hotspots: [],
      cycles: [],
      summary: { fileCount: 4, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
    },
    ai: {
      synthesis: {
        summary: "A small app.",
        readingOrder: [
          { fileId: "src/index.ts", order: 1, reason: "entry" },
          { fileId: "src/auth.ts", order: 2, reason: "auth" },
          { fileId: "src/db.ts", order: 3, reason: "data" },
        ],
      },
      rag: {
        chunks: CHUNK_META,
        chunkCount: CHUNK_META.length,
        embeddingModel: EMBED_MODEL,
        embeddingDim: EMBED_DIM,
        store: {
          namespace: FIXTURE_NAMESPACE,
          vectorStoreId: "memory-vector-store",
          textStoreId: "memory-chunk-text-store",
        },
      },
    },
    ...overrides,
  };
}

interface MockEmbeddingClient extends EmbeddingClient {
  calls: EmbeddingRequest[];
}

/** Deterministic mock: looks up each text's authored query vector. Zero real calls. */
export function mockEmbeddingClient(opts: { model?: string; dimension?: number } = {}): MockEmbeddingClient {
  const calls: EmbeddingRequest[] = [];
  return {
    provider: "voyage",
    model: opts.model ?? EMBED_MODEL,
    dimension: opts.dimension ?? EMBED_DIM,
    calls,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      calls.push(request);
      return {
        vectors: request.texts.map((text) => QUERY_VECTORS[text] ?? new Array(EMBED_DIM).fill(0)),
        usage: { inputTokens: request.texts.length * 5, outputTokens: 0, measured: true },
      };
    },
  };
}
