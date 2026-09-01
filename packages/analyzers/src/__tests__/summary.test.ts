import { describe, expect, it } from "vitest";
import type {
  AnalysisResultSlices,
  FileNode,
  InventorySymbol,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoDependencyEdge,
  RepoMetrics,
} from "@codeflow/shared-types";
import { runPipeline } from "../pipeline/orchestrator.js";
import { deriveSummary, scoreHealth } from "../pipeline/summary.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "widgets" },
  mode: "public_hosted",
  analyzerVersion: "1.0.0",
};

function node(id: string, language = "TypeScript"): FileNode {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language, lines: 10, symbolCount: 2 };
}

function edge(from: string, to: string): RepoDependencyEdge {
  return { from, to, kind: "import", specifier: `./${to}` };
}

function symbol(name: string, kind: InventorySymbol["kind"], filePath = "src/a.ts"): InventorySymbol {
  return { name, kind, filePath, line: 1, exported: true, language: "TypeScript" };
}

/** A healthy 4-file graph: no cycles, no isolated files, modest blast radius. */
function healthySlices(): Partial<AnalysisResultSlices> {
  const nodes = [node("src/a.ts"), node("src/b.ts"), node("src/c.ts"), node("src/main.py", "Python")];
  const edges = [edge("src/a.ts", "src/b.ts"), edge("src/b.ts", "src/c.ts"), edge("src/main.py", "src/c.ts")];
  const metrics: RepoMetrics = {
    perFile: [],
    keyFiles: ["src/c.ts"],
    hotspots: ["src/c.ts"],
    cycles: [],
    summary: { fileCount: 4, edgeCount: 3, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 1 },
  };
  return {
    graph: {
      nodes,
      edges,
      resolution: { resolved: 3, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
    },
    inventory: {
      symbols: [
        symbol("run", "function"),
        symbol("Widget", "class"),
        symbol("render", "method"),
        symbol("Options", "interface"),
        symbol("VERSION", "variable"),
      ],
      entryPoints: [],
      symbolCount: 5,
      loc: {},
    },
    metrics,
  };
}

describe("deriveSummary — real slices produce non-zero summary values", () => {
  it("counts files, connections and functions from the deterministic slices", () => {
    const summary = deriveSummary(input, healthySlices());

    expect(summary.files).toBe(4);
    expect(summary.connections).toBe(3);
    // functions = "function" + "method" only (class/interface/variable are not callables)
    expect(summary.functions).toBe(2);
    expect(summary.files).toBeGreaterThan(0);
    expect(summary.connections).toBeGreaterThan(0);
    expect(summary.functions).toBeGreaterThan(0);
  });

  it("scores health from the metric summary and carries the repository identity through", () => {
    const summary = deriveSummary(input, healthySlices());

    expect(summary.healthScore).toBe(91);
    expect(summary.healthGrade).toBe("A");
    expect(summary.repository).toEqual(input.repositoryRef);
    expect(summary.mode).toBe("public_hosted");
  });

  it("composes the optional languages + circularDependencies fields from existing data", () => {
    const summary = deriveSummary(input, healthySlices());

    expect(summary.languages).toEqual(["Python", "TypeScript"]); // distinct + sorted
    expect(summary.circularDependencies).toBe(0);
  });

  it("penalises cycles, blast radius and isolated files", () => {
    const slices = healthySlices();
    slices.metrics = {
      perFile: [],
      keyFiles: [],
      hotspots: [],
      cycles: [{ files: ["src/a.ts", "src/b.ts"] }, { files: ["src/b.ts", "src/c.ts"] }],
      summary: { fileCount: 4, edgeCount: 3, cycleCount: 2, isolatedFileCount: 2, maxBlastRadius: 4 },
    };
    const summary = deriveSummary(input, slices);

    // cycles 2/4*10 → capped, blast 4/4 → capped, isolated 2/4 → half ⇒ 100-40-35-7.5
    expect(summary.healthScore).toBe(18);
    expect(summary.healthGrade).toBe("F");
    expect(summary.circularDependencies).toBe(2);
  });

  it("stays honestly empty when the source slices are absent (no fabricated grade)", () => {
    const summary = deriveSummary(input, {});

    expect(summary.files).toBe(0);
    expect(summary.connections).toBe(0);
    expect(summary.functions).toBe(0);
    expect(summary.healthScore).toBeNull();
    expect(summary.healthGrade).toBeNull();
    expect(summary.languages).toBeUndefined();
    expect(summary.circularDependencies).toBeUndefined();
  });
});

describe("scoreHealth", () => {
  it("returns null for an empty graph rather than a fabricated zero", () => {
    expect(scoreHealth({ fileCount: 0, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 })).toBeNull();
  });

  it("gives a clean graph a perfect score", () => {
    expect(scoreHealth({ fileCount: 10, edgeCount: 9, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 })).toEqual({
      score: 100,
      grade: "A",
    });
  });

  it("floors at 10, never 0, for a fully degenerate graph", () => {
    const verdict = scoreHealth({ fileCount: 5, edgeCount: 20, cycleCount: 5, isolatedFileCount: 5, maxBlastRadius: 5 });
    expect(verdict).toEqual({ score: 10, grade: "F" });
  });

  it("grades on the documented bands", () => {
    // isolatedFileCount drives a small, exactly-computable penalty: 15 * (n/100)
    const at = (isolated: number) =>
      scoreHealth({ fileCount: 100, edgeCount: 0, cycleCount: 0, isolatedFileCount: isolated, maxBlastRadius: 0 })!;
    expect(at(0).grade).toBe("A");
    expect(at(100).score).toBe(85);
    expect(at(100).grade).toBe("B");
  });
});

describe("runPipeline — the assembled result carries a real summary", () => {
  it("derives a non-zero summary from the stages that actually ran", async () => {
    const slices = healthySlices();
    const event = (stage: ProgressEvent["stage"]): ProgressEvent => ({
      jobId: input.jobId,
      stage,
      stageIndex: 0,
      stageCount: 0,
      kind: "deterministic",
      status: "completed",
      label: String(stage),
      progress: 0,
      startedAt: "",
      emittedAt: "",
    });

    const stages: PipelineStage[] = [
      {
        id: "inventory",
        kind: "deterministic",
        label: "Inventory",
        owns: ["inventory"],
        async run() {
          return { partial: { inventory: slices.inventory! }, event: event("inventory") };
        },
      },
      {
        id: "connect",
        kind: "deterministic",
        label: "Connect",
        owns: ["graph"],
        async run() {
          return { partial: { graph: slices.graph! }, event: event("connect") };
        },
      },
      {
        id: "analyze",
        kind: "deterministic",
        label: "Analyze",
        owns: ["metrics"],
        async run() {
          return { partial: { metrics: slices.metrics! }, event: event("analyze") };
        },
      },
    ];

    const { result } = await runPipeline(stages, input);

    expect(result.pipeline?.status).toBe("completed");
    expect(result.summary.files).toBe(4);
    expect(result.summary.connections).toBe(3);
    expect(result.summary.functions).toBe(2);
    expect(result.summary.healthScore).toBe(91);
    expect(result.summary.healthGrade).toBe("A");
  });
});
