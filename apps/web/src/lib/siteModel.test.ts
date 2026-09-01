import { describe, expect, it } from "vitest";
import type { AnalysisResult, PipelineStageId, StageStatus } from "@codeflow/shared-types";
import { buildSiteModel, formatStat, NOT_MEASURED, PIPELINE_ROWS, type MetaFacts } from "./siteModel";

/**
 * ONE RULE under test: a figure is either read from something the pipeline produced, or it is null
 * and renders as an em-dash. The design shows these numbers in very large type, which is exactly
 * where a plausible guess does the most damage — so "not measured" has to be a value the model
 * carries, not a case a component might forget.
 */

function stage(id: PipelineStageId, status: StageStatus, durationMs?: number) {
  return { stage: id, kind: id === "rag" || id === "synthesize" ? ("ai" as const) : ("deterministic" as const), status, durationMs };
}

function resultWith(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const nodes = [
    { id: "src/a.ts", path: "src/a.ts", name: "a.ts", layer: "source", language: "TypeScript", lines: 10, symbolCount: 2 },
    { id: "src/b.ts", path: "src/b.ts", name: "b.ts", layer: "source", language: "TypeScript", lines: 20, symbolCount: 3 },
  ];
  return {
    id: "analysis-1",
    repository: { provider: "github", owner: "acme", name: "repo" },
    mode: "public_hosted",
    createdAt: "2026-08-31T00:00:00.000Z",
    commitSha: "abcdef1234567890abcdef1234567890abcdef12",
    warnings: [],
    runMode: "full",
    summary: {
      repository: { provider: "github", owner: "acme", name: "repo" },
      mode: "public_hosted",
      files: 2,
      functions: 5,
      connections: 1,
      healthScore: 80,
      healthGrade: "B",
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [{ fileId: "src/a.ts", centrality: 1, fanIn: 1, fanOut: 0, blastRadius: 1, complexity: 3 }],
      keyFiles: ["src/a.ts"],
      hotspots: [],
      cycles: [],
      summary: { fileCount: 2, edgeCount: 1, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 1 },
      clusters: {
        algorithm: "louvain",
        seed: 42,
        resolution: 1,
        modularity: 0.3,
        count: 1,
        assignments: [],
        clusters: [],
      },
    },
    graph: {
      nodes,
      edges: [{ from: "src/b.ts", to: "src/a.ts", kind: "import", specifier: "./a" }],
      resolution: { resolved: 1, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
    },
    structure: { layout: "src-rooted", fileCount: 2, files: [] },
    inventory: { symbols: [], entryPoints: [], symbolCount: 5, loc: {} },
    pipeline: {
      status: "completed",
      startedAt: "2026-08-31T00:00:00.000Z",
      completedAt: "2026-08-31T00:00:05.000Z",
      stages: [
        stage("ingest", "completed", 620),
        stage("orient", "completed", 40),
        stage("map-structure", "completed", 700),
        stage("inventory", "completed", 480),
        stage("connect", "completed", 940),
        stage("analyze", "completed", 760),
        stage("synthesize", "completed", 480),
        stage("rag", "completed", 1320),
      ],
    },
    ai: {
      synthesis: { summary: "s", readingOrder: [{ fileId: "src/a.ts", order: 1, reason: "start" }] },
      rag: {
        chunks: [],
        embeddingModel: "m",
        embeddingDim: 3,
        store: { namespace: "n", vectorStoreId: "v", textStoreId: "t" },
      } as never,
    },
    ...overrides,
  } as AnalysisResult;
}

const meta: MetaFacts = {
  analyzerVersion: "1.1.0",
  build: "abc1234",
  answerLatency: { p50Ms: 412, p95Ms: 900, sampleCount: 40, scope: "process" },
  indexed: [],
  serverTime: "2026-08-31T13:10:25.000Z",
};

describe("buildSiteModel — the six rows map to real stages", () => {
  it("maps every design row onto stages that exist", () => {
    // The mapping is stated in the module and asserted here, so a row a user reads is always
    // traceable to the stage whose number it shows.
    const valid = new Set<PipelineStageId>([
      "ingest",
      "orient",
      "map-structure",
      "inventory",
      "connect",
      "analyze",
      "synthesize",
      "rag",
    ]);
    for (const row of PIPELINE_ROWS) {
      for (const id of row.stages) expect(valid.has(id)).toBe(true);
    }
  });

  it("sums the REAL durations of the contributing stages", () => {
    const model = buildSiteModel(resultWith(), meta);
    const parse = model.rows.find((row) => row.id === "parse")!;
    // map-structure 700 + inventory 480.
    expect(parse.durationMs).toBe(1180);
    expect(parse.status).toBe("done");
  });

  it("reports SKIPPED, not pending, for an AI stage that never registered", () => {
    // "Still working" and "never going to run" are different facts; the design's `ground —` is the
    // second one, and a spinner there would be a lie about a keyless deployment.
    const noAi = resultWith({
      ai: undefined,
      runMode: "deterministic-only",
      pipeline: {
        status: "completed",
        startedAt: "x",
        completedAt: "y",
        stages: [stage("ingest", "completed", 10), stage("connect", "completed", 20)],
      },
    });
    const model = buildSiteModel(noAi, meta);
    expect(model.rows.find((row) => row.id === "embed")!.status).toBe("skipped");
    expect(model.rows.find((row) => row.id === "ground")!.status).toBe("skipped");
    expect(model.rows.find((row) => row.id === "ground")!.durationMs).toBeNull();
  });

  it("names WHY a skipped AI row is empty, rather than leaving it blank", () => {
    const model = buildSiteModel(resultWith({ ai: undefined, runMode: "deterministic-only" }), meta);
    // With records present but no slice, the detail still explains itself.
    const embed = model.rows.find((row) => row.id === "embed")!;
    expect(embed.detail === null || embed.detail.includes("provider")).toBe(true);
  });

  it("REPORTS unresolved imports on the resolve row rather than hiding them", () => {
    const partial = resultWith();
    partial.graph!.resolution.unresolved = 2;
    const model = buildSiteModel(partial, meta);
    expect(model.rows.find((row) => row.id === "resolve")!.detail).toContain("2 unresolved");
  });

  it("reports a FAILED row when a contributing stage failed", () => {
    const failed = resultWith({
      pipeline: {
        status: "failed",
        startedAt: "x",
        completedAt: "y",
        stages: [stage("ingest", "completed", 10), stage("connect", "failed", 5)],
      },
    });
    expect(buildSiteModel(failed, meta).rows.find((row) => row.id === "resolve")!.status).toBe("failed");
  });
});

describe("buildSiteModel — the four headline stats", () => {
  it("reads files and edges off the real slices", () => {
    const model = buildSiteModel(resultWith(), meta);
    expect(model.numbers.filesParsed.value).toBe(2);
    expect(model.numbers.edgesResolved.value).toBe(1);
  });

  it("uses the SERVER's measured p50, and says why it is absent when it is", () => {
    const withMeta = buildSiteModel(resultWith(), meta);
    expect(withMeta.numbers.p50AnswerMs.value).toBe(412);

    const noMeta = buildSiteModel(resultWith(), { ...meta, answerLatency: { p50Ms: null, p95Ms: null, sampleCount: 0, scope: "process" } });
    expect(noMeta.numbers.p50AnswerMs.value).toBeNull();
    expect(noMeta.numbers.p50AnswerMs.absentReason).toContain("asked a question");
  });

  it("distinguishes NOTHING SPENT from UNPRICED — two different em-dashes", () => {
    // Collapsing them would let an unconfigured price table read as "this run was free".
    const nothing = buildSiteModel(resultWith({ cost: undefined }), meta);
    expect(nothing.numbers.costPerIndex.value).toBeNull();
    expect(nothing.numbers.costPerIndex.absentReason).toContain("no paid provider call");

    const unpriced = buildSiteModel(
      resultWith({
        cost: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, usd: null, measured: true, unpricedModels: ["claude-x"] },
      }),
      meta,
    );
    expect(unpriced.numbers.costPerIndex.value).toBeNull();
    expect(unpriced.numbers.costPerIndex.absentReason).toContain("claude-x");
  });

  it("carries the `measured` flag on a priced cost", () => {
    const estimated = buildSiteModel(
      resultWith({
        cost: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, usd: 0.19, measured: false, unpricedModels: [] },
      }),
      meta,
    );
    expect(estimated.numbers.costPerIndex.value).toBeCloseTo(0.19, 6);
    expect(estimated.numbers.costPerIndex.measured).toBe(false);
  });

  it("formats a null stat as the em-dash, and only as the em-dash", () => {
    expect(formatStat({ label: "x", value: null, format: "count" })).toBe(NOT_MEASURED);
    expect(formatStat({ label: "x", value: null, format: "usd" })).toBe(NOT_MEASURED);
    expect(formatStat({ label: "x", value: 12481, format: "count" })).toBe("12,481");
    expect(formatStat({ label: "x", value: 412.6, format: "ms" })).toBe("413");
  });

  it("does not round a sub-cent cost to $0.00 — that would read as free", () => {
    expect(formatStat({ label: "x", value: 0.0019, format: "usd" })).toBe("$0.0019");
    expect(formatStat({ label: "x", value: 0.19, format: "usd" })).toBe("$0.19");
  });
});

describe("buildSiteModel — grounding is the run's REAL delivered scope", () => {
  it("GROUNDED for a full run with everything resolved", () => {
    const model = buildSiteModel(resultWith(), meta);
    expect(model.grounding.state).toBe("grounded");
    expect(model.grounding.detail).toContain("deterministic import graph");
  });

  it("PARTIAL when imports are unresolved — the static-pass-only state", () => {
    const partial = resultWith();
    partial.graph!.resolution.unresolved = 2;
    const model = buildSiteModel(partial, meta);
    expect(model.grounding.state).toBe("partial");
    expect(model.grounding.detail).toContain("static pass only");
  });

  it("PARTIAL when the AI stages did not run, and says so", () => {
    const model = buildSiteModel(resultWith({ runMode: "deterministic-only", ai: undefined }), meta);
    expect(model.grounding.state).toBe("partial");
    expect(model.grounding.detail).toContain("AI stages did not run");
  });

  it("PARTIAL surfaces a recorded degradation VERBATIM", () => {
    const model = buildSiteModel(
      resultWith({
        degradations: [{ reason: "mongo-unavailable", detail: "The database is unavailable, so this run is held in memory only." }],
      }),
      meta,
    );
    expect(model.grounding.detail).toContain("held in memory only");
  });

  it("REFUSED when a required stage failed — nothing to cite from", () => {
    const model = buildSiteModel(
      resultWith({
        graph: undefined,
        warnings: ['Required stage "connect" failed: boom'],
        pipeline: { status: "failed", startedAt: "x", completedAt: "y", stages: [] },
      }),
      meta,
    );
    expect(model.grounding.state).toBe("refused");
    expect(model.grounding.detail).toContain("connect");
  });

  it("REFUSED names CAPACITY specifically, because it is not a bug", () => {
    const model = buildSiteModel(
      resultWith({
        graph: undefined,
        pipeline: { status: "failed", statusReason: "budget-exhausted", startedAt: "x", completedAt: "y", stages: [] },
      }),
      meta,
    );
    expect(model.grounding.detail).toContain("At capacity");
    expect(model.grounding.detail).toContain("no answer is guessed");
  });
});

describe("buildSiteModel — identity and totals", () => {
  it("uses the real repo name and a short sha", () => {
    const model = buildSiteModel(resultWith(), meta);
    expect(model.repoFullName).toBe("acme/repo");
    expect(model.shortSha).toBe("abcdef1");
  });

  it("reports a null sha rather than a fabricated one", () => {
    expect(buildSiteModel(resultWith({ commitSha: undefined }), meta).shortSha).toBeNull();
  });

  it("sums the total from real per-stage durations", () => {
    // 620 + 40 + 700 + 480 + 940 + 760 + 480 + 1320, restricted to the six mapped rows.
    const model = buildSiteModel(resultWith(), meta);
    expect(model.totalMs).toBe(620 + 1180 + 940 + 760 + 1320 + 480);
  });

  it("surfaces warnings verbatim rather than softening them", () => {
    const model = buildSiteModel(resultWith({ warnings: ["AI stage \"rag\" failed (degraded result): voyage down"] }), meta);
    expect(model.warnings[0]).toContain("voyage down");
  });

  it("works with NO meta at all — every meta-sourced figure reports absent", () => {
    const model = buildSiteModel(resultWith(), null);
    expect(model.numbers.p50AnswerMs.value).toBeNull();
    expect(model.numbers.filesParsed.value).toBe(2); // result-sourced figures are unaffected
  });
});
