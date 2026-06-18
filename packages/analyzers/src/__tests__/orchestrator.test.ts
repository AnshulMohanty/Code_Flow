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
