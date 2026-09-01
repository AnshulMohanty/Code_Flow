import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisCacheHandle,
  AnalysisResultSlices,
  BudgetHandle,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  Synthesis,
} from "@codeflow/shared-types";
import { createAdaptiveSynthesizeStage } from "../orchestrator/adaptiveStage.js";
import { createFanOutSynthesizeStage } from "../orchestrator/synthesizeStage.js";
import { scriptedChat } from "./fixtures.js";

// RISK (a) from the brief: stage 7 changes from a single call into a fan-out plus a supervisor, and
// the grounding / cache / budget / "AI failure ⇒ partial" contract must survive EXACTLY. Every test
// here targets one clause of that contract.

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 20, symbolCount: 2 };
}

const FILES = ["src/c0/f0.ts", "src/c0/f1.ts", "src/c1/f0.ts", "src/c1/f1.ts"];

function priorSlices(options: { clusters?: boolean } = {}): Partial<AnalysisResultSlices> {
  const nodes = FILES.map(node);
  const clusters = options.clusters === false
    ? undefined
    : {
        algorithm: "louvain" as const,
        seed: 42,
        resolution: 1,
        modularity: 0.4,
        count: 2,
        assignments: FILES.map((fileId) => ({ fileId, cluster: fileId.startsWith("src/c0") ? 0 : 1 })),
        clusters: [
          { id: 0, files: ["src/c0/f0.ts", "src/c0/f1.ts"], size: 2, internalWeight: 4, externalWeight: 0 },
          { id: 1, files: ["src/c1/f0.ts", "src/c1/f1.ts"], size: 2, internalWeight: 4, externalWeight: 0 },
        ],
      };

  return {
    graph: {
      nodes,
      edges: [],
      resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      cpgEdges: [],
      routes: [],
      cpg: { treeSitterFiles: nodes.length, fallbackFiles: 0, enriched: true },
    },
    inventory: { symbols: [], entryPoints: [], symbolCount: 0, loc: {} },
    entryPoints: [{ fileId: "src/c0/f0.ts", reason: "index" }],
    metrics: {
      perFile: [],
      keyFiles: ["src/c0/f0.ts"],
      hotspots: [],
      cycles: [],
      summary: { fileCount: nodes.length, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
      ...(clusters ? { clusters } : {}),
    },
  };
}

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

function ctxFor(options: { clusters?: boolean; cache?: ReturnType<typeof memCache>; budget?: BudgetHandle } = {}): PipelineContext & {
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    repoPath: "/repo",
    commitSha: "sha-1",
    prior: priorSlices({ ...(options.clusters !== undefined ? { clusters: options.clusters } : {}) }),
    cache: options.cache ?? memCache(),
    ...(options.budget ? { budget: options.budget } : {}),
    logger: { info() {}, warn: (message: string) => warnings.push(message), error() {} },
    signal: new AbortController().signal,
    warnings,
  } as unknown as PipelineContext & { warnings: string[] };
}

function specialistReply(prompt: string): string {
  const match = prompt.match(/## Files in this group \(the ONLY fileIds you may cite\)\n {2}(\S+)/);
  return JSON.stringify({
    findings: [
      { headline: "a finding", detail: "d".repeat(60), importance: "medium", fileIds: [match?.[1] ?? "src/c0/f0.ts"] },
    ],
  });
}

function fanOutChat(supervisor?: string) {
  return scriptedChat([
    (prompt) =>
      prompt.includes("Specialist findings")
        ? supervisor ??
          JSON.stringify({ summary: "A small repo.", readingOrder: [{ fileId: "src/c0/f0.ts", order: 1, reason: "start" }] })
        : specialistReply(prompt),
  ]);
}

describe("createFanOutSynthesizeStage — the stage contract is unchanged", () => {
  it("keeps the synthesize IDENTITY and adds aiDomains, which only the fan-out produces", async () => {
    // The orchestrator's coverage partition, cache lookup and partial handling all key off the ID —
    // that must not change. `owns` widening is additive and required: `aiDomains` (V3-FINAL) is the
    // durable projection of the fan-out's findings, and a stage that does not declare a key cannot
    // write it, which is how five specialists' output reached no user at all.
    const stage = createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1000 });
    expect(stage.id).toBe("synthesize");
    expect(stage.kind).toBe("ai");
    expect(stage.owns).toEqual(["aiSynthesis", "aiDomains"]);

    const { partial, event } = await stage.run(input, ctxFor());
    expect(partial.aiSynthesis?.readingOrder.length).toBeGreaterThan(0);
    expect(event.stage).toBe("synthesize");
    expect(event.status).toBe("completed");
  });

  it("GROUNDS the reading order and drops what does not exist", async () => {
    const stage = createFanOutSynthesizeStage({
      chatClient: fanOutChat(
        JSON.stringify({
          summary: "s",
          readingOrder: [
            { fileId: "src/ghost.ts", order: 1, reason: "invented" },
            { fileId: "src/c0/f0.ts", order: 2, reason: "real" },
          ],
        }),
      ),
      now: () => 1,
    });
    const { partial } = await stage.run(input, ctxFor());
    expect(partial.aiSynthesis?.readingOrder.map((step) => step.fileId)).toEqual(["src/c0/f0.ts"]);
    expect(partial.aiSynthesis?.droppedCitations).toBe(1);
  });

  it("CACHES the outcome and serves it with ZERO calls on a re-run", async () => {
    // The cacheable unit is the OUTCOME, not a completion — there is no single completion here,
    // there are 5N+1 of them.
    const cache = memCache();
    const first = fanOutChat();
    await createFanOutSynthesizeStage({ chatClient: first, now: () => 1 }).run(input, ctxFor({ cache }));
    expect(first.consumed).toBeGreaterThan(0);

    const second = fanOutChat();
    const { partial, event } = await createFanOutSynthesizeStage({ chatClient: second, now: () => 1 }).run(
      input,
      ctxFor({ cache }),
    );
    expect(second.consumed).toBe(0); // cache-before-budget: a hit spends nothing
    expect(partial.aiSynthesis?.readingOrder.length).toBeGreaterThan(0);
    expect(event.preview?.cached).toBe(true);
  });

  it("RE-GROUNDS a cached synthesis and discards one that no longer matches the graph", async () => {
    const cache = memCache();
    await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctxFor({ cache }));
    // Poison the cached entry with a file that is not in the graph.
    const key = [...cache.store.keys()][0];
    cache.store.set(key, { summary: "stale", readingOrder: [{ fileId: "src/deleted.ts", order: 1, reason: "gone" }] } satisfies Synthesis);

    const chat = fanOutChat();
    const ctx = ctxFor({ cache });
    const { partial } = await createFanOutSynthesizeStage({ chatClient: chat, now: () => 1 }).run(input, ctx);
    expect(chat.consumed).toBeGreaterThan(0); // it re-ran rather than serving the stale entry
    expect(partial.aiSynthesis?.readingOrder.map((step) => step.fileId)).not.toContain("src/deleted.ts");
    expect(ctx.warnings.join(" ")).toMatch(/no longer grounds/);
  });

  it("does NOT cache a fallback synthesis", async () => {
    // A transient supervisor failure must not freeze the degraded answer in for the whole SHA, and
    // the fallback is deterministic and cheap to recompute anyway.
    const cache = memCache();
    const chat = scriptedChat([(prompt) => (prompt.includes("Specialist findings") ? "unparseable" : specialistReply(prompt))]);
    const { partial } = await createFanOutSynthesizeStage({ chatClient: chat, now: () => 1 }).run(input, ctxFor({ cache }));
    expect(partial.aiSynthesis?.summary).toMatch(/WITHOUT a supervisor synthesis/);
    expect(cache.store.size).toBe(0);
  });

  it("THROWS only when nothing is grounded — the same condition the single-shot stage threw on", async () => {
    // Everything short of this degrades: a failed specialist, a refused lens, a failed supervisor.
    const stage = createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 });
    const ctx = ctxFor();
    // A graph with nodes the fallback cannot use either: strip entry points, key files and clusters'
    // member files from the node set.
    (ctx.prior as { graph?: { nodes: unknown[] } }).graph = { ...ctx.prior.graph!, nodes: [] } as never;
    await expect(stage.run(input, ctx)).rejects.toThrow();
  });

  it("requires metrics.clusters, and says which stage to use instead", async () => {
    const stage = createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 });
    await expect(stage.run(input, ctxFor({ clusters: false }))).rejects.toThrow(/metrics\.clusters/);
  });

  it("requires the graph slice", async () => {
    const stage = createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 });
    const ctx = ctxFor();
    delete (ctx.prior as { graph?: unknown }).graph;
    await expect(stage.run(input, ctx)).rejects.toThrow(/requires the graph slice/);
  });

  it("REPORTS the fan-out's cost and parallelism on the event, so a run is explainable", async () => {
    const { event } = await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctxFor());
    expect(event.preview).toMatchObject({
      specialistCalls: expect.any(Number),
      bestOfNExtraCalls: expect.any(Number),
      peakConcurrency: expect.any(Number),
      supervisorContextTokens: expect.any(Number),
      supervised: true,
    });
    expect(event.detail).toMatch(/specialist calls/);
  });

  it("REPORTS the blackboard REPLAY facts on the event (V3-P5 task 2e, wired V3-FINAL)", async () => {
    // Before this the versioned blackboard existed and nothing used it, so a completed run left no
    // record of which board state the supervisor synthesised from. `blackboardReadVersion` is the
    // one that makes a later "why did it say that?" resolve to a state rather than to a guess.
    const { event } = await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctxFor());
    const preview = event.preview as Record<string, unknown>;
    expect(preview.blackboardVersions).toBeTypeOf("number");
    expect(preview.blackboardVersions as number).toBeGreaterThan(1);
    // The supervisor read the HEAD, so the two agree — and a mismatch would mean the log lost the
    // state the synthesis came from.
    expect(preview.blackboardReadVersion).toBe(preview.blackboardVersions);
    // 1 means nothing was trimmed, i.e. a replay can reach the start of the run.
    expect(preview.blackboardTrimmedBefore).toBe(1);
  });

  it("logs the version-log HEADER, not sixty lines of it, per job", async () => {
    const ctx = ctxFor();
    const logged: string[] = [];
    ctx.logger.info = (message: string) => logged.push(message);
    await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctx);
    const line = logged.find((message) => message.startsWith("Fan-out blackboard:"));
    expect(line).toMatch(/\d+ write\(s\), \d+ read\(s\)/);
    // One line. A per-version dump would drown a worker's log at exactly the throughput where the
    // log matters most.
    expect(line).not.toContain("v1 @");
  });

  it("keys the cache on the COMMUNITY PARTITION, not only the SHA", async () => {
    // A different partition is a different fan-out even at the same commit; serving the old
    // synthesis would be answering about a structure that no longer exists.
    const cache = memCache();
    await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctxFor({ cache }));
    const firstKey = [...cache.store.keys()][0];

    const ctx = ctxFor({ cache });
    ctx.prior.metrics!.clusters!.modularity = 0.99; // a different partition
    const chat = fanOutChat();
    await createFanOutSynthesizeStage({ chatClient: chat, now: () => 1 }).run(input, ctx);
    expect(chat.consumed).toBeGreaterThan(0); // cache MISS
    expect([...cache.store.keys()]).toHaveLength(2);
    expect([...cache.store.keys()][1]).not.toBe(firstKey);
  });

  it("degrades (not fails) when the budget runs out mid fan-out", async () => {
    let allowed = 4;
    const budget: BudgetHandle = {
      async check() {
        return allowed-- > 0;
      },
      async record() {},
    };
    const ctx = ctxFor({ budget });
    const { partial } = await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctx);
    expect(partial.aiSynthesis?.readingOrder.length).toBeGreaterThan(0);
    expect(ctx.warnings.join(" ")).toMatch(/budget/i);
  });

  it("produces a plain-serializable slice", async () => {
    const { partial } = await createFanOutSynthesizeStage({ chatClient: fanOutChat(), now: () => 1 }).run(input, ctxFor());
    expect(JSON.parse(JSON.stringify(partial.aiSynthesis))).toEqual(partial.aiSynthesis);
  });
});

describe("createAdaptiveSynthesizeStage — the choice is made at RUN time", () => {
  function stubStage(id: string): PipelineStage<"aiSynthesis"> & { run: ReturnType<typeof vi.fn> } {
    const run = vi.fn(async () => ({
      partial: { aiSynthesis: { summary: id, readingOrder: [{ fileId: "src/c0/f0.ts", order: 1, reason: "r" }] } },
      event: { jobId: "job-1", stage: "synthesize", stageIndex: 7, stageCount: 7, kind: "ai", status: "completed", label: "Synthesizing", progress: 0, startedAt: "", emittedAt: "" },
    }));
    return { id: "synthesize", kind: "ai", label: "Synthesizing", owns: ["aiSynthesis"], run } as never;
  }

  it("delegates to the FAN-OUT when communities exist", async () => {
    // The decision cannot be made at construction time: metrics.clusters does not exist until
    // Analyze (stage 6) has run, but the worker assembles its stage list before the pipeline starts.
    const fanOut = stubStage("fan-out");
    const singleShot = stubStage("single-shot");
    const choices: string[] = [];
    const stage = createAdaptiveSynthesizeStage({ fanOut, singleShot, onChoice: (choice) => choices.push(choice) });

    const { partial } = await stage.run(input, ctxFor());
    expect(fanOut.run).toHaveBeenCalledOnce();
    expect(singleShot.run).not.toHaveBeenCalled();
    expect(partial.aiSynthesis?.summary).toBe("fan-out");
    expect(choices).toEqual(["fan-out"]);
  });

  it("delegates to the SINGLE-SHOT path when there are no communities", async () => {
    // A cached pre-V3-P1 analysis has an index but no communities, and is still worth synthesising.
    const fanOut = stubStage("fan-out");
    const singleShot = stubStage("single-shot");
    const reasons: string[] = [];
    const stage = createAdaptiveSynthesizeStage({ fanOut, singleShot, onChoice: (_choice, reason) => reasons.push(reason) });

    const { partial } = await stage.run(input, ctxFor({ clusters: false }));
    expect(singleShot.run).toHaveBeenCalledOnce();
    expect(fanOut.run).not.toHaveBeenCalled();
    expect(partial.aiSynthesis?.summary).toBe("single-shot");
    expect(reasons[0]).toMatch(/pre-V3-P1/);
  });

  it("uses the single-shot path when community detection found NO communities", async () => {
    const fanOut = stubStage("fan-out");
    const singleShot = stubStage("single-shot");
    const reasons: string[] = [];
    const stage = createAdaptiveSynthesizeStage({ fanOut, singleShot, onChoice: (_choice, reason) => reasons.push(reason) });

    const ctx = ctxFor();
    ctx.prior.metrics!.clusters!.clusters = [];
    await stage.run(input, ctx);
    expect(singleShot.run).toHaveBeenCalledOnce();
    expect(reasons[0]).toMatch(/no communities/);
  });

  it("keeps the SAME id/kind as its delegates, and declares the union of what they write", () => {
    // A new id would silently take stage 7 out of the orchestrator's coverage partition, its cache
    // lookup and its "AI failure ⇒ partial" handling. `owns` must be the UNION: the single-shot
    // delegate writes no domain lanes, but omitting the key here would drop them on every fan-out.
    const stage = createAdaptiveSynthesizeStage({ fanOut: stubStage("a"), singleShot: stubStage("b") });
    expect(stage.id).toBe("synthesize");
    expect(stage.kind).toBe("ai");
    expect(stage.owns).toEqual(["aiSynthesis", "aiDomains"]);
  });
});
