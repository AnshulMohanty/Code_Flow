import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisCacheHandle,
  Inventory,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoGraph,
  RepoStructure,
  TokenUsage,
} from "@codeflow/shared-types";
import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  type ChunkTextStore,
  type VectorStore,
} from "@codeflow/retrieval";
import { createRagStage } from "../stages/rag.js";
import { createSynthesizeStage } from "../stages/synthesize.js";
import { createIngestStage, type RepoCloner } from "../stages/ingest.js";
import { runPipeline, type CachedAnalysisLookup } from "../pipeline/orchestrator.js";
import type { EmbeddingClient, EmbeddingRequest, EmbeddingResult } from "../embedding/embeddingClient.js";
import { tokensOf } from "../budget/budgetHandle.js";
import type { LlmClient } from "../llm/llmClient.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

// --- Fixtures ---------------------------------------------------------------
// Two source files + a README (docs) + an orphan source file NOT in the graph (grounding).

const FILE_A = ["// header comment", "export function foo() {", "  return 1;", "}", "", "export function bar() {", "  return 2;", "}"].join("\n"); // 8 lines
const README = ["# Title", "", "Some docs here."].join("\n"); // 3 lines
const FILE_ORPHAN = ["export function ghost() {", "  return 0;", "}"].join("\n"); // 3 lines

const GRAPH_NODE_IDS = ["src/a.ts", "README.md"]; // NOTE: src/orphan.ts deliberately absent

function graphFor(ids: string[]): RepoGraph {
  return {
    nodes: ids.map((id) => ({
      id,
      path: id,
      name: id.split("/").pop()!,
      layer: "source",
      language: "TypeScript",
      lines: 8,
      symbolCount: 2,
    })),
    edges: [],
    resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
  };
}

const structure: RepoStructure = {
  layout: "src-rooted",
  fileCount: 4,
  files: [
    { path: "src/a.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 100 },
    { path: "README.md", ext: ".md", role: "docs", language: "Markdown", sizeBytes: 50 },
    { path: "tsconfig.json", ext: ".json", role: "config", language: "JSON", sizeBytes: 30 }, // skipped role
    { path: "src/orphan.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 40 }, // not in graph
  ],
};

const inventory: Inventory = {
  symbols: [
    { name: "foo", kind: "function", filePath: "src/a.ts", line: 2, endLine: 4, exported: true, language: "TypeScript" },
    { name: "bar", kind: "function", filePath: "src/a.ts", line: 6, endLine: 8, exported: true, language: "TypeScript" },
    { name: "ghost", kind: "function", filePath: "src/orphan.ts", line: 1, endLine: 3, exported: true, language: "TypeScript" },
  ],
  entryPoints: [],
  symbolCount: 3,
  loc: { "src/a.ts": 8, "README.md": 3, "src/orphan.ts": 3 },
};

const FILES: Record<string, string> = {
  "src/a.ts": FILE_A,
  "README.md": README,
  "src/orphan.ts": FILE_ORPHAN,
};

function fakeReadFile(extra: Record<string, string> = {}) {
  const table = { ...FILES, ...extra };
  return vi.fn(async (_repoPath: string, relativePath: string): Promise<string | null> => {
    return relativePath in table ? table[relativePath] : null;
  });
}

function memCache(): AnalysisCacheHandle {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
  };
}

interface MockEmbedClient extends EmbeddingClient {
  calls: EmbeddingRequest[];
}

/** Deterministic mock: a stable hash of each text → a fixed-length vector. Zero real API. */
function mockEmbedClient(dim = 4, provider: "voyage" | "gemini" = "voyage", model = "mock-embed"): MockEmbedClient {
  const calls: EmbeddingRequest[] = [];
  return {
    provider,
    model,
    dimension: dim,
    calls,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      calls.push(request);
      const vectors = request.texts.map((text) => {
        let seed = 0;
        for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
        return Array.from({ length: dim }, (_, i) => ((seed + i) % 97) / 97);
      });
      // Provider-reported usage, so the budget path records MEASURED tokens.
      return { vectors, usage: { inputTokens: request.texts.length * 10, outputTokens: 0, measured: true } };
    },
  };
}

interface SpyBudget {
  check(n: number): Promise<boolean>;
  record(n: number): Promise<void>;
  checks: number[];
  records: number[];
  /** The provider TokenUsage records handed to `record()` (empty if only counts were). */
  usages: TokenUsage[];
}
function spyBudget(allow: boolean): SpyBudget {
  const checks: number[] = [];
  const records: number[] = [];
  const usages: TokenUsage[] = [];
  return {
    checks,
    records,
    usages,
    async check(n) {
      checks.push(n);
      return allow;
    },
    // V3-P0: `record` now takes a number OR a provider TokenUsage. Normalize to a count so
    // the existing assertions keep meaning, and capture the usage separately below.
    async record(actual) {
      records.push(tokensOf(actual));
      if (typeof actual !== "number") usages.push(actual);
    },
  };
}

function ctxFor(
  opts: { cache?: AnalysisCacheHandle; repoPath?: string; commitSha?: string; readFile?: ReturnType<typeof fakeReadFile>; graphIds?: string[]; structure?: RepoStructure; inventory?: Inventory; budget?: SpyBudget } = {},
): { ctx: PipelineContext; readFile: ReturnType<typeof fakeReadFile> } {
  const readFile = opts.readFile ?? fakeReadFile();
  return {
    readFile,
    ctx: {
      repoPath: opts.repoPath === undefined ? "/repo" : opts.repoPath || undefined,
      commitSha: opts.commitSha ?? "sha-1",
      prior: {
        graph: graphFor(opts.graphIds ?? GRAPH_NODE_IDS),
        structure: opts.structure ?? structure,
        inventory: opts.inventory ?? inventory,
      },
      cache: opts.cache ?? memCache(),
      budget: opts.budget,
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    },
  };
}

/**
 * The hermetic store pair, in the CLIENT's embedding space (V3-P2).
 *
 * Derived from the client rather than hardcoded so the stage's homogeneity guard is exercised
 * with matching spaces in the happy path — the mismatch cases construct a deliberately wrong
 * store instead.
 */
function storesFor(client: EmbeddingClient): { vectorStore: VectorStore; textStore: ChunkTextStore } {
  return {
    vectorStore: createMemoryVectorStore({ embeddingModel: client.model, embeddingDim: client.dimension }),
    textStore: createMemoryChunkTextStore(),
  };
}

/** Run the stage and hand back the stores it wrote into, so a test can read the heavy fields
 *  from where they now actually live. */
async function runRag(
  ctx: PipelineContext,
  readFile: ReturnType<typeof fakeReadFile>,
  client: EmbeddingClient,
  overrides: { maxAttempts?: number; maxChunkTokens?: number; windowLines?: number } = {},
) {
  const stores = storesFor(client);
  const stage = createRagStage({ client, ...stores, readFile, now: () => 1000, ...overrides });
  const run = await stage.run(input, ctx);
  return { ...run, ...stores };
}

// ---------------------------------------------------------------------------

describe("rag — symbol-aligned chunking + window fallback", () => {
  it("produces one chunk per top-level symbol, sweeps the gaps, window-chunks docs", async () => {
    const { ctx, readFile } = ctxFor();
    const { partial } = await runRag(ctx, readFile, mockEmbedClient());
    const rag = partial.aiRag!;

    const plan = rag.chunks.map((c) => ({ id: c.id, fileId: c.fileId, startLine: c.startLine, endLine: c.endLine, symbolName: c.symbolName }));
    expect(plan).toEqual([
      // README (docs) window-chunked, sorts first by fileId
      { id: "README.md#1-3", fileId: "README.md", startLine: 1, endLine: 3, symbolName: undefined },
      // src/a.ts: gap header (1), foo (2-4), gap (5), bar (6-8)
      { id: "src/a.ts#1-1", fileId: "src/a.ts", startLine: 1, endLine: 1, symbolName: undefined },
      { id: "src/a.ts#2-4", fileId: "src/a.ts", startLine: 2, endLine: 4, symbolName: "foo" },
      { id: "src/a.ts#5-5", fileId: "src/a.ts", startLine: 5, endLine: 5, symbolName: undefined },
      { id: "src/a.ts#6-8", fileId: "src/a.ts", startLine: 6, endLine: 8, symbolName: "bar" },
    ]);
    expect(rag.embeddingModel).toBe("mock-embed");
    expect(rag.embeddingDim).toBe(4);
    // config role skipped: tsconfig.json never read
    expect(readFile).not.toHaveBeenCalledWith("/repo", "tsconfig.json");
  });

  it("chunk text matches the cited line range, and every chunk is stored with a vector", async () => {
    const { ctx, readFile } = ctxFor();
    const { partial, vectorStore, textStore } = await runRag(ctx, readFile, mockEmbedClient());
    const rag = partial.aiRag!;
    const foo = rag.chunks.find((c) => c.symbolName === "foo")!;
    const namespace = rag.store!.namespace;

    // The TEXT still matches the cited range exactly — it just lives in the text store now.
    const texts = await textStore.get(namespace, [foo.id]);
    expect(texts.get(foo.id)).toBe(["export function foo() {", "  return 1;", "}"].join("\n"));
    expect(foo.tokenCount).toBeGreaterThan(0);
    // Every chunk got a vector, and the vector store holds exactly the plan.
    expect(await vectorStore.count(namespace)).toBe(rag.chunkCount);
  });

  it("the PERSISTED slice carries no text and no embeddings (the 16MB-BSON fix, asserted)", async () => {
    // This is V3-P2's acceptance criterion, and it is asserted structurally rather than
    // trusted: the whole point of the change is that what goes into Mongo grows with the
    // chunk COUNT and not with the embedding dimension. A regression here would be invisible
    // until a real repo blew the document limit.
    const { ctx, readFile } = ctxFor();
    const { partial } = await runRag(ctx, readFile, mockEmbedClient());
    const rag = partial.aiRag!;
    for (const chunk of rag.chunks) {
      const loose = chunk as unknown as Record<string, unknown>;
      expect(loose.text).toBeUndefined();
      expect(loose.embedding).toBeUndefined();
    }
    // A round trip through JSON is what persistence actually does; no vector may survive it.
    expect(JSON.stringify(rag)).not.toContain("embedding\"");
    // And the slice names WHERE the heavy fields went, so a mismatch is diagnosable.
    expect(rag.store).toEqual({
      namespace: expect.stringContaining("acme/repo@sha-1"),
      vectorStoreId: "memory-vector-store",
      textStoreId: "memory-chunk-text-store",
    });
  });

  it("re-indexing the same SHA replaces the namespace rather than accumulating in it", async () => {
    // Without the drop-before-upsert, a chunking change would leave the previous run's chunk
    // ids behind — still searchable, still citing ranges the current plan never produced.
    const client = mockEmbedClient();
    const stores = storesFor(client);
    const stage = createRagStage({ client, ...stores, readFile: fakeReadFile(), now: () => 1000 });

    const first = await stage.run(input, ctxFor().ctx);
    const namespace = first.partial.aiRag!.store!.namespace;
    const countAfterFirst = await stores.vectorStore.count(namespace);

    // Second pass with a much smaller window ⇒ a DIFFERENT (larger) chunk set for the docs
    // file, i.e. new ids alongside the old ones if nothing dropped them.
    const narrow = createRagStage({ client, ...stores, readFile: fakeReadFile(), now: () => 1000, windowLines: 1 });
    const second = await narrow.run(input, ctxFor().ctx);
    expect(await stores.vectorStore.count(namespace)).toBe(second.partial.aiRag!.chunkCount);
    expect(second.partial.aiRag!.chunkCount).not.toBe(countAfterFirst);
  });
});

describe("rag — oversized symbol splitting", () => {
  it("splits an oversized span into contiguous sub-chunks that tile the range", async () => {
    const big = ["function big() {", "  const a = 111111;", "  const b = 222222;", "}"].join("\n");
    const struct: RepoStructure = { layout: "flat", fileCount: 1, files: [{ path: "src/big.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 80 }] };
    const inv: Inventory = {
      symbols: [{ name: "big", kind: "function", filePath: "src/big.ts", line: 1, endLine: 4, exported: false, language: "TypeScript" }],
      entryPoints: [],
      symbolCount: 1,
      loc: { "src/big.ts": 4 },
    };
    const { ctx, readFile } = ctxFor({ readFile: fakeReadFile({ "src/big.ts": big }), graphIds: ["src/big.ts"], structure: struct, inventory: inv });

    // Tiny cap forces splitting; window large so the symbol span isn't pre-split.
    const { partial } = await runRag(ctx, readFile, mockEmbedClient(), { maxChunkTokens: 4, windowLines: 100 });
    const subs = partial.aiRag!.chunks;

    expect(subs.length).toBeGreaterThan(1);
    expect(subs.every((c) => c.symbolName === "big")).toBe(true);
    // contiguous, no gaps/overlaps, covering lines 1..4
    expect(subs[0].startLine).toBe(1);
    expect(subs[subs.length - 1].endLine).toBe(4);
    for (let i = 1; i < subs.length; i++) expect(subs[i].startLine).toBe(subs[i - 1].endLine + 1);
    // multi-line sub-chunks respect the cap (a single over-cap line is the floor)
    for (const c of subs) if (c.endLine > c.startLine) expect(c.tokenCount).toBeLessThanOrEqual(4);
  });
});

describe("rag — grounding (enforced by code)", () => {
  it("drops chunks whose fileId is not a graph node and records them in droppedChunks", async () => {
    const { ctx, readFile } = ctxFor();
    const { partial } = await runRag(ctx, readFile, mockEmbedClient());
    const rag = partial.aiRag!;

    expect(rag.chunks.some((c) => c.fileId === "src/orphan.ts")).toBe(false);
    expect(rag.droppedChunks).toEqual({ count: 1, fileIds: ["src/orphan.ts"] });
  });

  it("throws when every chunk drops after grounding (no deterministic retry)", async () => {
    // Only the orphan file exists, and it is not in the graph → empty after grounding.
    const struct: RepoStructure = { layout: "flat", fileCount: 1, files: [{ path: "src/orphan.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 40 }] };
    const { ctx, readFile } = ctxFor({ graphIds: ["src/a.ts"], structure: struct });
    await expect(runRag(ctx, readFile, mockEmbedClient())).rejects.toThrow(/no grounded chunks/);
  });
});

describe("rag — store homogeneity guard", () => {
  it("throws when the vector store is in a different embedding space than the client", async () => {
    const client = mockEmbedClient(4);
    const { ctx, readFile } = ctxFor();
    const stage = createRagStage({
      client,
      // 8-dim store, 4-dim client: cosine would still return numbers, so nothing downstream
      // would ever notice. Caught at the write boundary instead.
      vectorStore: createMemoryVectorStore({ embeddingModel: "mock-embed", embeddingDim: 8 }),
      textStore: createMemoryChunkTextStore(),
      readFile,
      now: () => 1000,
    });
    await expect(stage.run(input, ctx)).rejects.toThrow(/vector store/);
  });
});

describe("rag — embedding cache (wallet defense)", () => {
  it("a full cache hit makes ZERO API calls on re-run", async () => {
    const cache = memCache();
    const first = mockEmbedClient();
    await runRag(ctxFor({ cache }).ctx, fakeReadFile(), first);
    expect(first.calls.length).toBeGreaterThan(0); // cold: embedded

    // Second run, same cache + identical content, fresh client → all chunks hit the cache.
    const second = mockEmbedClient();
    const { ctx, readFile } = ctxFor({ cache });
    const { partial } = await runRag(ctx, readFile, second);
    expect(second.calls).toHaveLength(0); // ZERO API
    expect(partial.aiRag!.chunkCount).toBeGreaterThan(0);
  });
});

describe("rag — embedding cache key is provider + dim scoped", () => {
  it("same text under voyage vs gemini ⇒ different keys (no cross-provider hit)", async () => {
    const cache = memCache();
    const voyage = mockEmbedClient(4, "voyage");
    await runRag(ctxFor({ cache }).ctx, fakeReadFile(), voyage);
    expect(voyage.calls.length).toBeGreaterThan(0);

    const gemini = mockEmbedClient(4, "gemini", "gemini-embedding-001");
    const { ctx, readFile } = ctxFor({ cache });
    await runRag(ctx, readFile, gemini);
    expect(gemini.calls.length).toBeGreaterThan(0); // re-embedded, NOT served voyage's vectors
  });

  it("same text at dim 4 vs dim 8 ⇒ different keys", async () => {
    const cache = memCache();
    const d4 = mockEmbedClient(4, "voyage");
    await runRag(ctxFor({ cache }).ctx, fakeReadFile(), d4);

    const d8 = mockEmbedClient(8, "voyage");
    const { ctx, readFile } = ctxFor({ cache });
    await runRag(ctx, readFile, d8);
    expect(d8.calls.length).toBeGreaterThan(0); // different output dim ⇒ re-embed
  });
});

describe("rag — budget guard (Guard 5; cache-before-budget)", () => {
  it("an embedding-cache full hit spends 0 budget (budget never consulted)", async () => {
    const cache = memCache();
    await runRag(ctxFor({ cache }).ctx, fakeReadFile(), mockEmbedClient()); // warm embedding cache

    const budget = spyBudget(false); // would block a real call
    const fresh = mockEmbedClient();
    const { ctx, readFile } = ctxFor({ cache, budget });
    const { partial } = await runRag(ctx, readFile, fresh);

    expect(partial.aiRag!.chunkCount).toBeGreaterThan(0); // produced from cache
    expect(fresh.calls).toHaveLength(0); // zero API
    expect(budget.checks).toHaveLength(0); // budget NOT touched on a full hit
  });

  it("a cache MISS under the ceiling checks then records actual spend", async () => {
    const budget = spyBudget(true);
    const { ctx, readFile } = ctxFor({ budget });
    await runRag(ctx, readFile, mockEmbedClient());

    expect(budget.checks).toHaveLength(1);
    expect(budget.records).toHaveLength(1);
    expect(budget.records[0]).toBeGreaterThan(0); // summed chunk tokenCount recorded
  });

  it("over the ceiling ⇒ throws budget-exhausted WITHOUT embedding", async () => {
    const budget = spyBudget(false);
    const client = mockEmbedClient();
    const { ctx, readFile } = ctxFor({ budget });
    await expect(runRag(ctx, readFile, client)).rejects.toThrow(/capacity|budget/i);
    expect(client.calls).toHaveLength(0); // provider NOT called when exhausted
    expect(budget.records).toHaveLength(0);
  });
});

describe("rag — embedding-API failure → transient retry → throw", () => {
  it("retries up to maxAttempts then throws", async () => {
    let calls = 0;
    const failing: EmbeddingClient = {
      provider: "voyage",
      model: "mock-embed",
      dimension: 4,
      async embed() {
        calls += 1;
        throw new Error("voyage down");
      },
    };
    const { ctx, readFile } = ctxFor();
    await expect(runRag(ctx, readFile, failing, { maxAttempts: 3 })).rejects.toThrow(/embedding failed after 3 attempts/);
    expect(calls).toBe(3);
  });
});

describe("rag — determinism", () => {
  it("run twice → byte-identical Rag (plan, ordering, vectors)", async () => {
    const a = await runRag(ctxFor().ctx, fakeReadFile(), mockEmbedClient());
    const b = await runRag(ctxFor().ctx, fakeReadFile(), mockEmbedClient());
    expect(JSON.stringify(a.partial.aiRag)).toBe(JSON.stringify(b.partial.aiRag));
  });
});

describe("rag — plain-serializable", () => {
  it("JSON.stringify(result.ai.rag) round-trips, carrying the store reference", async () => {
    // Pre-V3-P2 this test also asserted `chunks[0].embedding` was an array — the point then
    // being "a plain number[], not a live vector object". P2 removed the field entirely, so the
    // property worth pinning is now the other half: the slice still survives persistence, and
    // it still says WHERE the heavy fields went. (That no vector remains is asserted directly
    // in "the PERSISTED slice carries no text and no embeddings".)
    const { ctx, readFile } = ctxFor();
    const { partial } = await runRag(ctx, readFile, mockEmbedClient());
    const roundTripped = JSON.parse(JSON.stringify(partial.aiRag));
    expect(roundTripped).toEqual(partial.aiRag);
    expect(roundTripped.store.namespace).toBe(partial.aiRag!.store!.namespace);
  });
});

describe("rag — no-disk AI-only retry (chunk-plan cache)", () => {
  it("with repoPath absent + a cached plan: builds the index WITHOUT touching disk", async () => {
    const cache = memCache();
    // Warm the plan cache via a normal disk run.
    const warm = ctxFor({ cache });
    await runRag(warm.ctx, warm.readFile, mockEmbedClient());

    // Retry: no repoPath, fresh readFile spy that must NOT be called.
    const retryReadFile = fakeReadFile();
    const { ctx } = ctxFor({ cache, repoPath: "" });
    const { partial } = await runRag(ctx, retryReadFile, mockEmbedClient());

    expect(retryReadFile).not.toHaveBeenCalled(); // NO disk
    expect(partial.aiRag!.chunkCount).toBeGreaterThan(0);
    // grounded plan reused → orphan still excluded, drop count preserved
    expect(partial.aiRag!.droppedChunks).toEqual({ count: 1, fileIds: ["src/orphan.ts"] });
  });

  it("throws when there is neither a working tree nor a cached plan", async () => {
    const { ctx } = ctxFor({ repoPath: "" });
    await expect(runRag(ctx, fakeReadFile(), mockEmbedClient())).rejects.toThrow(/no repoPath and no cached chunk plan/);
  });
});

// --- Orchestrator-level: AI error contract + no-clone retry -----------------

const ev = (stage: PipelineStage["id"], kind: "deterministic" | "ai"): ProgressEvent => ({
  jobId: "job-1",
  stage,
  stageIndex: 0,
  stageCount: 0,
  kind,
  status: "completed",
  label: stage,
  progress: 0,
  startedAt: "",
  emittedAt: "",
});

function fakeStage(id: PipelineStage["id"], owns: "graph" | "structure" | "inventory" | "metrics", partial: Record<string, unknown>) {
  const run = vi.fn(async () => ({ partial, event: ev(id, "deterministic") }));
  return { stage: { id, kind: "deterministic", label: id, owns: [owns], run } as unknown as PipelineStage, run };
}

function goodLlm(): LlmClient {
  return {
    provider: "anthropic",
    model: "mock-llm",
    async complete() {
      return {
        text: JSON.stringify({ summary: "An app.", readingOrder: [{ fileId: "src/a.ts", order: 1, reason: "entry" }] }),
        usage: { inputTokens: 50, outputTokens: 10, measured: true },
      };
    },
  };
}

function makeClock() {
  let t = 0;
  return () => ++t;
}

describe("rag — AI error contract (via orchestrator)", () => {
  it("a thrown embed client → run 'partial', deterministic + synthesis slices intact, ai.rag unset", async () => {
    const graph = graphFor(GRAPH_NODE_IDS);
    const connect = fakeStage("connect", "graph", { graph });
    const struct = fakeStage("map-structure", "structure", { structure });
    const inv = fakeStage("inventory", "inventory", { inventory });
    const cloner: RepoCloner = { clone: async () => ({ repoPath: "/repo", commitSha: "sha-1" }) };
    const ingest = createIngestStage({ cloner, now: () => 1 });
    const synth = createSynthesizeStage({ client: goodLlm(), now: () => 1 });
    const failing: EmbeddingClient = { provider: "voyage", model: "mock-embed", dimension: 4, async embed() { throw new Error("voyage down"); } };
    const rag = createRagStage({ client: failing, ...storesFor(failing), readFile: fakeReadFile(), now: () => 1, maxAttempts: 2 });

    const { result } = await runPipeline([ingest, struct.stage, inv.stage, connect.stage, synth, rag], input, { now: makeClock() });

    expect(result.pipeline?.status).toBe("partial");
    expect(result.graph).toEqual(graph); // deterministic intact
    expect(result.ai?.synthesis).toBeDefined(); // synthesis intact
    expect(result.ai?.rag).toBeUndefined(); // RAG failed cleanly
    expect(result.warnings.some((w) => w.includes("rag"))).toBe(true);
  });
});

describe("rag — no-clone AI-only retry (via orchestrator)", () => {
  it("det-covered cache + repoPath-less retry: only RAG runs, no clone, no deterministic stage, no disk", async () => {
    const cache = memCache();
    const graph = graphFor(GRAPH_NODE_IDS);

    // Pre-warm the chunk-plan cache under the resolved SHA (as a prior disk run would have).
    const warm = ctxFor({ cache });
    await runRag(warm.ctx, warm.readFile, mockEmbedClient());

    const connect = fakeStage("connect", "graph", { graph });
    const analyze = fakeStage("analyze", "metrics", {
      metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 2, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
    });
    const clone = vi.fn(async () => ({ repoPath: "/repo", commitSha: "sha-1" }));
    const ingest = createIngestStage({ cloner: { clone }, now: () => 1 });
    const retryReadFile = fakeReadFile();
    const retryClient = mockEmbedClient();
    const rag = createRagStage({ client: retryClient, ...storesFor(retryClient), readFile: retryReadFile, now: () => 1 });
    const stages: PipelineStage[] = [ingest, connect.stage, analyze.stage, rag];

    const cached = {
      id: "cached-1",
      repository: input.repositoryRef,
      mode: "public_hosted" as const,
      createdAt: "2026-06-03T00:00:00.000Z",
      commitSha: "sha-1",
      warnings: [],
      producedBy: ["ingest", "connect", "analyze"] as PipelineStage["id"][],
      summary: { repository: input.repositoryRef, mode: "public_hosted" as const, files: 2, functions: 0, connections: 0, healthScore: null, healthGrade: null },
      files: graph.nodes,
      symbols: [],
      dependencies: [],
      issues: [],
      metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 2, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
      graph,
    };
    const cacheLookup: CachedAnalysisLookup = { findCached: vi.fn(async () => cached) };

    const { result, cached: wasCached } = await runPipeline(stages, { ...input, requestedCommitSha: "sha-1" }, {
      now: makeClock(),
      cache,
      cacheLookup,
    });

    expect(wasCached).toBe(false); // freshly assembled (worker will save it)
    expect(clone).not.toHaveBeenCalled(); // NO clone
    expect(connect.run).not.toHaveBeenCalled(); // NO deterministic stage
    expect(analyze.run).not.toHaveBeenCalled();
    expect(retryReadFile).not.toHaveBeenCalled(); // NO disk
    expect(result.ai?.rag?.chunkCount).toBeGreaterThan(0);
    expect(result.producedBy).toContain("rag");
  });
});

describe("rag — index homogeneity (mismatched embedding space ⇒ rebuild, not a hit)", () => {
  it("cached rag from voyage under a current gemini selection ⇒ RAG uncovered ⇒ re-embeds", async () => {
    const cache = memCache();
    const graph = graphFor(GRAPH_NODE_IDS);

    // Pre-warm the chunk-plan cache (a prior disk run); plan is provider-independent.
    const warm = ctxFor({ cache });
    await runRag(warm.ctx, warm.readFile, mockEmbedClient());

    const connect = fakeStage("connect", "graph", { graph });
    const analyze = fakeStage("analyze", "metrics", {
      metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 2, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
    });
    const clone = vi.fn(async () => ({ repoPath: "/repo", commitSha: "sha-1" }));
    const ingest = createIngestStage({ cloner: { clone }, now: () => 1 });
    const retryReadFile = fakeReadFile();
    // Current selection is Gemini (different model + dim from the cached voyage slice).
    const gemini = mockEmbedClient(768, "gemini", "gemini-embedding-001");
    const rag = createRagStage({ client: gemini, ...storesFor(gemini), readFile: retryReadFile, now: () => 1 });
    const stages: PipelineStage[] = [ingest, connect.stage, analyze.stage, rag];

    // Cached result CLAIMS rag in producedBy, but its slice was embedded with voyage-code-3/1024.
    const cached = {
      id: "cached-1",
      repository: input.repositoryRef,
      mode: "public_hosted" as const,
      createdAt: "2026-06-03T00:00:00.000Z",
      commitSha: "sha-1",
      warnings: [],
      producedBy: ["ingest", "connect", "analyze", "rag"] as PipelineStage["id"][],
      summary: { repository: input.repositoryRef, mode: "public_hosted" as const, files: 2, functions: 0, connections: 0, healthScore: null, healthGrade: null },
      files: graph.nodes,
      symbols: [],
      dependencies: [],
      issues: [],
      metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 2, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
      graph,
      ai: { rag: { chunks: [], chunkCount: 0, embeddingModel: "voyage-code-3", embeddingDim: 1024 } },
    };
    const cacheLookup: CachedAnalysisLookup = { findCached: vi.fn(async () => cached) };

    const { result, cached: wasCached } = await runPipeline(stages, { ...input, requestedCommitSha: "sha-1" }, {
      now: makeClock(),
      cache,
      cacheLookup,
    });

    // NOT a full hit — the cached vector space mismatches the current selection.
    expect(wasCached).toBe(false);
    expect(clone).not.toHaveBeenCalled(); // still an AI-only retry (det covered)
    expect(connect.run).not.toHaveBeenCalled();
    expect(gemini.calls.length).toBeGreaterThan(0); // RAG re-embedded with the new provider
    expect(result.ai?.rag?.embeddingModel).toBe("gemini-embedding-001");
    expect(result.ai?.rag?.embeddingDim).toBe(768);
  });
});
