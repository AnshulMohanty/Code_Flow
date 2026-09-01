import { describe, expect, it } from "vitest";
import type {
  CpgEdge,
  FileNode,
  PipelineContext,
  PipelineInput,
  RepoDependencyEdge,
  RepoGraph,
  RepoMetrics,
} from "@codeflow/shared-types";
import { createAnalyzeStage } from "../stages/analyze.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

function node(path: string, extra: Partial<FileNode> = {}): FileNode {
  return {
    id: path,
    path,
    name: path.split("/").pop()!,
    layer: "source",
    language: "TypeScript",
    lines: 0,
    symbolCount: 0,
    ...extra,
  };
}

function edge(from: string, to: string): RepoDependencyEdge {
  return { from, to, kind: "import", specifier: `./${to}` };
}

function repoGraph(nodes: FileNode[], edges: RepoDependencyEdge[]): RepoGraph {
  return { nodes, edges, resolution: { resolved: edges.length, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] } };
}

function ctxFor(graph: RepoGraph): PipelineContext {
  return {
    repoPath: "/repo",
    commitSha: "sha",
    prior: { graph },
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

async function analyze(graph: RepoGraph): Promise<RepoMetrics> {
  const stage = createAnalyzeStage({ now: () => 1000 });
  const { partial } = await stage.run(input, ctxFor(graph));
  return partial.metrics!;
}

describe("analyze — centrality / key files", () => {
  it("ranks key files by centrality, ties broken by fileId", async () => {
    // hub is imported by a, b, c (fanIn 3); a also imports util. Degrees:
    //   hub: in3 out0 = 3 ; a: in0 out2 = 2 ; b: in0 out1 = 1 ; c: in0 out1 = 1 ; util: in1 out0 = 1
    const graph = repoGraph(
      [node("a.ts"), node("b.ts"), node("c.ts"), node("hub.ts"), node("util.ts")],
      [edge("a.ts", "hub.ts"), edge("b.ts", "hub.ts"), edge("c.ts", "hub.ts"), edge("a.ts", "util.ts")],
    );
    const metrics = await analyze(graph);
    // hub (3) > a (2) > [b, c, util all degree 1 → fileId asc]
    expect(metrics.keyFiles).toEqual(["hub.ts", "a.ts", "b.ts", "c.ts", "util.ts"]);
  });

  it("fanIn / fanOut match hand-counted edges", async () => {
    const graph = repoGraph(
      [node("a.ts"), node("b.ts"), node("hub.ts")],
      [edge("a.ts", "hub.ts"), edge("b.ts", "hub.ts")],
    );
    const byId = Object.fromEntries((await analyze(graph)).perFile.map((f) => [f.fileId, f]));
    expect(byId["hub.ts"]).toMatchObject({ fanIn: 2, fanOut: 0, centrality: 2 });
    expect(byId["a.ts"]).toMatchObject({ fanIn: 0, fanOut: 1, centrality: 1 });
  });
});

describe("analyze — cycles", () => {
  it("detects a known circular dependency", async () => {
    const graph = repoGraph(
      [node("a.ts"), node("b.ts"), node("c.ts")],
      [edge("a.ts", "b.ts"), edge("b.ts", "c.ts"), edge("c.ts", "a.ts")],
    );
    const metrics = await analyze(graph);
    expect(metrics.cycles).toHaveLength(1);
    expect([...metrics.cycles[0].files].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(metrics.summary.cycleCount).toBe(1);
  });

  it("an acyclic graph has no cycles", async () => {
    const graph = repoGraph([node("a.ts"), node("b.ts")], [edge("a.ts", "b.ts")]);
    const metrics = await analyze(graph);
    expect(metrics.cycles).toEqual([]);
    expect(metrics.summary.cycleCount).toBe(0);
  });
});

describe("analyze — blast radius (transitive reverse reachability)", () => {
  it("counts transitive dependents, not just direct (A→B→C ⇒ C affects A)", async () => {
    // a → b → c  (import direction). If c changes, both b and a are affected.
    const graph = repoGraph(
      [node("a.ts"), node("b.ts"), node("c.ts")],
      [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")],
    );
    const byId = Object.fromEntries((await analyze(graph)).perFile.map((f) => [f.fileId, f]));
    expect(byId["c.ts"].blastRadius).toBe(2); // a + b
    expect(byId["b.ts"].blastRadius).toBe(1); // a
    expect(byId["a.ts"].blastRadius).toBe(0); // nothing depends on a
  });
});

describe("analyze — complexity proxy", () => {
  it("is the declared structural proxy: loc + symbolCount + fanIn + fanOut", async () => {
    const graph = repoGraph(
      [node("a.ts", { lines: 100, symbolCount: 8 }), node("b.ts", { lines: 10, symbolCount: 1 })],
      [edge("a.ts", "b.ts")],
    );
    const byId = Object.fromEntries((await analyze(graph)).perFile.map((f) => [f.fileId, f]));
    // a: 100 + 8 + fanIn0 + fanOut1 = 109 ; b: 10 + 1 + fanIn1 + fanOut0 = 12
    expect(byId["a.ts"].complexity).toBe(109);
    expect(byId["b.ts"].complexity).toBe(12);
    expect((await analyze(graph)).hotspots).toEqual(["a.ts", "b.ts"]);
  });
});

describe("analyze — determinism", () => {
  it("the same graph run twice yields byte-identical metrics (ordering included)", async () => {
    const graph = repoGraph(
      [node("z.ts"), node("a.ts"), node("m.ts")],
      [edge("z.ts", "a.ts"), edge("m.ts", "a.ts"), edge("z.ts", "m.ts")],
    );
    const first = JSON.stringify(await analyze(graph));
    const second = JSON.stringify(await analyze(graph));
    expect(first).toBe(second);
  });

  it("perFile is sorted by fileId", async () => {
    const graph = repoGraph([node("z.ts"), node("a.ts"), node("m.ts")], []);
    const metrics = await analyze(graph);
    expect(metrics.perFile.map((f) => f.fileId)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

// ── V3-P1: metrics.clusters (community detection) ────────────────────────────
// Mirrors the determinism test above, because a non-deterministic partition would poison
// the SHA-keyed cache exactly the way non-deterministic ordering would.

describe("analyze — clusters (community detection)", () => {
  /** Two triangles joined by one bridge, plus the call weights the CPG contributes. */
  function twoClusterGraph(cpgEdges?: CpgEdge[]): RepoGraph {
    const base = repoGraph(
      ["a1.ts", "b1.ts", "a2.ts", "b2.ts", "a3.ts", "b3.ts"].map((path) => node(path)),
      [
        edge("a1.ts", "a2.ts"),
        edge("a2.ts", "a3.ts"),
        edge("a3.ts", "a1.ts"),
        edge("b1.ts", "b2.ts"),
        edge("b2.ts", "b3.ts"),
        edge("b3.ts", "b1.ts"),
        edge("a1.ts", "b1.ts"),
      ],
    );
    return cpgEdges ? { ...base, cpgEdges } : base;
  }

  it("surfaces communities as a first-class metrics field with modularity", async () => {
    const metrics = await analyze(twoClusterGraph());
    expect(metrics.clusters).toMatchObject({ algorithm: "louvain", count: 2, seed: 1, resolution: 1 });
    expect(metrics.clusters!.modularity).toBeGreaterThan(0.3);
    expect(metrics.clusters!.clusters.map((cluster) => cluster.files)).toEqual([
      ["a1.ts", "a2.ts", "a3.ts"],
      ["b1.ts", "b2.ts", "b3.ts"],
    ]);
  });

  it("assigns every graph node exactly once, sorted by fileId", async () => {
    const metrics = await analyze(twoClusterGraph());
    expect(metrics.clusters!.assignments.map((entry) => entry.fileId)).toEqual([
      "a1.ts",
      "a2.ts",
      "a3.ts",
      "b1.ts",
      "b2.ts",
      "b3.ts",
    ]);
  });

  it("the same graph run twice yields a byte-identical partition", async () => {
    const graph = twoClusterGraph();
    const first = JSON.stringify((await analyze(graph)).clusters);
    const second = JSON.stringify((await analyze(graph)).clusters);
    expect(first).toBe(second);
    expect(first).not.toBe("undefined");
  });

  it("partitions on the CPG UNION — call weight moves a file between modules", async () => {
    const nodes = ["a1.ts", "b1.ts", "a2.ts", "b2.ts", "a3.ts", "b3.ts", "x.ts"].map((path) => node(path));
    const edges = [
      edge("a1.ts", "a2.ts"),
      edge("a2.ts", "a3.ts"),
      edge("a3.ts", "a1.ts"),
      edge("b1.ts", "b2.ts"),
      edge("b2.ts", "b3.ts"),
      edge("b3.ts", "b1.ts"),
      edge("a1.ts", "b1.ts"),
      // x imports BOTH clusters equally — imports alone cannot place it.
      edge("x.ts", "a1.ts"),
      edge("x.ts", "b1.ts"),
    ];
    const graph: RepoGraph = {
      ...repoGraph(nodes, edges),
      cpgEdges: [{ from: "x.ts", to: "b1.ts", kind: "call", symbol: "heavy", count: 40, line: 1 }],
    };
    const metrics = await analyze(graph);
    const clusterOf = (fileId: string) =>
      metrics.clusters!.assignments.find((entry) => entry.fileId === fileId)?.cluster;
    expect(clusterOf("x.ts")).toBe(clusterOf("b1.ts"));
  });

  it("keeps the degree metrics import-only even though clusters use calls", async () => {
    // The documented asymmetry: fanIn/fanOut mean IMPORTS; clusters mean coupling.
    const graph: RepoGraph = {
      ...repoGraph([node("a.ts"), node("b.ts")], []),
      cpgEdges: [{ from: "a.ts", to: "b.ts", kind: "call", symbol: "fn", count: 9, line: 1 }],
    };
    const metrics = await analyze(graph);
    const a = metrics.perFile.find((file) => file.fileId === "a.ts");
    expect(a).toMatchObject({ fanIn: 0, fanOut: 0, centrality: 0 });
    expect(metrics.summary.edgeCount).toBe(0); // edgeCount is the DEPENDENCY edge count
    // ...but the call edge is real structure, so the two files cluster together.
    expect(metrics.clusters!.count).toBe(1);
  });

  it("omits clusters entirely for an empty graph (absent, not a fake partition)", async () => {
    const metrics = await analyze(repoGraph([], []));
    expect(metrics.clusters).toBeUndefined();
  });

  it("honours an injected seed / resolution", async () => {
    const stage = createAnalyzeStage({ now: () => 1000, communities: { seed: 42, resolution: 2 } });
    const { partial } = await stage.run(input, ctxFor(twoClusterGraph()));
    expect(partial.metrics!.clusters).toMatchObject({ seed: 42, resolution: 2 });
  });
});

describe("analyze — completeness, degenerate, boundary", () => {
  it("returns FULL keyFiles / perFile, nothing truncated", async () => {
    const nodes: FileNode[] = [];
    const edges: RepoDependencyEdge[] = [];
    for (let i = 0; i < 300; i++) nodes.push(node(`f${String(i).padStart(3, "0")}.ts`));
    for (let i = 0; i < 299; i++) edges.push(edge(`f${String(i).padStart(3, "0")}.ts`, `f${String(i + 1).padStart(3, "0")}.ts`));
    const metrics = await analyze(repoGraph(nodes, edges));
    expect(metrics.perFile).toHaveLength(300);
    expect(metrics.keyFiles).toHaveLength(300);
    expect(metrics.summary.fileCount).toBe(300);
  });

  it("an edgeless graph does not crash and reports sane zeros", async () => {
    const metrics = await analyze(repoGraph([node("solo.ts")], []));
    expect(metrics.perFile[0]).toMatchObject({ centrality: 0, fanIn: 0, fanOut: 0, blastRadius: 0 });
    expect(metrics.cycles).toEqual([]);
    expect(metrics.summary).toMatchObject({ edgeCount: 0, cycleCount: 0, isolatedFileCount: 1, maxBlastRadius: 0 });
  });

  it("an empty graph does not crash", async () => {
    const metrics = await analyze(repoGraph([], []));
    expect(metrics.perFile).toEqual([]);
    expect(metrics.keyFiles).toEqual([]);
    expect(metrics.summary.fileCount).toBe(0);
  });

  it("carries no prose / no AI fields — numbers only", async () => {
    const metrics = await analyze(repoGraph([node("a.ts")], []));
    // V3-P1 added `clusters` (the community partition) — still numbers + fileIds, no prose.
    expect(Object.keys(metrics).sort()).toEqual([
      "clusters",
      "cycles",
      "hotspots",
      "keyFiles",
      "perFile",
      "summary",
    ]);
    expect("ai" in metrics).toBe(false);
    expect("narrative" in metrics).toBe(false);
  });

  it("every perFile.fileId exists in graph.nodes", async () => {
    const graph = repoGraph([node("a.ts"), node("b.ts")], [edge("a.ts", "b.ts")]);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const metrics = await analyze(graph);
    expect(metrics.perFile.every((f) => nodeIds.has(f.fileId))).toBe(true);
  });

  it("throws if the graph slice is missing (Connect must run first)", async () => {
    const stage = createAnalyzeStage({ now: () => 1 });
    const ctx = ctxFor(repoGraph([], []));
    const noGraph: PipelineContext = { ...ctx, prior: {} };
    await expect(stage.run(input, noGraph)).rejects.toThrow(/graph/);
  });
});
