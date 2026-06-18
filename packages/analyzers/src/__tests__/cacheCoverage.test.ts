import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisCacheHandle,
  AnalysisResult,
  AnalysisSliceKey,
  PipelineInput,
  PipelineStage,
  PipelineStageId,
  ProgressEvent,
  RepoGraph,
  RepoMetrics,
  StageKind,
} from "@codeflow/shared-types";
import { runPipeline, type CachedAnalysisLookup } from "../pipeline/orchestrator.js";
import { createIngestStage, type RepoCloner } from "../stages/ingest.js";
import { createSynthesizeStage } from "../stages/synthesize.js";
import type { LlmClient, LlmCompletionRequest } from "../llm/llmClient.js";

const RESOLVED_SHA = "abc123";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
  requestedCommitSha: RESOLVED_SHA, // caller-known SHA → enables the pre-ingest decision
};

const GRAPH: RepoGraph = {
  nodes: [
    { id: "src/index.ts", path: "src/index.ts", name: "index.ts", layer: "source", language: "TypeScript", lines: 20, symbolCount: 2 },
    { id: "src/a.ts", path: "src/a.ts", name: "a.ts", layer: "source", language: "TypeScript", lines: 10, symbolCount: 1 },
  ],
  edges: [{ from: "src/index.ts", to: "src/a.ts", kind: "import", specifier: "./a" }],
  resolution: { resolved: 1, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
};

const METRICS: RepoMetrics = {
  perFile: [
    { fileId: "src/index.ts", centrality: 1, fanIn: 0, fanOut: 1, blastRadius: 0, complexity: 21 },
    { fileId: "src/a.ts", centrality: 1, fanIn: 1, fanOut: 0, blastRadius: 1, complexity: 11 },
  ],
  keyFiles: ["src/index.ts", "src/a.ts"],
  hotspots: ["src/index.ts", "src/a.ts"],
  cycles: [],
  summary: { fileCount: 2, edgeCount: 1, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 1 },
};

function ev(stage: PipelineStageId, kind: StageKind): ProgressEvent {
  return { jobId: "job-1", stage, stageIndex: 0, stageCount: 0, kind, status: "completed", label: stage, progress: 0, startedAt: "", emittedAt: "" };
}

function fakeStage(id: PipelineStageId, kind: StageKind, owns: AnalysisSliceKey[], partial: Record<string, unknown>) {
  const run = vi.fn(async () => ({ partial, event: ev(id, kind) }));
  return { stage: { id, kind, label: id, owns, run } as unknown as PipelineStage, run };
}

function fakeCloner(): RepoCloner & { clone: ReturnType<typeof vi.fn> } {
  const clone = vi.fn(async () => ({ repoPath: "/tmp/clone", commitSha: RESOLVED_SHA }));
  return { clone };
}

function cacheReturning(result: AnalysisResult | null): CachedAnalysisLookup {
  return { findCached: vi.fn(async () => result) };
}

function goodResponse(): string {
  return JSON.stringify({ summary: "An app. Start at the entry point.", readingOrder: [{ fileId: "src/index.ts", order: 1, reason: "entry" }] });
}

interface MockClient extends LlmClient {
  calls: LlmCompletionRequest[];
}
function mockClient(): MockClient {
  const calls: LlmCompletionRequest[] = [];
  return {
    provider: "anthropic",
    model: "mock",
    calls,
    async complete(request) {
      calls.push(request);
      return goodResponse();
    },
  };
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

function makeClock() {
  let t = 0;
  return () => ++t;
}

/** Build the full configured pipeline: ingest + two deterministic stages (graph, metrics)
 *  + the real Synthesize AI stage. Returns spies on each so tests assert what ran. */
function buildPipeline(client: LlmClient = mockClient()) {
  const cloner = fakeCloner();
  const ingest = createIngestStage({ cloner, now: () => 1 });
  const connect = fakeStage("connect", "deterministic", ["graph"], { graph: GRAPH });
  const analyze = fakeStage("analyze", "deterministic", ["metrics"], { metrics: METRICS });
  const synth = createSynthesizeStage({ client, now: () => 1 });
  const stages: PipelineStage[] = [ingest, connect.stage, analyze.stage, synth];
  return { stages, cloner, connectRun: connect.run, analyzeRun: analyze.run, client };
}

function cachedResult(producedBy: PipelineStageId[], extra: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: "cached-1",
    repository: input.repositoryRef,
    mode: "public_hosted",
    createdAt: "2026-06-03T00:00:00.000Z",
    commitSha: RESOLVED_SHA,
    warnings: [],
    producedBy,
    summary: { repository: input.repositoryRef, mode: "public_hosted", files: 2, functions: 0, connections: 1, healthScore: null, healthGrade: null },
    files: GRAPH.nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: METRICS,
    graph: GRAPH,
    ...extra,
  } as AnalysisResult;
}

describe("cache coverage — three-way decision", () => {
  it("FULL HIT (det+ai covered): returns cached, runs nothing, no clone, no LLM call", async () => {
    const { stages, cloner, connectRun, analyzeRun, client } = buildPipeline();
    const cached = cachedResult(["ingest", "connect", "analyze", "synthesize"]);

    const { result, cached: wasCached } = await runPipeline(stages, input, {
      now: makeClock(),
      cacheLookup: cacheReturning(cached),
    });

    expect(wasCached).toBe(true);
    expect(result).toBe(cached);
    expect(cloner.clone).not.toHaveBeenCalled();
    expect(connectRun).not.toHaveBeenCalled();
    expect(analyzeRun).not.toHaveBeenCalled();
    expect((client as MockClient).calls).toHaveLength(0);
  });

  it("AI-ONLY RETRY (det covered, ai not): only synthesize runs; clone/parse/graph/metrics do NOT", async () => {
    const { stages, cloner, connectRun, analyzeRun, client } = buildPipeline();
    const cached = cachedResult(["ingest", "connect", "analyze"]); // synthesis previously failed

    const { result, cached: wasCached } = await runPipeline(stages, input, {
      now: makeClock(),
      cacheLookup: cacheReturning(cached),
    });

    expect(wasCached).toBe(false); // freshly assembled (so the worker saves it)
    expect(cloner.clone).not.toHaveBeenCalled(); // HARD REQ: no clone on AI-only retry
    expect(connectRun).not.toHaveBeenCalled(); // deterministic stages not recomputed
    expect(analyzeRun).not.toHaveBeenCalled();
    expect((client as MockClient).calls).toHaveLength(1); // only the AI stage ran

    // deterministic slices in the output are the CACHED ones, not recomputed
    expect(result.graph).toEqual(GRAPH);
    expect(result.metrics).toEqual(METRICS);
    // re-stamped producedBy now includes synthesize
    expect(result.producedBy).toEqual(["analyze", "connect", "ingest", "synthesize"]);
    expect(result.ai?.synthesis?.readingOrder[0].fileId).toBe("src/index.ts");
  });

  it("FULL MISS (a deterministic stage not covered): full re-analyze runs", async () => {
    const { stages, cloner, connectRun, analyzeRun, client } = buildPipeline();
    const cached = cachedResult(["ingest", "connect"]); // analyze missing → det NOT covered

    const { cached: wasCached } = await runPipeline(stages, input, {
      now: makeClock(),
      cacheLookup: cacheReturning(cached),
    });

    expect(wasCached).toBe(false);
    expect(cloner.clone).toHaveBeenCalledTimes(1); // full re-analyze: clone happens
    expect(connectRun).toHaveBeenCalledTimes(1);
    expect(analyzeRun).toHaveBeenCalledTimes(1);
    expect((client as MockClient).calls).toHaveLength(1);
  });

  it("deterministic-incomplete cached result is NOT reusable as a det hit → re-runs", async () => {
    // Mirrors a result whose deterministic stage failed (status 'failed', never persisted in
    // prod). If one were somehow returned, it must MISS, not serve as a hit.
    const { stages, connectRun, analyzeRun } = buildPipeline();
    const cached = cachedResult(["ingest"]); // only ingest → det not covered

    await runPipeline(stages, input, { now: makeClock(), cacheLookup: cacheReturning(cached) });

    expect(connectRun).toHaveBeenCalledTimes(1);
    expect(analyzeRun).toHaveBeenCalledTimes(1);
  });

  it("NO-AI deployment (configured.ai empty): det covered ⇒ full hit (empty-set AI coverage)", async () => {
    // Pipeline WITHOUT synthesize — all configured stages are deterministic.
    const cloner = fakeCloner();
    const ingest = createIngestStage({ cloner, now: () => 1 });
    const connect = fakeStage("connect", "deterministic", ["graph"], { graph: GRAPH });
    const analyze = fakeStage("analyze", "deterministic", ["metrics"], { metrics: METRICS });
    const cached = cachedResult(["ingest", "connect", "analyze"]);

    const { result, cached: wasCached } = await runPipeline([ingest, connect.stage, analyze.stage], input, {
      now: makeClock(),
      cacheLookup: cacheReturning(cached),
    });

    expect(wasCached).toBe(true); // aiCovered trivially true
    expect(result).toBe(cached);
    expect(cloner.clone).not.toHaveBeenCalled();
    expect(connect.run).not.toHaveBeenCalled();
  });
});

describe("cache coverage — AI-partial persistence + backfill loop", () => {
  it("synthesis fails → 'partial' with det-only producedBy → a second view triggers AI-only retry", async () => {
    // First run: a failing LLM client → run 'partial', deterministic intact, producedBy det-only.
    const failing = buildPipeline({
      provider: "anthropic",
      model: "mock",
      async complete() {
        throw new Error("LLM down");
      },
    } as LlmClient);
    const first = await runPipeline(failing.stages, input, { now: makeClock(), cacheLookup: cacheReturning(null) });

    expect(first.result.pipeline?.status).toBe("partial");
    expect(first.result.producedBy).toEqual(["analyze", "connect", "ingest"]); // no synthesize
    expect(first.result.graph).toEqual(GRAPH); // deterministic facts preserved

    // Second view: feed the persisted partial back as the cached result → AI-only retry.
    const second = buildPipeline();
    const { cached: wasCached } = await runPipeline(second.stages, input, {
      now: makeClock(),
      cacheLookup: cacheReturning(first.result),
    });
    expect(wasCached).toBe(false);
    expect(second.cloner.clone).not.toHaveBeenCalled(); // NOT a full re-analyze
    expect(second.connectRun).not.toHaveBeenCalled();
    expect(second.analyzeRun).not.toHaveBeenCalled();
    expect((second.client as MockClient).calls).toHaveLength(1); // only the AI retry
  });

  it("backfill: cached det-only result + AI now configured ⇒ AI-only retry adds synthesis", async () => {
    const { stages, cloner, connectRun, analyzeRun } = buildPipeline();
    // Cached by an OLD deterministic-only pipeline (before synthesize was configured).
    const cached = cachedResult(["ingest", "connect", "analyze"]);

    const { result, cached: wasCached } = await runPipeline(stages, input, {
      now: makeClock(),
      cacheLookup: cacheReturning(cached),
    });

    expect(wasCached).toBe(false);
    expect(cloner.clone).not.toHaveBeenCalled();
    expect(connectRun).not.toHaveBeenCalled();
    expect(analyzeRun).not.toHaveBeenCalled();
    expect(result.producedBy).toContain("synthesize");
    expect(result.ai?.synthesis).toBeDefined();
  });
});

describe("cache coverage — composes with the LLM-output cache", () => {
  it("AI-only retry with an identical prompt + warm LLM cache → no real LLM call", async () => {
    const llmCache = memCache();
    const client = mockClient();
    const cached = cachedResult(["ingest", "connect", "analyze"]);

    // Run #1: AI-only retry → real LLM call → writes the completion into the shared llmCache.
    const a = buildPipeline(client);
    await runPipeline(a.stages, input, { now: makeClock(), cacheLookup: cacheReturning(cached), cache: llmCache });
    expect(client.calls).toHaveLength(1);

    // Run #2: same SHA + same hydrated slices ⇒ identical assembled prompt ⇒ llmCache hit.
    const b = buildPipeline(client);
    await runPipeline(b.stages, input, { now: makeClock(), cacheLookup: cacheReturning(cached), cache: llmCache });
    expect(client.calls).toHaveLength(1); // still 1 — served from the LLM-output cache
  });
});
