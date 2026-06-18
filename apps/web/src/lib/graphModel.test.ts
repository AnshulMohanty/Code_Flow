import type { AnalysisResult } from "@codeflow/shared-types";
import { describe, expect, it } from "vitest";
import { buildGraphModel } from "./graphModel";
import { mockAnalysisResult } from "./mockAnalysis";

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 10, symbolCount: 1 };
}

/** A result with a 3-cycle, a dangling edge (to a non-node), and resolution tallies. */
function cyclicResult(): AnalysisResult {
  const nodes = [node("a.ts"), node("b.ts"), node("c.ts")];
  return {
    id: "r",
    repository: { provider: "github", owner: "o", name: "r" },
    mode: "public_hosted",
    createdAt: "2026-06-10T00:00:00.000Z",
    warnings: [],
    summary: { repository: { provider: "github", owner: "o", name: "r" }, mode: "public_hosted", files: 3, functions: 0, connections: 3, healthScore: null, healthGrade: null },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [
        { fileId: "a.ts", centrality: 2, fanIn: 1, fanOut: 1, blastRadius: 2, complexity: 12 },
        { fileId: "b.ts", centrality: 2, fanIn: 1, fanOut: 1, blastRadius: 2, complexity: 12 },
        { fileId: "c.ts", centrality: 2, fanIn: 1, fanOut: 1, blastRadius: 2, complexity: 12 },
      ],
      keyFiles: ["a.ts", "b.ts", "c.ts"],
      hotspots: [],
      cycles: [{ files: ["a.ts", "b.ts", "c.ts"] }],
      summary: { fileCount: 3, edgeCount: 3, cycleCount: 1, isolatedFileCount: 0, maxBlastRadius: 2 },
    },
    graph: {
      nodes,
      edges: [
        { from: "a.ts", to: "b.ts", kind: "import", specifier: "./b" },
        { from: "b.ts", to: "c.ts", kind: "import", specifier: "./c" },
        { from: "c.ts", to: "a.ts", kind: "import", specifier: "./a" },
        { from: "a.ts", to: "ghost.ts", kind: "import", specifier: "./ghost" }, // dangling — to a non-node
      ],
      resolution: { resolved: 3, external: 4, unresolved: 2, externalModules: ["react", "lodash"], unresolvedImports: [{ from: "a.ts", specifier: "./missing" }] },
    },
  };
}

describe("buildGraphModel", () => {
  it("builds grounded nodes/links from graph; drops dangling edges; externals are not nodes", () => {
    const model = buildGraphModel(cyclicResult());

    expect(model.nodes.map((n) => n.id).sort()).toEqual(["a.ts", "b.ts", "c.ts"]); // no ghost / external nodes
    expect(model.nodeCount).toBe(3);
    // The a.ts→ghost.ts edge is dropped (ghost is not a node); the 3 cycle edges remain.
    expect(model.links).toHaveLength(3);
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const l of model.links) {
      expect(ids.has(l.source)).toBe(true);
      expect(ids.has(l.target)).toBe(true);
    }
  });

  it("flags cycle nodes + edges from metrics.cycles", () => {
    const model = buildGraphModel(cyclicResult());
    expect(model.nodes.every((n) => n.inCycle)).toBe(true);
    expect(model.links.every((l) => l.inCycle)).toBe(true);
  });

  it("surfaces unresolved + external as honest counts, never faked edges", () => {
    const model = buildGraphModel(cyclicResult());
    expect(model.unresolvedCount).toBe(2);
    expect(model.externalCount).toBe(4);
    expect(model.linkCount).toBe(3); // only real, grounded edges
  });

  it("derives node role/centrality/inCycle from the mock result", () => {
    const model = buildGraphModel(mockAnalysisResult());
    const auth = model.nodes.find((n) => n.id === "src/auth.ts")!;
    expect(auth.role).toBe("source");
    expect(auth.centrality).toBe(1);
    expect(auth.inCycle).toBe(false); // mock has no cycles
  });
});
