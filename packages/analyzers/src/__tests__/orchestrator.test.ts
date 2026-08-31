import { describe, expect, it } from "vitest";
import type {
  AnalysisResult,
  DependencyEdge,
  FileNode,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  StageKind,
} from "@codeflow/shared-types";
import { runPipeline } from "../pipeline/orchestrator.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "facebook", name: "react" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

const fileNode: FileNode = { id: "file-1", path: "a.ts", name: "a.ts", layer: "source", language: "TypeScript", lines: 1 };
const edge: DependencyEdge = { id: "edge-1", source: "file-1", target: "file-2", kind: "import", weight: 1 };

function makeClock() {
  let t = 0;
  return () => ++t;
}

function ev(stage: ProgressEvent["stage"], kind: StageKind): ProgressEvent {
  return {
    jobId: "job-1",
    stage,
    stageIndex: 0,
    stageCount: 0,
    kind,
    status: "completed",
    label: String(stage),
    progress: 0,
    startedAt: "",
    emittedAt: "",
  };
}

describe("runPipeline — ordering & per-key assembly", () => {
  it("runs stages in declared order and assembles by per-key slice assignment", async () => {
    const order: string[] = [];
    const events: ProgressEvent[] = [];

    const stageFiles: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map structure",
      owns: ["files"],
      async run() {
        order.push("map-structure");
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };
    const stageDeps: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["dependencies"],
      async run() {
        order.push("connect");
        return { partial: { dependencies: [edge] }, event: ev("connect", "deterministic") };
      },
    };
    const stageAi: PipelineStage = {
      id: "synthesize",
      kind: "ai",
      label: "Synthesize",
      owns: ["aiSynthesis"],
      async run() {
        order.push("synthesize");
        return {
          partial: { aiSynthesis: { summary: "start here", readingOrder: [] } },
          event: ev("synthesize", "ai"),
        };
      },
    };

    const { result, cached } = await runPipeline([stageFiles, stageDeps, stageAi], input, {
      emit: (e) => events.push(e),
      now: makeClock(),
    });

    expect(order).toEqual(["map-structure", "connect", "synthesize"]);
    expect(cached).toBe(false);

    // per-key assignment: each slice landed on its own field, no clobbering
    expect(result.files).toEqual([fileNode]);
    expect(result.dependencies).toEqual([edge]);
    // AI output is in the clearly-separated `ai` slice, not at top level
    expect(result.ai?.synthesis?.summary).toBe("start here");
    // required field not produced this run gets an honest empty default
    expect(result.symbols).toEqual([]);
    expect(result.summary.healthScore).toBeNull();

    expect(result.pipeline?.status).toBe("completed");
    expect(result.pipeline?.stages.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);

    // one event per stage, with authoritative index/count/timing
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.stageIndex)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.stageCount === 3)).toBe(true);
    expect(events.every((e) => e.status === "completed")).toBe(true);
    expect(events.every((e) => typeof e.durationMs === "number")).toBe(true);
  });
});

describe("runPipeline — error contract", () => {
  it("deterministic failure → run 'failed', dependents skipped, partial result returned", async () => {
    const events: ProgressEvent[] = [];
    const ranC = { value: false };

    const stageA: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };
    const stageBoom: PipelineStage = {
      id: "inventory",
      kind: "deterministic",
      label: "Inventory",
      owns: ["symbols"],
      async run() {
        throw new Error("boom");
      },
    };
    const stageC: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["dependencies"],
      async run() {
        ranC.value = true;
        return { partial: { dependencies: [edge] }, event: ev("connect", "deterministic") };
      },
    };

    const { result } = await runPipeline([stageA, stageBoom, stageC], input, {
      emit: (e) => events.push(e),
      now: makeClock(),
    });

    expect(ranC.value).toBe(false); // dependent skipped
    expect(result.pipeline?.status).toBe("failed");
    expect(result.pipeline?.stages.map((s) => s.status)).toEqual(["completed", "failed", "skipped"]);
    expect(result.files).toEqual([fileNode]); // partial result preserved
    expect(result.dependencies).toEqual([]); // never produced
    expect(result.warnings.some((w) => w.includes("inventory") && w.includes("boom"))).toBe(true);
    expect(events.map((e) => e.status)).toEqual(["completed", "failed", "skipped"]);
    expect(events[1].error?.message).toBe("boom");
  });

  it("AI failure → run 'partial', deterministic result intact, ai unset", async () => {
    const ranAfter = { value: false };

    const stageDet: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };
    const stageAi: PipelineStage = {
      id: "synthesize",
      kind: "ai",
      label: "Synthesize",
      owns: ["aiSynthesis"],
      async run() {
        throw new Error("llm down");
      },
    };
    const stageDet2: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["dependencies"],
      async run() {
        ranAfter.value = true;
        return { partial: { dependencies: [edge] }, event: ev("connect", "deterministic") };
      },
    };

    const { result } = await runPipeline([stageDet, stageAi, stageDet2], input, { now: makeClock() });

    expect(ranAfter.value).toBe(true); // AI failure does NOT stop deterministic stages
    expect(result.pipeline?.status).toBe("partial");
    expect(result.files).toEqual([fileNode]);
    expect(result.dependencies).toEqual([edge]);
    expect(result.ai).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("synthesize") && w.includes("llm down"))).toBe(true);
  });

  it("abort signal → remaining stages skipped, run 'aborted'", async () => {
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const ranB = { value: false };

    const stageA: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        const out = { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
        controller.abort(); // cancel mid-run
        return out;
      },
    };
    const stageB: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["dependencies"],
      async run() {
        ranB.value = true;
        return { partial: { dependencies: [edge] }, event: ev("connect", "deterministic") };
      },
    };

    const { result } = await runPipeline([stageA, stageB], input, {
      emit: (e) => events.push(e),
      signal: controller.signal,
      now: makeClock(),
    });

    expect(ranB.value).toBe(false);
    expect(result.pipeline?.stages.map((s) => s.status)).toEqual(["completed", "skipped"]);
    expect(result.pipeline?.status).toBe("aborted");
    expect(result.warnings.some((w) => w.includes("aborted"))).toBe(true);
    expect(events.map((e) => e.status)).toEqual(["completed", "skipped"]);
  });
});

describe("runPipeline — projectType reconciliation (orchestrator-owned)", () => {
  const orientLike = (projectType: "library" | "application" | "cli"): PipelineStage => ({
    id: "orient",
    kind: "deterministic",
    label: "Orient",
    owns: ["orientation"],
    async run() {
      return {
        partial: { orientation: { languages: [], frameworks: [], projectType, manifests: [], readme: null } },
        event: ev("orient", "deterministic"),
      };
    },
  });
  const inventoryLike = (signal?: { projectType: "cli"; evidence: "package-json-bin" }): PipelineStage => ({
    id: "inventory",
    kind: "deterministic",
    label: "Inventory",
    owns: ["inventory"],
    async run() {
      return {
        partial: {
          inventory: { symbols: [], entryPoints: [], symbolCount: 0, loc: {}, ...(signal ? { projectTypeSignal: signal } : {}) },
        },
        event: ev("inventory", "deterministic"),
      };
    },
  });

  it("Inventory hard evidence (bin) overrides Orient's heuristic on the single canonical field", async () => {
    const { result } = await runPipeline(
      [orientLike("library"), inventoryLike({ projectType: "cli", evidence: "package-json-bin" })],
      input,
      { now: makeClock() },
    );

    expect(result.orientation?.projectType).toBe("cli"); // reconciled
    // Exactly ONE projectType field: orientation owns it; Inventory exposes only a SIGNAL.
    expect((result.inventory as unknown as { projectType?: unknown }).projectType).toBeUndefined();
    expect(result.inventory?.projectTypeSignal?.projectType).toBe("cli");
  });

  it("no contradicting evidence → Orient's heuristic is preserved", async () => {
    const { result } = await runPipeline([orientLike("library"), inventoryLike(undefined)], input, {
      now: makeClock(),
    });
    expect(result.orientation?.projectType).toBe("library");
  });
});

describe("runPipeline — cache short-circuit (orchestrator-owned)", () => {
  it("after the SHA is resolved, a covering cache hit returns the cached result and skips the rest", async () => {
    // producedBy covers the configured pipeline [ingest, map-structure] → HIT.
    const cached = { id: "cached-1", commitSha: "resolved-sha", producedBy: ["ingest", "map-structure"] } as unknown as AnalysisResult;
    const ranLater = { value: false };

    // A stand-in for Ingest: writes ctx.commitSha, owns no slice.
    const ingestLike: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "Ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.commitSha = "resolved-sha";
        return { partial: {}, event: ev("ingest", "deterministic") };
      },
    };
    const laterStage: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        ranLater.value = true;
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };

    const { result, cached: wasCached } = await runPipeline([ingestLike, laterStage], input, {
      now: makeClock(),
      cacheLookup: {
        findCached: async ({ commitSha }) => (commitSha === "resolved-sha" ? cached : null),
      },
    });

    expect(wasCached).toBe(true);
    expect(result).toBe(cached);
    expect(ranLater.value).toBe(false); // remaining stages skipped on cache hit
  });

  it("a cached result from a smaller pipeline is stale → miss → real re-run", async () => {
    // Ingest-only envelope (e.g. saved before map-structure existed) does NOT cover the
    // configured [ingest, map-structure] pipeline.
    const stale = { id: "stale-1", commitSha: "resolved-sha", producedBy: ["ingest"] } as unknown as AnalysisResult;
    const ranLater = { value: false };
    const ingestLike: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "Ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.commitSha = "resolved-sha";
        return { partial: {}, event: ev("ingest", "deterministic") };
      },
    };
    const laterStage: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        ranLater.value = true;
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };

    const { result, cached } = await runPipeline([ingestLike, laterStage], input, {
      now: makeClock(),
      cacheLookup: { findCached: async () => stale },
    });

    expect(cached).toBe(false); // stale → miss
    expect(ranLater.value).toBe(true); // re-ran the rest
    expect(result.files).toEqual([fileNode]);
    // a fresh run is stamped with the full configured set
    expect(result.producedBy).toEqual(["ingest", "map-structure"]);
  });

  it("an unstamped (legacy) cached result is treated as a miss", async () => {
    const legacy = { id: "legacy-1", commitSha: "resolved-sha" } as unknown as AnalysisResult; // no producedBy
    const ranLater = { value: false };
    const ingestLike: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "Ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.commitSha = "resolved-sha";
        return { partial: {}, event: ev("ingest", "deterministic") };
      },
    };
    const laterStage: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        ranLater.value = true;
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };

    const { cached } = await runPipeline([ingestLike, laterStage], input, {
      now: makeClock(),
      cacheLookup: { findCached: async () => legacy },
    });

    expect(cached).toBe(false);
    expect(ranLater.value).toBe(true);
  });

  it("cache miss continues the run normally", async () => {
    const ranLater = { value: false };
    const ingestLike: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "Ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.commitSha = "resolved-sha";
        return { partial: {}, event: ev("ingest", "deterministic") };
      },
    };
    const laterStage: PipelineStage = {
      id: "map-structure",
      kind: "deterministic",
      label: "Map",
      owns: ["files"],
      async run() {
        ranLater.value = true;
        return { partial: { files: [fileNode] }, event: ev("map-structure", "deterministic") };
      },
    };

    const { result, cached } = await runPipeline([ingestLike, laterStage], input, {
      now: makeClock(),
      cacheLookup: { findCached: async () => null },
    });

    expect(cached).toBe(false);
    expect(ranLater.value).toBe(true);
    expect(result.files).toEqual([fileNode]);
    expect(result.pipeline?.status).toBe("completed");
  });
});

// ── V3-P5 task 1: SPECULATIVE PREFETCH, on the live orchestrator path (wired V3-FINAL) ──
//
// `createSpeculator` shipped in V3-P5 with a full suite and ZERO production call sites: no stage
// declared a speculation and the orchestrator created no speculator, so the staging layer and its
// rollback existed and could never fire. These assertions are about the LIVE wiring — that a
// stage's declaration is launched during a window the orchestrator identifies, that the stage claims
// it, that a claim reaches the shared cache only through `commit()`, and that a failed run rolls
// back.

/** A stage that DECLARES a speculation and CLAIMS it when it runs. */
function speculatingStage(options: {
  key: string;
  onCompute?: () => void;
  computeThrows?: boolean;
  declareThrows?: boolean;
  claimed: { value: unknown };
}): PipelineStage {
  return {
    id: "rag",
    kind: "ai",
    label: "Rag-like",
    owns: ["aiRag"],
    speculations() {
      if (options.declareThrows) throw new Error("declaration exploded");
      return [
        {
          key: options.key,
          label: "test plan",
          async compute() {
            options.onCompute?.();
            if (options.computeThrows) throw new Error("compute exploded");
            return { chunks: ["a", "b"] };
          },
        },
      ];
    },
    async run(_input, ctx) {
      options.claimed.value = ctx.speculator ? await ctx.speculator.claim(options.key) : "no-speculator";
      return { partial: {}, event: ev("rag", "ai") };
    },
  } as PipelineStage;
}

function memCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T = unknown>(key: string) {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
    },
  };
}

describe("runPipeline — speculative prefetch (orchestrator-owned window)", () => {
  it("launches a stage's DECLARED speculation and the stage CLAIMS it", async () => {
    const claimed = { value: undefined as unknown };
    let computes = 0;
    const stage = speculatingStage({ key: "plan/1", claimed, onCompute: () => (computes += 1) });

    const { speculation } = await runPipeline([stage], input, { now: makeClock(), cache: memCache() });

    expect(claimed.value).toEqual({ chunks: ["a", "b"] });
    expect(computes).toBe(1); // computed ONCE — claim awaits the in-flight task, never races it
    expect(speculation).toMatchObject({ launched: 1, hits: 1, discarded: 0, failed: 0, hitRate: 1 });
  });

  it("promotes a CLAIMED key into the shared cache, and only on commit", async () => {
    const cache = memCache();
    const claimed = { value: undefined as unknown };
    await runPipeline([speculatingStage({ key: "plan/1", claimed })], input, { now: makeClock(), cache });
    expect(cache.store.get("plan/1")).toEqual({ chunks: ["a", "b"] });
  });

  it("NEVER writes an UNCLAIMED speculation to the shared cache", async () => {
    // The correctness hazard the staging layer exists for: an entry no real request validated must
    // not be servable to the next one.
    const cache = memCache();
    const stage = speculatingStage({ key: "plan/1", claimed: { value: undefined } });
    const nonClaiming: PipelineStage = {
      ...stage,
      async run() {
        return { partial: {}, event: ev("rag", "ai") };
      },
    };

    const { speculation } = await runPipeline([nonClaiming], input, { now: makeClock(), cache });
    expect(cache.store.has("plan/1")).toBe(false);
    expect(speculation).toMatchObject({ launched: 1, hits: 0, discarded: 1, hitRate: 0 });
  });

  it("ROLLS BACK on a failed deterministic stage — a wrong guess costs CPU and nothing else", async () => {
    const cache = memCache();
    const claimed = { value: undefined as unknown };
    const failing: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["graph"],
      async run() {
        throw new Error("connect blew up");
      },
    };
    // The speculating stage is declared AFTER the failure, so it never runs and never claims.
    const { result, speculation } = await runPipeline(
      [failing, speculatingStage({ key: "plan/1", claimed })],
      input,
      { now: makeClock(), cache },
    );

    expect(result.pipeline?.status).toBe("failed");
    expect(cache.store.has("plan/1")).toBe(false);
    expect(speculation?.hits).toBe(0);
  });

  it("a speculation that THROWS is a non-event: the run completes and the stage sees a miss", async () => {
    const claimed = { value: undefined as unknown };
    const { result, speculation } = await runPipeline(
      [speculatingStage({ key: "plan/1", claimed, computeThrows: true })],
      input,
      { now: makeClock(), cache: memCache() },
    );
    expect(result.pipeline?.status).toBe("completed");
    expect(claimed.value).toBeNull(); // a failed speculation reads as a MISS, not as a value
    expect(speculation).toMatchObject({ launched: 1, hits: 0, failed: 1 });
  });

  it("a DECLARATION that throws is also a non-event", async () => {
    const claimed = { value: undefined as unknown };
    const { result, speculation } = await runPipeline(
      [speculatingStage({ key: "plan/1", claimed, declareThrows: true })],
      input,
      { now: makeClock(), cache: memCache() },
    );
    expect(result.pipeline?.status).toBe("completed");
    expect(speculation?.launched).toBe(0);
  });

  it("speculate:false creates no speculator at all — ctx.speculator is ABSENT", async () => {
    const claimed = { value: undefined as unknown };
    let computes = 0;
    const { speculation } = await runPipeline(
      [speculatingStage({ key: "plan/1", claimed, onCompute: () => (computes += 1) })],
      input,
      { now: makeClock(), cache: memCache(), speculate: false },
    );
    expect(claimed.value).toBe("no-speculator");
    expect(computes).toBe(0);
    expect(speculation).toBeUndefined();
  });

  it("does not ask a stage to declare until its reads are satisfied", async () => {
    // The window is "could run but has not started". A stage waiting on a slice could NOT run, and
    // speculating from an incomplete snapshot is how a staged value stops matching the real one.
    let declaredWithGraph: boolean | null = null;
    const producer: PipelineStage = {
      id: "connect",
      kind: "deterministic",
      label: "Connect",
      owns: ["graph"],
      async run() {
        return {
          partial: {
            graph: {
              nodes: [],
              edges: [],
              resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
            },
          },
          event: ev("connect", "deterministic"),
        };
      },
    };
    const consumer = {
      id: "analyze",
      kind: "deterministic" as const,
      label: "Analyze",
      owns: ["metrics"] as const,
      speculations(context: { prior: unknown }) {
        declaredWithGraph = Boolean((context.prior as { graph?: unknown }).graph);
        return [];
      },
      async run() {
        return { partial: {}, event: ev("analyze", "deterministic") };
      },
    } as unknown as PipelineStage;

    await runPipeline([producer, consumer], input, { now: makeClock(), cache: memCache() });
    // `analyze` reads `graph`, so its declaration is only ever asked for once `connect` has settled.
    expect(declaredWithGraph).toBe(true);
  });

  it("ROLLS BACK on a post-ingest cache full hit — no stage ran, so nothing was validated", async () => {
    const cache = memCache();
    const cached = { id: "c", commitSha: "sha-1", producedBy: ["ingest", "rag"] } as unknown as AnalysisResult;
    const ingestLike: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "Ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.commitSha = "sha-1";
        return { partial: {}, event: ev("ingest", "deterministic") };
      },
    };
    const { cached: wasCached } = await runPipeline(
      [ingestLike, speculatingStage({ key: "plan/1", claimed: { value: undefined } })],
      input,
      { now: makeClock(), cache, cacheLookup: { findCached: async () => cached } },
    );
    expect(wasCached).toBe(true);
    expect(cache.store.has("plan/1")).toBe(false);
  });

  it("reports a hit RATE, so a speculation that never pays off is visible rather than assumed", async () => {
    const claimed = { value: undefined as unknown };
    const claiming = speculatingStage({ key: "plan/1", claimed });
    const other = speculatingStage({ key: "plan/2", claimed: { value: undefined } });
    const nonClaiming = {
      ...other,
      id: "synthesize",
      owns: ["aiSynthesis"],
      async run() {
        return { partial: {}, event: ev("synthesize", "ai") };
      },
    } as PipelineStage;

    const { speculation } = await runPipeline([nonClaiming, claiming], input, { now: makeClock(), cache: memCache() });
    expect(speculation).toMatchObject({ launched: 2, hits: 1, discarded: 1 });
    expect(speculation?.hitRate).toBeCloseTo(0.5, 6);
  });
});
