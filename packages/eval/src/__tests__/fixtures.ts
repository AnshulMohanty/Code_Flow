import type { AnalysisResult, RagChunk } from "@codeflow/shared-types";
import type { EmbeddingClient, EmbeddingRequest } from "@codeflow/analyzers";
import type { EvalDataset } from "../dataset.js";

// Synthetic fixture in a TINY 3-d embedding space whose nearest neighbours are known by
// construction — no real model, no guesses. Basis: auth=[1,0,0], db=[0,1,0], util=[0,0,1].

export const EMBED_MODEL = "mock-embed";
export const EMBED_DIM = 3;

function chunk(fileId: string, startLine: number, endLine: number, embedding: number[]): RagChunk {
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

export const CHUNKS: RagChunk[] = [
  chunk("src/auth.ts", 1, 10, [1, 0, 0]),
  chunk("src/db.ts", 1, 10, [0, 1, 0]),
  chunk("src/util.ts", 1, 5, [0, 0, 1]),
];

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
      rag: { chunks: CHUNKS, chunkCount: CHUNKS.length, embeddingModel: EMBED_MODEL, embeddingDim: EMBED_DIM },
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
    async embed(request: EmbeddingRequest): Promise<number[][]> {
      calls.push(request);
      return request.texts.map((text) => QUERY_VECTORS[text] ?? new Array(EMBED_DIM).fill(0));
    },
  };
}
