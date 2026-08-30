import { describe, expect, it } from "vitest";
import type {
  AnalysisCacheHandle,
  Inventory,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoGraph,
  RepoMetrics,
  RepoOrientation,
  RepoStructure,
  TokenUsage,
} from "@codeflow/shared-types";
import { createSynthesizeStage, deriveSynthesis } from "../stages/synthesize.js";
import { runPipeline } from "../pipeline/orchestrator.js";
import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../llm/llmClient.js";
import { tokensOf } from "../budget/budgetHandle.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

const NODE_IDS = ["src/index.ts", "src/a.ts", "src/b.ts"];

const defaultGraph: RepoGraph = {
  nodes: NODE_IDS.map((id) => ({
    id,
    path: id,
    name: id.split("/").pop()!,
    layer: "source",
    language: "TypeScript",
    lines: 20,
    symbolCount: 3,
  })),
  edges: [{ from: "src/index.ts", to: "src/a.ts", kind: "import", specifier: "./a" }],
  resolution: { resolved: 1, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
};

const defaultMetrics: RepoMetrics = {
  perFile: NODE_IDS.map((id, i) => ({
    fileId: id,
    centrality: 3 - i,
    fanIn: i,
    fanOut: 1,
    blastRadius: i,
    complexity: 10 + i,
  })),
  keyFiles: ["src/index.ts", "src/a.ts", "src/b.ts"],
  hotspots: ["src/b.ts", "src/a.ts", "src/index.ts"],
  cycles: [],
  summary: { fileCount: 3, edgeCount: 1, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 2 },
};

const defaultOrientation: RepoOrientation = {
  languages: ["TypeScript"],
  frameworks: [],
  projectType: "application",
  manifests: [],
  readme: { path: "README.md", text: "Hello readme" },
};

const defaultStructure: RepoStructure = {
  layout: "src-rooted",
  files: NODE_IDS.map((id) => ({ path: id, ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 100 })),
  fileCount: 3,
};

const defaultInventory: Inventory = {
  symbols: NODE_IDS.map((id) => ({ name: "fn", kind: "function", filePath: id, line: 1, exported: true, language: "TypeScript" })),
  entryPoints: [{ filePath: "src/index.ts", kind: "index", evidence: "filename-convention" }],
  symbolCount: 3,
  loc: { "src/index.ts": 20, "src/a.ts": 20, "src/b.ts": 20 },
};

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

interface MockClient extends LlmClient {
  calls: LlmCompletionRequest[];
}

/** Mock LLM client. `responses` is consumed per call; a string is returned, an Error is
 *  thrown. The last entry repeats if more calls happen. */
function mockClient(responses: Array<string | Error>): MockClient {
  const calls: LlmCompletionRequest[] = [];
  return {
    provider: "anthropic",
    model: "mock-model",
    calls,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
      calls.push(request);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      // Mock the provider's usage read-back so the budget records MEASURED tokens.
      return { text: next, usage: { inputTokens: 200, outputTokens: 40, measured: true } };
    },
  };
}

function goodResponse(fileIds: string[], summary = "This is a TypeScript app. Start at the entry point."): string {
  return JSON.stringify({
    summary,
    readingOrder: fileIds.map((fileId, i) => ({ fileId, order: i + 1, reason: `read ${fileId}` })),
    keyConcepts: ["routing"],
  });
}

interface SpyBudget {
  check(n: number): Promise<boolean>;
  record(actual: number | TokenUsage): Promise<void>;
  checks: number[];
  records: number[];
  /** The provider TokenUsage records handed to `record()`. */
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
    async check(n: number) {
      checks.push(n);
      return allow;
    },
    // V3-P0: `record` now takes a number OR a provider TokenUsage. Normalize to a count so
    // the existing assertions keep meaning, and capture the usage for the new ones.
    async record(actual: number | TokenUsage) {
      records.push(tokensOf(actual));
      if (typeof actual !== "number") usages.push(actual);
    },
  };
}

function ctxFor(opts: { cache?: AnalysisCacheHandle; commitSha?: string; inventory?: Inventory; metrics?: RepoMetrics; budget?: SpyBudget } = {}): PipelineContext {
  return {
    repoPath: "/repo",
    commitSha: opts.commitSha ?? "sha-1",
    prior: {
      orientation: defaultOrientation,
      structure: defaultStructure,
      inventory: opts.inventory ?? defaultInventory,
      graph: defaultGraph,
      metrics: opts.metrics ?? defaultMetrics,
    },
    cache: opts.cache ?? memCache(),
    budget: opts.budget,
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

async function synth(client: LlmClient, ctx: PipelineContext, maxAttempts?: number) {
  const stage = createSynthesizeStage({ client, now: () => 1000, maxAttempts });
  return stage.run(input, ctx);
}

const ev = (): ProgressEvent => ({
  jobId: "job-1",
  stage: "connect",
  stageIndex: 0,
  stageCount: 0,
  kind: "deterministic",
  status: "completed",
  label: "x",
  progress: 0,
  startedAt: "",
  emittedAt: "",
});

describe("synthesize — valid output", () => {
  it("parses a valid completion into result.ai.synthesis", async () => {
    const client = mockClient([goodResponse(["src/index.ts", "src/a.ts"])]);
    const { partial } = await synth(client, ctxFor());
    expect(partial.aiSynthesis).toBeDefined();
    expect(partial.aiSynthesis!.summary).toContain("TypeScript app");
    expect(partial.aiSynthesis!.readingOrder).toEqual([
      { fileId: "src/index.ts", order: 1, reason: "read src/index.ts" },
      { fileId: "src/a.ts", order: 2, reason: "read src/a.ts" },
    ]);
    expect(partial.aiSynthesis!.keyConcepts).toEqual(["routing"]);
  });

  it("strips code fences before parsing", () => {
    const fenced = "```json\n" + goodResponse(["src/a.ts"]) + "\n```";
    const synthesis = deriveSynthesis(fenced, new Set(NODE_IDS));
    expect(synthesis.readingOrder[0].fileId).toBe("src/a.ts");
  });
});

describe("synthesize — schema validation", () => {
  it("retries on malformed JSON, then throws after maxAttempts", async () => {
    const client = mockClient(["not json", "still not json", "nope"]);
    await expect(synth(client, ctxFor(), 3)).rejects.toThrow(/Synthesis failed after 3 attempts/);
    expect(client.calls).toHaveLength(3);
  });

  it("retries on a missing required field", async () => {
    const client = mockClient([JSON.stringify({ readingOrder: [] }), goodResponse(["src/a.ts"])]);
    const { partial } = await synth(client, ctxFor(), 3);
    expect(partial.aiSynthesis!.readingOrder).toHaveLength(1);
    expect(client.calls).toHaveLength(2); // first rejected (no summary), second valid
  });
});

describe("synthesize — grounding enforcement", () => {
  it("drops ungrounded citations, keeps valid ones, records the dropped count", async () => {
    const response = JSON.stringify({
      summary: "An app.",
      readingOrder: [
        { fileId: "src/index.ts", order: 1, reason: "real" },
        { fileId: "src/does-not-exist.ts", order: 2, reason: "hallucinated" },
        { fileId: "src/a.ts", order: 3, reason: "real" },
      ],
    });
    const { partial } = await synth(mockClient([response]), ctxFor());
    expect(partial.aiSynthesis!.readingOrder.map((s) => s.fileId)).toEqual(["src/index.ts", "src/a.ts"]);
    expect(partial.aiSynthesis!.readingOrder.map((s) => s.order)).toEqual([1, 2]); // renumbered
    expect(partial.aiSynthesis!.droppedCitations).toBe(1);
  });

  it("all-ungrounded → retried → throws (empty after grounding)", async () => {
    const allBad = JSON.stringify({
      summary: "x",
      readingOrder: [{ fileId: "ghost.ts", order: 1, reason: "nope" }],
    });
    const client = mockClient([allBad, allBad, allBad]);
    await expect(synth(client, ctxFor(), 3)).rejects.toThrow(/Synthesis failed after 3 attempts/);
    expect(client.calls).toHaveLength(3);
  });
});

describe("synthesize — AI error contract (via orchestrator)", () => {
  it("a thrown client → run 'partial', deterministic slices intact, ai unset", async () => {
    const graphStage: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["graph"],
      async run() {
        return { partial: { graph: defaultGraph }, event: ev() };
      },
    };
    const metricsStage: PipelineStage = {
      id: "analyze",
      kind: "deterministic",
      label: "Analyze",
      owns: ["metrics"],
      async run() {
        return { partial: { metrics: defaultMetrics }, event: ev() };
      },
    };
    const synthStage = createSynthesizeStage({ client: mockClient([new Error("LLM down")]), now: () => 1 });

    const { result } = await runPipeline([graphStage, metricsStage, synthStage], input, { now: makeClock() });

    expect(result.pipeline?.status).toBe("partial");
    expect(result.graph).toEqual(defaultGraph); // deterministic slice intact
    expect(result.metrics).toEqual(defaultMetrics);
    expect(result.ai).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("synthesize"))).toBe(true);
  });
});

describe("synthesize — LLM-output cache", () => {
  it("identical SHA + prompt → client called ONCE; second run served from cache", async () => {
    const cache = memCache();
    const client = mockClient([goodResponse(["src/index.ts"])]);

    const first = await synth(client, ctxFor({ cache }));
    const second = await synth(client, ctxFor({ cache }));

    expect(client.calls).toHaveLength(1); // second hit the cache
    expect(second.partial.aiSynthesis).toEqual(first.partial.aiSynthesis);
  });

  it("different SHA → different key → not served from the prior cache", async () => {
    const cache = memCache();
    const client = mockClient([goodResponse(["src/index.ts"]), goodResponse(["src/a.ts"])]);
    await synth(client, ctxFor({ cache, commitSha: "sha-1" }));
    await synth(client, ctxFor({ cache, commitSha: "sha-2" }));
    expect(client.calls).toHaveLength(2);
  });

  it("v2 key is provider+model scoped: switching providers MISSES (no cross-provider hit)", async () => {
    const cache = memCache();
    const anthropic = mockClient([goodResponse(["src/index.ts"])]);
    const gemini = mockClient([goodResponse(["src/a.ts"])]);
    (gemini as { provider: string }).provider = "gemini";

    await synth(anthropic, ctxFor({ cache })); // writes synthesis/v2/anthropic/...
    await synth(gemini, ctxFor({ cache })); // different provider ⇒ different key ⇒ real call

    expect(anthropic.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(1); // NOT served the anthropic completion
  });
});

describe("synthesize — context budget & boundary", () => {
  it("the prompt uses a bounded selection, NOT the full symbol/node list; slices unmutated", async () => {
    // Many symbols incl. a deep sentinel + many nodes; key ranking covers only a subset.
    const manySymbols = [...defaultInventory.symbols];
    manySymbols.push({ name: "ZZZ_DEEP_SENTINEL_SYMBOL", kind: "function", filePath: "src/b.ts", line: 99, exported: false, language: "TypeScript" });
    const inventory: Inventory = { ...defaultInventory, symbols: manySymbols, symbolCount: manySymbols.length };

    const client = mockClient([goodResponse(["src/index.ts"])]);
    const ctx = ctxFor({ inventory });
    const before = JSON.stringify({ inventory: ctx.prior.inventory, metrics: ctx.prior.metrics, graph: ctx.prior.graph });

    await synth(client, ctx);

    const prompt = client.calls[0].prompt;
    expect(prompt).not.toContain("ZZZ_DEEP_SENTINEL_SYMBOL"); // full symbol list never fed
    expect(prompt).toContain("src/index.ts"); // top key file IS fed
    // uncapped slices were read, not mutated
    expect(JSON.stringify({ inventory: ctx.prior.inventory, metrics: ctx.prior.metrics, graph: ctx.prior.graph })).toBe(before);
  });

  it("writes ONLY the aiSynthesis slice (no graph algorithms / no new metrics)", async () => {
    const { partial } = await synth(mockClient([goodResponse(["src/index.ts"])]), ctxFor());
    expect(Object.keys(partial)).toEqual(["aiSynthesis"]);
  });

  it("throws if the graph slice is missing (Connect must run first)", async () => {
    const ctx = ctxFor();
    const noGraph: PipelineContext = { ...ctx, prior: { ...ctx.prior, graph: undefined } };
    await expect(synth(mockClient([goodResponse(["src/a.ts"])]), noGraph)).rejects.toThrow(/graph/);
  });
});

describe("synthesize — budget guard (Guard 5; cache-before-budget)", () => {
  it("a cache HIT spends 0 budget (budget never consulted)", async () => {
    const cache = memCache();
    const client = mockClient([goodResponse(["src/index.ts"]), goodResponse(["src/a.ts"])]);
    await synth(client, ctxFor({ cache })); // warm the cache

    const budget = spyBudget(false); // would block a real call
    const second = await synth(client, ctxFor({ cache, budget }));

    expect(second.partial.aiSynthesis).toBeDefined(); // served from cache
    expect(budget.checks).toHaveLength(0); // budget NOT touched on a hit
    expect(client.calls).toHaveLength(1); // no second LLM call
  });

  it("a cache MISS under the ceiling checks then records actual spend", async () => {
    const budget = spyBudget(true);
    const client = mockClient([goodResponse(["src/index.ts"])]);
    await synth(client, ctxFor({ budget }));

    expect(client.calls).toHaveLength(1);
    expect(budget.checks).toHaveLength(1);
    expect(budget.records).toHaveLength(1);
    expect(budget.records[0]).toBeGreaterThan(0); // estimate recorded
  });

  it("over the ceiling ⇒ run 'partial' + budget-exhausted, deterministic intact, no LLM call", async () => {
    const graphStage: PipelineStage = {
      id: "connect", kind: "deterministic", label: "Connect", owns: ["graph"],
      async run() { return { partial: { graph: defaultGraph }, event: ev() }; },
    };
    const metricsStage: PipelineStage = {
      id: "analyze", kind: "deterministic", label: "Analyze", owns: ["metrics"],
      async run() { return { partial: { metrics: defaultMetrics }, event: ev() }; },
    };
    const client = mockClient([goodResponse(["src/index.ts"])]);
    const synthStage = createSynthesizeStage({ client, now: () => 1 });
    const exhausted = { async check() { return false; }, async record() {} };

    const { result } = await runPipeline([graphStage, metricsStage, synthStage], input, { now: makeClock(), budget: exhausted });

    expect(result.pipeline?.status).toBe("partial");
    expect(result.pipeline?.statusReason).toBe("budget-exhausted");
    expect(result.graph).toEqual(defaultGraph); // deterministic slice intact
    expect(result.ai).toBeUndefined();
    expect(client.calls).toHaveLength(0); // provider NOT called when exhausted
  });
});

function makeClock() {
  let t = 0;
  return () => ++t;
}
