import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisCacheHandle,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  StageResult,
} from "@codeflow/shared-types";
import { assertAcyclic, computeLayers, describeSchedule, STAGE_READS } from "../pipeline/schedule.js";
import { createWarmupRegistry } from "../pipeline/warmup.js";
import { createSpeculator } from "../pipeline/speculation.js";
import { createRoutedLlmClient, maybeRouted, routeTier } from "../llm/modelRouter.js";
import { renderLatencyReport, summarizeTiers, timed } from "../bench/latencyTiers.js";
import { runPipeline } from "../pipeline/orchestrator.js";
import type { LlmClient } from "../llm/llmClient.js";

// V3-P5 task 1. The properties under test are the ones whose failure is a real regression: a
// schedule that changes the RESULT (the deterministic-spine invariant), a warm-up that reports ready
// when it is not, a speculation that leaks an unvalidated entry into the shared cache, and a router
// that silently downgrades a model.

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

/** A stage that records when it ran and optionally waits, so layering is observable. */
function fakeStage(
  id: PipelineStage["id"],
  owns: PipelineStage["owns"],
  options: { delayMs?: number; kind?: PipelineStage["kind"]; log?: string[]; fail?: boolean } = {},
): PipelineStage {
  return {
    id,
    kind: options.kind ?? "deterministic",
    label: id,
    owns,
    async run(_input: PipelineInput, ctx: PipelineContext): Promise<StageResult> {
      options.log?.push(`start:${id}`);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw new Error(`${id} failed`);
      options.log?.push(`end:${id}`);
      const partial: Record<string, unknown> = {};
      for (const key of owns) partial[key] = sliceFor(key, ctx);
      return {
        partial: partial as StageResult["partial"],
        event: {
          jobId: "job-1",
          stage: id,
          stageIndex: 1,
          stageCount: 1,
          kind: options.kind ?? "deterministic",
          status: "completed",
          label: id,
          progress: 0,
          startedAt: "",
          emittedAt: "",
        },
      };
    },
  };
}

/** A minimal but SHAPE-VALID slice per key, so the assembled result is comparable across modes. */
function sliceFor(key: string, ctx: PipelineContext): unknown {
  switch (key) {
    case "orientation":
      return { projectType: "library", languages: [], frameworks: [], readmeSummary: null };
    case "structure":
      return { layout: "flat", fileCount: 1, files: [{ path: "src/a.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 10 }] };
    case "inventory":
      return { symbols: [], entryPoints: [], symbolCount: 0, loc: { "src/a.ts": 5 } };
    case "graph":
      return {
        nodes: [{ id: "src/a.ts", path: "src/a.ts", name: "a.ts", layer: "source", language: "TypeScript", lines: 5, symbolCount: 0 }],
        edges: [],
        resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      };
    case "metrics":
      return {
        perFile: [],
        keyFiles: ["src/a.ts"],
        hotspots: [],
        cycles: [],
        summary: { fileCount: 1, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
      };
    case "aiSynthesis":
      // Reads `graph` so the test would catch a layer member seeing a torn snapshot.
      return { summary: `synth over ${ctx.prior.graph?.nodes.length ?? 0} node(s)`, readingOrder: [{ fileId: "src/a.ts", order: 1, reason: "r" }] };
    case "aiRag":
      return { chunks: [], chunkCount: 0, embeddingModel: "mock", embeddingDim: 3 };
    default:
      return {};
  }
}

/** The real pipeline shape: the linear deterministic chain, then the two AI stages. */
function fullStages(options: { log?: string[]; aiDelayMs?: number } = {}): PipelineStage[] {
  const ai = options.aiDelayMs !== undefined ? { delayMs: options.aiDelayMs } : {};
  return [
    fakeStage("ingest", [], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("orient", ["orientation"], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("map-structure", ["structure"], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("inventory", ["inventory"], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("connect", ["graph"], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("analyze", ["metrics"], { ...(options.log ? { log: options.log } : {}) }),
    fakeStage("synthesize", ["aiSynthesis"], { kind: "ai", ...ai, ...(options.log ? { log: options.log } : {}) }),
    fakeStage("rag", ["aiRag"], { kind: "ai", ...ai, ...(options.log ? { log: options.log } : {}) }),
  ];
}

function makeClock() {
  let t = 0;
  return () => ++t;
}

describe("computeLayers — the DAG, measured rather than assumed", () => {
  it("finds the ONE independent pair: rag becomes ready alongside analyze", () => {
    // The MEASURED shape, and it is not the one you would guess. The deterministic chain is linear
    // (every stage consumes the previous slice), and `rag` reads only {graph, structure, inventory}
    // — so it is ready as soon as `connect` lands, one layer BEFORE `synthesize`, which needs
    // `metrics`. That is exactly why the orchestrator schedules by READINESS rather than by layer
    // barriers: a barrier here would block `synthesize` behind `rag` finishing and serialise the two
    // slowest stages against each other.
    const plan = computeLayers(fullStages());
    expect(plan.shape).toEqual([1, 1, 1, 1, 1, 2, 1]);
    expect(plan.maxLayerWidth).toBe(2);
    expect(plan.hasParallelism).toBe(true);
    expect(plan.layers[5].stages.map((stage) => stage.id).sort()).toEqual(["analyze", "rag"]);
    expect(plan.layers[6].stages.map((stage) => stage.id)).toEqual(["synthesize"]);
  });

  it("puts ingest alone first, because it bootstraps ambient context rather than a slice", () => {
    const plan = computeLayers(fullStages());
    expect(plan.layers[0].stages.map((stage) => stage.id)).toEqual(["ingest"]);
  });

  it("IGNORES a dependency on a slice nobody in this run produces", () => {
    // Required, not lax: the pipeline legitimately runs without the AI stages, so `synthesize`'s
    // read of `metrics` must not deadlock a run where `analyze` was omitted.
    const withoutAnalyze = fullStages().filter((stage) => stage.id !== "analyze");
    const plan = computeLayers(withoutAnalyze);
    expect(plan.layers.reduce((sum, layer) => sum + layer.stages.length, 0)).toBe(withoutAnalyze.length);
    // With `metrics` unproduced, synthesize's read of it is not a dependency — so both AI stages
    // become ready together instead of the run deadlocking.
    expect(plan.layers.at(-1)?.stages.map((stage) => stage.id).sort()).toEqual(["rag", "synthesize"]);
  });

  it("reports fully sequential when only one AI stage is configured", () => {
    const oneAi = fullStages().filter((stage) => stage.id !== "rag");
    const plan = computeLayers(oneAi);
    expect(plan.maxLayerWidth).toBe(1);
    expect(plan.hasParallelism).toBe(false);
    expect(describeSchedule(plan)).toMatch(/fully sequential/);
  });

  it("does not HANG on a cyclic declaration — it emits the rest and can be asserted against", () => {
    // Silently hanging a production pipeline on a bad declaration would be the worst outcome, so
    // `computeLayers` stays total and `assertAcyclic` is the loud version for tests/boot.
    // A REAL cycle: `map-structure` reads `orientation` and here owns `inventory`, while `connect`
    // reads `inventory` and here owns `orientation`. Each waits on the other.
    const cyclic: PipelineStage[] = [fakeStage("map-structure", ["inventory"]), fakeStage("connect", ["orientation"])];
    const plan = computeLayers(cyclic);
    // Total rather than hanging: the remainder is emitted as one final layer.
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0].stages).toHaveLength(2);
    expect(() => assertAcyclic(cyclic)).toThrow(/same layer/);
  });

  it("assertAcyclic accepts the real pipeline and rejects a same-layer read", () => {
    expect(() => assertAcyclic(fullStages())).not.toThrow();
    // Two stages in one layer where one reads what the other owns is the invariant that makes
    // concurrent execution within a layer safe.
    const bad: PipelineStage[] = [fakeStage("orient", ["orientation"]), fakeStage("analyze", ["orientation"])];
    expect(() => assertAcyclic(bad)).toThrow(/both own the slice/);
  });

  it("declares reads for every stage id, so no stage is silently unscheduled", () => {
    for (const stage of fullStages()) expect(STAGE_READS[stage.id]).toBeDefined();
  });

  it("is deterministic and handles an empty stage list", () => {
    expect(JSON.stringify(computeLayers(fullStages()).shape)).toBe(JSON.stringify(computeLayers(fullStages()).shape));
    expect(computeLayers([]).shape).toEqual([]);
    expect(describeSchedule(computeLayers([]))).toMatch(/fully sequential/);
  });
});

describe("layered execution — the deterministic spine is UNCHANGED", () => {
  it("produces BYTE-IDENTICAL slices compared to the sequential run", async () => {
    // The invariant this whole feature had to clear. Each stage is launched with a snapshot holding
    // every slice it declared, slices are per-key and written by exactly one stage, and nothing
    // mutates one after assignment — so the RESULT cannot depend on scheduling.
    //
    // Per-stage TIMINGS are excluded, and that is not a loophole: `startedAt`/`durationMs` are
    // wall-clock facts about one particular execution, so a scheduler that changed nothing else
    // would still change them. The invariant is about the analysis, not about the stopwatch.
    const sequential = await runPipeline(fullStages(), input, { now: makeClock(), schedule: "sequential" });
    const layered = await runPipeline(fullStages(), input, { now: makeClock(), schedule: "layered" });
    expect(JSON.stringify(withoutTimings(layered.result))).toBe(JSON.stringify(withoutTimings(sequential.result)));
  });

  it("keeps per-stage RECORDS in declared order, not completion order", async () => {
    // Otherwise the run summary would reorder itself depending on which AI stage happened to finish
    // first, and two runs of the same input would not be comparable.
    const layered = await runPipeline(fullStages({ aiDelayMs: 10 }), input, { now: makeClock(), schedule: "layered" });
    expect(layered.result.pipeline?.stages.map((record) => record.stage)).toEqual([
      "ingest",
      "orient",
      "map-structure",
      "inventory",
      "connect",
      "analyze",
      "synthesize",
      "rag",
    ]);
  });

  it("actually OVERLAPS the two slow stages — synthesize runs WHILE rag does", async () => {
    // The point of the feature, and the thing a layer barrier could not do. `rag` starts right after
    // `connect`; `synthesize` starts the moment `metrics` lands — while `rag` is still in flight.
    const log: string[] = [];
    await runPipeline(fullStages({ log, aiDelayMs: 20 }), input, { now: makeClock(), schedule: "layered" });
    const startRag = log.indexOf("start:rag");
    const endRag = log.indexOf("end:rag");
    const startSynth = log.indexOf("start:synthesize");
    expect(startRag).toBeGreaterThanOrEqual(0);
    expect(startSynth).toBeGreaterThan(startRag);
    expect(startSynth).toBeLessThan(endRag); // synthesize started while rag was still running
  });

  it("does NOT overlap them in sequential mode", async () => {
    const log: string[] = [];
    await runPipeline(fullStages({ log, aiDelayMs: 5 }), input, { now: makeClock(), schedule: "sequential" });
    expect(log.indexOf("start:rag")).toBeGreaterThan(log.indexOf("end:synthesize"));
  });

  it("gives every layer member the SAME frozen prior snapshot", async () => {
    // Each launched stage gets its own ctx with its own `prior`. Without that, reaching the second
    // member would reassign a shared `ctx.prior` while the first was mid-await — a race that would
    // be invisible in a fast test and corrupting in production.
    const layered = await runPipeline(fullStages({ aiDelayMs: 5 }), input, { now: makeClock(), schedule: "layered" });
    // `aiSynthesis.summary` is built from `ctx.prior.graph`, so a torn snapshot would show up here.
    expect(layered.result.ai?.synthesis?.summary).toBe("synth over 1 node(s)");
  });

  it("applies the SAME error contract to a layered failure: AI failure ⇒ partial", async () => {
    const stages = fullStages();
    const failing = fakeStage("rag", ["aiRag"], { kind: "ai", fail: true });
    const withFailure = [...stages.slice(0, -1), failing];
    const layered = await runPipeline(withFailure, input, { now: makeClock(), schedule: "layered" });
    expect(layered.result.pipeline?.status).toBe("partial");
    expect(layered.result.ai?.synthesis).toBeDefined(); // the sibling still landed
    expect(layered.result.ai?.rag).toBeUndefined();
    expect(layered.result.warnings.some((warning) => warning.includes("rag"))).toBe(true);
  });

  it("matches the sequential error contract exactly, failure included", async () => {
    const build = () => {
      const stages = fullStages();
      return [...stages.slice(0, -1), fakeStage("rag", ["aiRag"], { kind: "ai", fail: true })];
    };
    const sequential = await runPipeline(build(), input, { now: makeClock(), schedule: "sequential" });
    const layered = await runPipeline(build(), input, { now: makeClock(), schedule: "layered" });
    expect(JSON.stringify(withoutTimings(layered.result))).toBe(JSON.stringify(withoutTimings(sequential.result)));
  });

  it("propagates a ctx MUTATION from Ingest, which a launched copy could not", async () => {
    // A real bug this caught: Ingest is the one stage that mutates `ctx` (resolving `repoPath` and
    // `commitSha`), and a launched stage gets its own `{...ctx, prior}` copy — so a launched Ingest
    // would mutate the copy and every later stage would see nothing. Ingest is therefore never
    // launched, which costs nothing because everything depends on it anyway.
    const seen: Array<string | undefined> = [];
    const ingest: PipelineStage = {
      id: "ingest",
      kind: "deterministic",
      label: "ingest",
      owns: [],
      async run(_input, ctx) {
        ctx.repoPath = "/resolved/by/ingest";
        ctx.commitSha = "sha-from-ingest";
        return {
          partial: {},
          event: { jobId: "job-1", stage: "ingest", stageIndex: 1, stageCount: 2, kind: "deterministic", status: "completed", label: "ingest", progress: 0, startedAt: "", emittedAt: "" },
        };
      },
    };
    const reader: PipelineStage = {
      id: "orient",
      kind: "deterministic",
      label: "orient",
      owns: ["orientation"],
      async run(_input, ctx) {
        seen.push(ctx.repoPath);
        return {
          partial: { orientation: sliceFor("orientation", ctx) as never },
          event: { jobId: "job-1", stage: "orient", stageIndex: 2, stageCount: 2, kind: "deterministic", status: "completed", label: "orient", progress: 0, startedAt: "", emittedAt: "" },
        };
      },
    };

    const layered = await runPipeline([ingest, reader], input, { now: makeClock(), schedule: "layered" });
    expect(seen).toEqual(["/resolved/by/ingest"]);
    expect(layered.result.commitSha).toBe("sha-from-ingest");
  });

  it("defaults to sequential when no schedule is given", async () => {
    const log: string[] = [];
    await runPipeline(fullStages({ log, aiDelayMs: 5 }), input, { now: makeClock() });
    expect(log.indexOf("start:rag")).toBeGreaterThan(log.indexOf("end:synthesize"));
  });
});

describe("createWarmupRegistry", () => {
  it("runs tasks CONCURRENTLY and reports per-task timing", async () => {
    // Warming one at a time would make the cold start the sum rather than the max — at exactly the
    // moment the process has no time to spare.
    let inFlight = 0;
    let peak = 0;
    const registry = createWarmupRegistry();
    for (const name of ["grammars", "providers", "stores"]) {
      registry.register({
        name,
        async run() {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight -= 1;
        },
      });
    }
    const state = await registry.warmUp();
    expect(peak).toBeGreaterThan(1);
    expect(state.warmedUp).toBe(true);
    expect(state.tasks.map((task) => task.name)).toEqual(["grammars", "providers", "stores"]);
  });

  it("an EMPTY registry is NOT warm — 'nothing to do' and 'ready' are different claims", async () => {
    // Reporting an unconfigured process as ready is how a misconfiguration reaches users.
    const registry = createWarmupRegistry();
    expect((await registry.warmUp()).warmedUp).toBe(false);
    expect(registry.state().warmedUp).toBe(false);
  });

  it("is idempotent and shares one in-flight promise across racing callers", async () => {
    let runs = 0;
    const registry = createWarmupRegistry();
    registry.register({
      name: "once",
      async run() {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    await Promise.all([registry.warmUp(), registry.warmUp(), registry.warmUp()]);
    expect(runs).toBe(1);
    await registry.warmUp(); // already warm ⇒ still not re-run
    expect(runs).toBe(1);
  });

  it("a FAILED required task leaves the process not-warm, but does NOT throw", async () => {
    // Throwing would take a process down at boot over an optimisation, and the cold path works.
    const warnings: string[] = [];
    const registry = createWarmupRegistry({ logger: { info() {}, warn: (message) => warnings.push(message) } });
    registry.register({
      name: "broken",
      async run() {
        throw new Error("wasm load failed");
      },
    });
    const state = await registry.warmUp();
    expect(state.warmedUp).toBe(false);
    expect(state.tasks[0]).toMatchObject({ status: "failed", error: "wasm load failed" });
    expect(warnings.join(" ")).toMatch(/broken/);
  });

  it("a failed NON-REQUIRED task still leaves the process warm", async () => {
    // Failing to pre-connect to Postgres must not stop the deterministic pipeline from serving,
    // because that pipeline does not need Postgres.
    const registry = createWarmupRegistry();
    registry.register({ name: "essential", async run() {} });
    registry.register({
      name: "optional",
      required: false,
      async run() {
        throw new Error("no postgres");
      },
    });
    const state = await registry.warmUp();
    expect(state.warmedUp).toBe(true);
    expect(state.tasks.find((task) => task.name === "optional")?.status).toBe("failed");
  });

  it("re-registering a name replaces rather than duplicating", async () => {
    const registry = createWarmupRegistry();
    let which = "";
    registry.register({ name: "dup", async run() { which = "first"; } });
    registry.register({ name: "dup", async run() { which = "second"; } });
    const state = await registry.warmUp();
    expect(state.tasks).toHaveLength(1);
    expect(which).toBe("second");
  });

  it("records total duration and a warmedAt stamp from the injected clocks", async () => {
    let t = 0;
    const registry = createWarmupRegistry({ now: () => (t += 10), isoNow: () => "2026-08-31T00:00:00.000Z" });
    registry.register({ name: "x", async run() {} });
    const state = await registry.warmUp();
    expect(state.durationMs).toBeGreaterThan(0);
    expect(state.warmedAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("reset forgets everything", async () => {
    const registry = createWarmupRegistry();
    registry.register({ name: "x", async run() {} });
    await registry.warmUp();
    registry.reset();
    expect(registry.state().tasks).toEqual([]);
    expect(registry.state().warmedUp).toBe(false);
  });
});

describe("createSpeculator — a wrong guess costs CPU and NOTHING else", () => {
  function memCache(): AnalysisCacheHandle & { store: Map<string, unknown> } {
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

  it("NEVER writes an unclaimed speculation into the shared cache", async () => {
    // The correctness hazard this exists to prevent: an entry nothing validated could be SERVED to
    // the next real request, indistinguishable from a real one.
    const cache = memCache();
    const speculator = createSpeculator({ cache });
    speculator.speculate({ key: "guessed", label: "who-calls a.ts", compute: async () => ({ answer: 1 }) });
    const stats = await speculator.commit();
    expect(cache.store.size).toBe(0);
    expect(stats.discarded).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it("promotes ONLY what a real request claimed", async () => {
    const cache = memCache();
    const speculator = createSpeculator({ cache });
    speculator.speculate({ key: "wanted", label: "wanted", compute: async () => "W" });
    speculator.speculate({ key: "unwanted", label: "unwanted", compute: async () => "U" });

    expect(await speculator.claim<string>("wanted")).toBe("W");
    const stats = await speculator.commit();
    expect([...cache.store.keys()]).toEqual(["wanted"]);
    expect(stats.hits).toBe(1);
    expect(stats.discarded).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("rollback promotes nothing at all, even something claimed", async () => {
    const cache = memCache();
    const speculator = createSpeculator({ cache });
    speculator.speculate({ key: "k", label: "k", compute: async () => "V" });
    await speculator.claim("k");
    const stats = speculator.rollback();
    expect(cache.store.size).toBe(0);
    expect(stats.hits).toBe(0);
  });

  it("claim returns null for a key nothing speculated", async () => {
    const speculator = createSpeculator({ cache: memCache() });
    expect(await speculator.claim("never-guessed")).toBeNull();
  });

  it("a FAILED speculation is a non-event: recorded, swallowed, never promoted", async () => {
    // Letting it reject would turn an optimisation into an unhandled rejection that can take the
    // process down — the opposite of what a latency feature should do.
    const cache = memCache();
    const warnings: string[] = [];
    const speculator = createSpeculator({ cache, logger: { warn: (message) => warnings.push(message) } });
    speculator.speculate({
      key: "boom",
      label: "boom",
      compute: async () => {
        throw new Error("graph not ready");
      },
    });
    expect(await speculator.claim("boom")).toBeNull();
    const stats = await speculator.commit();
    expect(stats.failed).toBe(1);
    expect(cache.store.size).toBe(0);
    expect(warnings.join(" ")).toMatch(/boom/);
  });

  it("does not speculate the same key twice", async () => {
    let computed = 0;
    const speculator = createSpeculator({ cache: memCache() });
    const task = {
      key: "same",
      label: "same",
      compute: async () => {
        computed += 1;
        return 1;
      },
    };
    speculator.speculate(task);
    speculator.speculate(task);
    await speculator.claim("same");
    await speculator.commit();
    expect(computed).toBe(1);
  });

  it("BOUNDS concurrency, so speculation cannot starve the real work", async () => {
    let inFlight = 0;
    let peak = 0;
    const speculator = createSpeculator({ cache: memCache(), maxConcurrent: 2 });
    for (let i = 0; i < 6; i++) {
      speculator.speculate({
        key: `k${i}`,
        label: `k${i}`,
        compute: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 3));
          inFlight -= 1;
          return i;
        },
      });
    }
    for (let i = 0; i < 6; i++) await speculator.claim(`k${i}`);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("reports a hit rate — the number that decides whether speculating is worth doing", async () => {
    const speculator = createSpeculator({ cache: memCache() });
    for (let i = 0; i < 4; i++) speculator.speculate({ key: `k${i}`, label: `k${i}`, compute: async () => i });
    await speculator.claim("k0");
    const stats = await speculator.commit();
    expect(stats.hitRate).toBe(0.25);
    expect(stats.labels.hit).toEqual(["k0"]);
    expect(stats.labels.discarded).toEqual(["k1", "k2", "k3"]);
  });
});

describe("model routing", () => {
  function client(provider: LlmClient["provider"], model: string, calls: string[]): LlmClient {
    return {
      provider,
      model,
      async complete(request) {
        calls.push(`${model}:${request.prompt}`);
        return { text: "{}", usage: { inputTokens: 1, outputTokens: 1, measured: true } };
      },
    };
  }

  it("routes a simple specialist to FAST and a supervisor to FRONTIER", () => {
    expect(routeTier({ task: "specialist", complexity: 0.1 }).tier).toBe("fast");
    expect(routeTier({ task: "supervisor" }).tier).toBe("frontier");
    expect(routeTier({ task: "classification" }).tier).toBe("fast");
  });

  it("ESCALATES a specialist on a complex community, using P4's own threshold", () => {
    // One decision, not two: "hard enough for best-of-N" and "hard enough for the better model"
    // share a threshold so they cannot drift apart.
    expect(routeTier({ task: "specialist", complexity: 0.7 }, 0.6).tier).toBe("frontier");
    expect(routeTier({ task: "specialist", complexity: 0.59 }, 0.6).tier).toBe("fast");
  });

  it("defaults an UN-HINTED call to frontier, never down", () => {
    // Defaulting down would silently downgrade every call site not yet updated — a quality
    // regression nobody asked for and nobody would see in a diff.
    expect(routeTier(undefined).tier).toBe("frontier");
    expect(routeTier(undefined).reason).toMatch(/never down/);
  });

  it("IS an LlmClient, so no call site changes", async () => {
    const calls: string[] = [];
    const routed = createRoutedLlmClient({
      fast: client("gemini", "flash", calls),
      frontier: client("anthropic", "opus", calls),
    });
    await routed.complete({ prompt: "cheap", routing: { task: "specialist", complexity: 0.1 } });
    await routed.complete({ prompt: "hard", routing: { task: "supervisor" } });
    expect(calls).toEqual(["flash:cheap", "opus:hard"]);
  });

  it("STRIPS the routing hint before delegating", async () => {
    // It is routing metadata; a provider adapter receiving an unknown field would ignore or reject it.
    let seen: unknown = null;
    const capture: LlmClient = {
      provider: "gemini",
      model: "flash",
      async complete(request) {
        seen = request.routing;
        return { text: "{}", usage: { inputTokens: 1, outputTokens: 1, measured: true } };
      },
    };
    const routed = createRoutedLlmClient({ fast: capture, frontier: capture });
    await routed.complete({ prompt: "p", routing: { task: "classification" } });
    expect(seen).toBeUndefined();
  });

  it("scopes its model string across BOTH tiers, so a cache key cannot collide", async () => {
    // Two tiers sharing one cache key would let a fast-model completion be served to a
    // frontier-model call.
    const calls: string[] = [];
    const routed = createRoutedLlmClient({
      fast: client("gemini", "flash", calls),
      frontier: client("anthropic", "opus", calls),
    });
    expect(routed.model).toBe("opus+fast:flash");
    expect(routed.model).toContain("flash");
  });

  it("records every decision, so a mixed-tier run is auditable", async () => {
    const calls: string[] = [];
    const decisions: string[] = [];
    const routed = createRoutedLlmClient({
      fast: client("gemini", "flash", calls),
      frontier: client("anthropic", "opus", calls),
      onDecision: (decision) => decisions.push(`${decision.task}:${decision.tier}:${decision.model}`),
    });
    await routed.complete({ prompt: "a", routing: { task: "specialist", complexity: 0.9 } });
    await routed.complete({ prompt: "b", routing: { task: "specialist", complexity: 0.1 } });
    expect(decisions).toEqual(["specialist:frontier:opus", "specialist:fast:flash"]);
    expect(routed.decisions).toHaveLength(2);
    expect(routed.decisions[0].reason).toMatch(/complex community/);
  });

  it("maybeRouted returns the client UNWRAPPED when there is only one tier", () => {
    // Wrapping one client in a router that always picks it would report a two-tier model string and
    // invalidate the existing cache for no benefit.
    const calls: string[] = [];
    const only = client("gemini", "flash", calls);
    expect(maybeRouted(only, null)).toBe(only);
    expect(maybeRouted(null, only)).toBe(only);
    expect(maybeRouted(null, null)).toBeNull();
    // Same provider AND model ⇒ not two tiers.
    const same = client("gemini", "flash", calls);
    expect(maybeRouted(only, same)).toBe(same);
  });

  it("maybeRouted wraps only when the tiers genuinely differ", () => {
    const calls: string[] = [];
    const routed = maybeRouted(client("gemini", "flash", calls), client("anthropic", "opus", calls));
    expect(routed?.model).toBe("opus+fast:flash");
  });
});

describe("latency tiers", () => {
  it("summarises with a MEDIAN, not a mean, and keeps the spread visible", () => {
    // A bench on a shared machine picks up scheduler noise as occasional large outliers, and a mean
    // lets one of those dominate the headline.
    const tiers = summarizeTiers([
      { tier: "coreAnalysis", ms: 10, conditions: "c" },
      { tier: "coreAnalysis", ms: 12, conditions: "c" },
      { tier: "coreAnalysis", ms: 900, conditions: "c" },
    ]);
    expect(tiers.coreAnalysis).toEqual({ best: 10, median: 12, worst: 900, runs: 3 });
  });

  it("reports an unsampled tier as unsampled rather than as zero", () => {
    const tiers = summarizeTiers([{ tier: "qaCoreHit", ms: 1, conditions: "cached" }]);
    expect(tiers.qaGenerate).toBeNull();
    expect(renderLatencyReport({ samples: [], tiers, notes: [] })).toMatch(/qaGenerate\s+not sampled/);
  });

  it("renders all four tiers and the schedule comparison", () => {
    const rendered = renderLatencyReport({
      samples: [],
      tiers: summarizeTiers([
        { tier: "coreAnalysis", ms: 5, conditions: "c" },
        { tier: "aiSynthesis", ms: 40, conditions: "c" },
        { tier: "qaCoreHit", ms: 1, conditions: "c" },
        { tier: "qaGenerate", ms: 30, conditions: "c" },
      ]),
      scheduleComparison: { sequentialMs: 80, layeredMs: 42, speedup: 1.9 },
      notes: ["mock providers"],
    });
    for (const tier of ["coreAnalysis", "aiSynthesis", "qaCoreHit", "qaGenerate"]) expect(rendered).toContain(tier);
    expect(rendered).toMatch(/sequential 80ms → layered 42ms\s+\(1\.90x\)/);
    expect(rendered).toContain("note: mock providers");
  });

  it("timed returns the value AND the span, so measuring never costs the result", async () => {
    const { value, ms } = await timed(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "done";
    });
    expect(value).toBe("done");
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});

describe("the layered schedule is measurably faster (the acceptance number)", () => {
  it("beats sequential in wall-clock on the AI layer", async () => {
    // Reported with a generous margin because it IS timing-dependent; the OVERLAP assertion above
    // is the exact, non-flaky gate.
    const delay = 25;
    const sequential = await timed(() =>
      runPipeline(fullStages({ aiDelayMs: delay }), input, { now: makeClock(), schedule: "sequential" }),
    );
    const layered = await timed(() =>
      runPipeline(fullStages({ aiDelayMs: delay }), input, { now: makeClock(), schedule: "layered" }),
    );
    expect(layered.ms).toBeLessThan(sequential.ms);
    // Both AI stages take `delay`; sequential pays 2x, readiness scheduling overlaps them so the
    // layered run pays roughly 1x.
    expect(sequential.ms).toBeGreaterThanOrEqual(delay * 2);
    expect(layered.ms).toBeLessThan(delay * 2);
  });
});

/**
 * Strip per-stage wall-clock fields before comparing two runs.
 *
 * `startedAt`/`durationMs` are facts about one execution, not about the analysis — a scheduler that
 * changed nothing else would still change them. The deterministic-spine invariant is about the
 * SLICES, and this makes the comparison say exactly that.
 */
function withoutTimings(result: Awaited<ReturnType<typeof runPipeline>>["result"]) {
  return {
    ...result,
    createdAt: "",
    pipeline: result.pipeline
      ? {
          ...result.pipeline,
          startedAt: "",
          completedAt: "",
          stages: result.pipeline.stages.map((record) => ({ ...record, startedAt: undefined, durationMs: undefined })),
        }
      : result.pipeline,
  };
}
