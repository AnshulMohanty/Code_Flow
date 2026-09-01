import type { AnalysisResult, CpgEdge, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";
import type { EmbeddingClient, LlmClient, LlmCompletionRequest, LlmCompletionResult } from "@codeflow/analyzers";
import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  type ChunkTextStore,
  type VectorStore,
} from "@codeflow/retrieval";

/**
 * Hermetic fixtures for the agent tests. No provider, no network, no clock.
 *
 * The `LlmClient` here is SCRIPTED, not a stub that returns one canned string: a test supplies the
 * sequence of actions the model "decides", and can additionally ASSERT ON THE PROMPT it received.
 * That second ability is what stops these tests from being tautological — checking that memory
 * reached the prompt is checking the part we own, whereas checking that a mock returned what it was
 * told to return checks nothing.
 */

const FILE_IDS = ["src/index.ts", "src/auth.ts", "src/db.ts", "src/util.ts", "src/orphan.ts"] as const;

function node(id: string, lines: number): FileNode {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines, symbolCount: 2 };
}

function edge(from: string, to: string): RepoDependencyEdge {
  return { from, to, kind: "import", specifier: `./${to.split("/").pop()!.replace(/\.ts$/, "")}` };
}

/**
 * Shape (imports as ->, calls as ~>):
 *   index.ts -> auth.ts ~> auth.ts (2 calls)
 *   index.ts -> db.ts
 *   auth.ts  -> util.ts ~> util.ts (4 calls)
 *   orphan.ts: no edges either way — so "who calls it" has an exact EMPTY answer.
 */
export function fixtureResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const nodes = FILE_IDS.map((id) => node(id, 20));
  const edges = [edge("src/index.ts", "src/auth.ts"), edge("src/index.ts", "src/db.ts"), edge("src/auth.ts", "src/util.ts")];
  const cpgEdges: CpgEdge[] = [
    { from: "src/index.ts", to: "src/auth.ts", kind: "call", symbol: "login", count: 2, line: 4 },
    { from: "src/auth.ts", to: "src/util.ts", kind: "call", symbol: "hash", count: 4, line: 9 },
  ];

  return {
    id: "analysis-agent-fixture",
    repository: { provider: "github", owner: "acme", name: "repo" },
    mode: "public_hosted",
    createdAt: "2026-08-31T00:00:00.000Z",
    commitSha: "a".repeat(40),
    warnings: [],
    summary: {
      repository: { provider: "github", owner: "acme", name: "repo" },
      mode: "public_hosted",
      files: nodes.length,
      functions: 4,
      connections: edges.length,
      healthScore: 80,
      healthGrade: "B",
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    graph: {
      nodes,
      edges,
      resolution: { resolved: edges.length, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      cpgEdges,
      routes: [],
      cpg: { treeSitterFiles: nodes.length, fallbackFiles: 0, enriched: true },
    },
    inventory: {
      symbols: [
        {
          name: "AuthService",
          kind: "class",
          filePath: "src/auth.ts",
          line: 3,
          endLine: 18,
          exported: true,
          language: "TypeScript",
          signature: "export class AuthService {",
        },
        { name: "login", kind: "method", filePath: "src/auth.ts", line: 5, endLine: 9, exported: false, language: "TypeScript" },
        { name: "connectDb", kind: "function", filePath: "src/db.ts", line: 1, exported: true, language: "TypeScript" },
      ],
      entryPoints: [{ filePath: "src/index.ts", kind: "index", evidence: "filename-convention" }],
      symbolCount: 3,
      loc: { "src/index.ts": 20, "src/auth.ts": 20, "src/db.ts": 20, "src/util.ts": 20, "src/orphan.ts": 20 },
    },
    entryPoints: [{ fileId: "src/index.ts", reason: "index" }],
    metrics: {
      perFile: [],
      keyFiles: ["src/index.ts", "src/auth.ts"],
      hotspots: [],
      cycles: [],
      summary: { fileCount: nodes.length, edgeCount: edges.length, cycleCount: 0, isolatedFileCount: 1, maxBlastRadius: 2 },
      clusters: {
        algorithm: "louvain",
        seed: 42,
        resolution: 1,
        modularity: 0.3,
        count: 2,
        assignments: [
          { fileId: "src/auth.ts", cluster: 0 },
          { fileId: "src/db.ts", cluster: 0 },
          { fileId: "src/index.ts", cluster: 0 },
          { fileId: "src/orphan.ts", cluster: 1 },
          { fileId: "src/util.ts", cluster: 0 },
        ],
        clusters: [
          { id: 0, files: ["src/auth.ts", "src/db.ts", "src/index.ts", "src/util.ts"], size: 4, internalWeight: 8, externalWeight: 0 },
          { id: 1, files: ["src/orphan.ts"], size: 1, internalWeight: 0, externalWeight: 0 },
        ],
      },
    },
    ai: {
      rag: {
        chunks: [
          { id: "src/auth.ts#3-18", fileId: "src/auth.ts", startLine: 3, endLine: 18, symbolName: "AuthService", tokenCount: 20 },
          { id: "src/db.ts#1-10", fileId: "src/db.ts", startLine: 1, endLine: 10, symbolName: "connectDb", tokenCount: 15 },
        ],
        chunkCount: 2,
        embeddingModel: "mock-embed",
        embeddingDim: 3,
        store: { namespace: NAMESPACE, vectorStoreId: "memory-vector-store", textStoreId: "memory-chunk-text-store" },
      },
    },
    ...overrides,
  };
}

export const NAMESPACE = "acme/repo@" + "a".repeat(40) + "/mock-embed/3";
export const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };

export const CHUNK_TEXT: Record<string, string> = {
  "src/auth.ts#3-18": "export class AuthService {\n  login(user) { return hash(user); }\n}",
  "src/db.ts#1-10": "export function connectDb() { return pool(); }",
};
const CHUNK_VECTOR: Record<string, number[]> = {
  "src/auth.ts#3-18": [1, 0, 0],
  "src/db.ts#1-10": [0, 1, 0],
};

/** Populated in-memory retrieval stores for the fixture index. */
export async function fixtureStores(): Promise<{ vectorStore: VectorStore; textStore: ChunkTextStore }> {
  const vectorStore = createMemoryVectorStore(SPACE);
  const textStore = createMemoryChunkTextStore();
  const chunks = fixtureResult().ai!.rag!.chunks;
  await textStore.put(NAMESPACE, chunks.map((chunk) => ({ id: chunk.id, text: CHUNK_TEXT[chunk.id] })));
  await vectorStore.upsert(
    NAMESPACE,
    chunks.map((chunk) => ({
      id: chunk.id,
      vector: CHUNK_VECTOR[chunk.id],
      fileId: chunk.fileId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
    })),
  );
  return { vectorStore, textStore };
}

/** Authored query vectors, so retrieval is known by construction. */
export const QUERY_VECTORS: Record<string, number[]> = {
  auth: [0.95, 0.05, 0],
  "auth service": [0.95, 0.05, 0],
  database: [0.05, 0.95, 0],
  xyzzy: [0, 0, 1], // orthogonal to the whole index -> below the floor -> refusal
};

export interface MockEmbed extends EmbeddingClient {
  calls: string[];
}

export function mockEmbed(dim = 3): MockEmbed {
  const calls: string[] = [];
  return {
    provider: "voyage",
    model: "mock-embed",
    dimension: dim,
    calls,
    async embed(request) {
      calls.push(...request.texts);
      return {
        vectors: request.texts.map((text) => {
          const key = Object.keys(QUERY_VECTORS).find((candidate) => text.toLowerCase().includes(candidate));
          return key ? QUERY_VECTORS[key] : new Array(dim).fill(0);
        }),
        usage: { inputTokens: 5, outputTokens: 0, measured: true },
      };
    },
  };
}

/**
 * A SCRIPTED chat client. Each entry is either a literal reply, or a function of the prompt — the
 * latter is how a test asserts that the prompt actually contained what it should before the model
 * "decides" anything.
 */
export type ScriptEntry = string | ((prompt: string) => string | Promise<string>);

export interface ScriptedChat extends LlmClient {
  prompts: string[];
  requests: LlmCompletionRequest[];
  /** Replies consumed so far. */
  consumed: number;
}

export function scriptedChat(script: readonly ScriptEntry[]): ScriptedChat {
  const prompts: string[] = [];
  const requests: LlmCompletionRequest[] = [];
  let consumed = 0;

  const client: ScriptedChat = {
    provider: "anthropic",
    model: "mock-chat",
    prompts,
    requests,
    get consumed() {
      return consumed;
    },
    async complete(request): Promise<LlmCompletionResult> {
      prompts.push(request.prompt);
      requests.push(request);
      const entry = script[Math.min(consumed, script.length - 1)];
      consumed += 1;
      // A script that runs out REPEATS its last entry rather than throwing: several tests
      // deliberately let the loop hit its turn cap, and an exception there would be testing the
      // fixture rather than the cap.
      // Awaited, so a script entry can introduce a real delay — which is what the V3-P4
      // concurrency probe needs in order to have anything to overlap.
      const text = typeof entry === "function" ? await entry(request.prompt) : entry;
      return { text, usage: { inputTokens: 100, outputTokens: 20, measured: true } };
    },
  };
  return client;
}

/** Shorthand for the JSON actions the agent expects. */
export function toolAction(tool: string, args: Record<string, unknown> = {}, thought = "looking"): string {
  return JSON.stringify({ action: "tool", tool, args, thought });
}

export function answerAction(
  answer: string,
  options: { answered?: boolean; chunkIds?: string[]; fileIds?: string[] } = {},
): string {
  return JSON.stringify({
    action: "answer",
    answer,
    answered: options.answered ?? true,
    citedChunkIds: options.chunkIds ?? [],
    citedFileIds: options.fileIds ?? [],
  });
}
