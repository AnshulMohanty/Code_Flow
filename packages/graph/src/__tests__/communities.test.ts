import { describe, expect, it } from "vitest";
import type { CpgEdge, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";
import { buildCodePropertyGraph, buildImportGraph } from "../codePropertyGraph.js";
import { detectCommunities, seededOrder } from "../communities.js";
import { computeCentrality } from "../centrality.js";
import { findCircularDependencies } from "../cycles.js";
import { detectHighCouplingFiles, detectIsolatedFiles } from "../coupling.js";
import { getBlastRadius } from "../blastRadius.js";
import { getTransitiveDependents } from "../traversal.js";
import { serializeGraphForUI } from "../serialization.js";

function node(id: string): FileNode {
  return { id, path: id, name: id, layer: "source", language: "TypeScript", lines: 10, symbolCount: 2 };
}

function edge(from: string, to: string): RepoDependencyEdge {
  return { from, to, kind: "import", specifier: `./${to}` };
}

function call(from: string, to: string, count: number, symbol = "fn"): CpgEdge {
  return { from, to, kind: "call", symbol, count, line: 1 };
}

/**
 * Two dense clusters joined by ONE bridge edge — the textbook case a correct community
 * detector must split. Files are named so lexicographic order does NOT match the cluster
 * boundary, which would otherwise let a broken implementation look right by accident.
 */
const TWO_CLUSTER_NODES = ["a1.ts", "b1.ts", "a2.ts", "b2.ts", "a3.ts", "b3.ts"].map(node);
const TWO_CLUSTER_EDGES: RepoDependencyEdge[] = [
  // cluster A: a1 <-> a2 <-> a3 <-> a1
  edge("a1.ts", "a2.ts"),
  edge("a2.ts", "a3.ts"),
  edge("a3.ts", "a1.ts"),
  // cluster B: b1 <-> b2 <-> b3 <-> b1
  edge("b1.ts", "b2.ts"),
  edge("b2.ts", "b3.ts"),
  edge("b3.ts", "b1.ts"),
  // one bridge
  edge("a1.ts", "b1.ts"),
];

describe("detectCommunities", () => {
  it("splits two dense clusters joined by a single bridge", () => {
    const graph = buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES });
    const partition = detectCommunities(graph);

    expect(partition.algorithm).toBe("louvain");
    expect(partition.count).toBe(2);
    const groups = partition.clusters.map((cluster) => cluster.files);
    expect(groups).toEqual([
      ["a1.ts", "a2.ts", "a3.ts"],
      ["b1.ts", "b2.ts", "b3.ts"],
    ]);
    // Meaningful structure: Q well above the ~0.3 rule of thumb.
    expect(partition.modularity).toBeGreaterThan(0.3);
  });

  it("assigns EVERY node exactly once (the assignment list is complete)", () => {
    const graph = buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES });
    const partition = detectCommunities(graph);

    expect(partition.assignments).toHaveLength(TWO_CLUSTER_NODES.length);
    expect(partition.assignments.map((entry) => entry.fileId)).toEqual(
      [...TWO_CLUSTER_NODES.map((n) => n.id)].sort(),
    );
    const sizes = partition.clusters.reduce((sum, cluster) => sum + cluster.size, 0);
    expect(sizes).toBe(TWO_CLUSTER_NODES.length);
    // Assignments and cluster membership agree.
    for (const entry of partition.assignments) {
      expect(partition.clusters[entry.cluster].files).toContain(entry.fileId);
    }
  });

  it("reports internal vs external weight per community", () => {
    const graph = buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES });
    const partition = detectCommunities(graph);
    for (const cluster of partition.clusters) {
      // 3 internal edges each, 1 bridge leaving.
      expect(cluster.internalWeight).toBe(3);
      expect(cluster.externalWeight).toBe(1);
    }
  });

  it("gives each isolated node its own community rather than dropping or merging it", () => {
    const nodes = ["lonely-a.ts", "lonely-b.ts"].map(node);
    const partition = detectCommunities(buildImportGraph({ nodes, edges: [] }));
    expect(partition.count).toBe(2);
    expect(partition.modularity).toBe(0); // no edges ⇒ modularity is undefined-as-zero
    expect(partition.assignments).toHaveLength(2);
  });

  it("handles an empty graph without throwing", () => {
    const partition = detectCommunities(buildImportGraph({ nodes: [], edges: [] }));
    expect(partition).toMatchObject({ count: 0, modularity: 0, clusters: [], assignments: [] });
  });

  it("numbers communities canonically: size descending, then lowest member fileId", () => {
    const nodes = ["z1.ts", "z2.ts", "z3.ts", "a1.ts", "a2.ts"].map(node);
    const edges = [
      // 3-node cluster whose lowest id sorts LAST
      edge("z1.ts", "z2.ts"),
      edge("z2.ts", "z3.ts"),
      edge("z3.ts", "z1.ts"),
      // 2-node cluster whose lowest id sorts FIRST
      edge("a1.ts", "a2.ts"),
      edge("a2.ts", "a1.ts"),
    ];
    const partition = detectCommunities(buildImportGraph({ nodes, edges }));
    // Bigger cluster wins id 0 even though its ids sort later.
    expect(partition.clusters[0].files).toEqual(["z1.ts", "z2.ts", "z3.ts"]);
    expect(partition.clusters[1].files).toEqual(["a1.ts", "a2.ts"]);
  });
});

describe("detectCommunities — determinism (load-bearing for the SHA-keyed cache)", () => {
  it("run twice ⇒ byte-identical partition", () => {
    const graph = buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES });
    const first = detectCommunities(graph);
    const second = detectCommunities(graph);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is insensitive to the ORDER nodes and edges arrive in", () => {
    const forward = detectCommunities(buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES }));
    const reversed = detectCommunities(
      buildImportGraph({ nodes: [...TWO_CLUSTER_NODES].reverse(), edges: [...TWO_CLUSTER_EDGES].reverse() }),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("uses NO randomness: a rebuilt graph in a fresh process-independent order matches", () => {
    // Same topology, different object identities and insertion order.
    const rebuilt = buildImportGraph({
      nodes: ["b3.ts", "a3.ts", "b2.ts", "a2.ts", "b1.ts", "a1.ts"].map(node),
      edges: [
        edge("a1.ts", "b1.ts"),
        edge("b3.ts", "b1.ts"),
        edge("a3.ts", "a1.ts"),
        edge("b2.ts", "b3.ts"),
        edge("a2.ts", "a3.ts"),
        edge("b1.ts", "b2.ts"),
        edge("a1.ts", "a2.ts"),
      ],
    });
    const original = detectCommunities(buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES }));
    expect(JSON.stringify(detectCommunities(rebuilt))).toBe(JSON.stringify(original));
  });

  it("records the seed and resolution it used, and a different seed still converges", () => {
    const graph = buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES });
    const seeded = detectCommunities(graph, { seed: 99, resolution: 1 });
    expect(seeded).toMatchObject({ seed: 99, resolution: 1 });
    // A different visit order must not change a partition this clear-cut.
    expect(seeded.clusters.map((cluster) => cluster.files)).toEqual([
      ["a1.ts", "a2.ts", "a3.ts"],
      ["b1.ts", "b2.ts", "b3.ts"],
    ]);
  });

  it("seededOrder is a deterministic permutation of the sorted ids", () => {
    const ids = ["c", "a", "b", "e", "d"];
    expect(seededOrder(ids, 1)).toEqual(seededOrder(ids, 1));
    expect([...seededOrder(ids, 1)].sort()).toEqual(["a", "b", "c", "d", "e"]);
    // Different seeds genuinely permute differently (otherwise the seed is decorative).
    expect(seededOrder(ids, 1)).not.toEqual(seededOrder(ids, 7));
  });

  it("a higher resolution partitions more finely", () => {
    const coarse = detectCommunities(
      buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES }),
      { resolution: 0.5 },
    );
    const fine = detectCommunities(buildImportGraph({ nodes: TWO_CLUSTER_NODES, edges: TWO_CLUSTER_EDGES }), {
      resolution: 5,
    });
    expect(fine.count).toBeGreaterThanOrEqual(coarse.count);
  });
});

describe("code property graph — weights and algorithm compatibility", () => {
  it("call-edge weight pulls a file into the cluster it actually calls into", () => {
    // Structurally, x.ts imports BOTH clusters. Only the call counts say where it belongs.
    const nodes = [...TWO_CLUSTER_NODES, node("x.ts")];
    const edges = [...TWO_CLUSTER_EDGES, edge("x.ts", "a1.ts"), edge("x.ts", "b1.ts")];
    const cpgEdges = [call("x.ts", "b1.ts", 40, "heavy")];

    const withoutWeights = detectCommunities(buildImportGraph({ nodes, edges }));
    const withWeights = detectCommunities(buildCodePropertyGraph({ nodes, edges, cpgEdges }));

    const clusterOf = (partition: { assignments: Array<{ fileId: string; cluster: number }> }, file: string) =>
      partition.assignments.find((entry) => entry.fileId === file)?.cluster;
    const sameCluster = (partition: Parameters<typeof clusterOf>[0], one: string, two: string) =>
      clusterOf(partition, one) === clusterOf(partition, two);

    // With 40 calls into b1, x belongs with cluster B.
    expect(sameCluster(withWeights, "x.ts", "b1.ts")).toBe(true);
    // The unweighted import graph cannot tell the two apart — which is the point of the CPG.
    expect(withoutWeights.count).toBeGreaterThan(0);
  });

  it("carries CPG edge weight and type onto the built graph", () => {
    const graph = buildCodePropertyGraph({
      nodes: [node("a.ts"), node("b.ts")],
      edges: [edge("a.ts", "b.ts")],
      cpgEdges: [call("a.ts", "b.ts", 7, "helper"), { from: "a.ts", to: "b.ts", kind: "extends", symbol: "Base", count: 1, line: 3 }],
    });
    const byType = new Map(graph.edges.map((e) => [e.type, e]));
    expect(byType.get("import")?.weight).toBe(1);
    expect(byType.get("call")?.weight).toBe(7);
    expect(byType.get("extends")?.weight).toBe(1);
    expect(byType.get("call")?.evidence).toBe("helper");
    expect(byType.get("extends")?.sourceLine).toBe(3);
  });

  it("EVERY existing graph algorithm still works on the richer graph", () => {
    const nodes = [node("a.ts"), node("b.ts"), node("c.ts")];
    const edges = [edge("a.ts", "b.ts"), edge("b.ts", "c.ts"), edge("c.ts", "a.ts")];
    const cpgEdges = [call("a.ts", "b.ts", 5), call("b.ts", "c.ts", 2)];
    const rich = buildCodePropertyGraph({ nodes, edges, cpgEdges });

    // Centrality, cycles, isolation, coupling, blast radius, traversal, serialization.
    expect(computeCentrality(rich)).toHaveLength(3);
    expect(findCircularDependencies(rich).length).toBeGreaterThan(0);
    expect(detectIsolatedFiles(rich)).toEqual([]);
    expect(() => detectHighCouplingFiles(rich)).not.toThrow();
    expect(getBlastRadius(rich, "b.ts").affectedCount).toBeGreaterThan(0);
    expect(getTransitiveDependents(rich, "c.ts").length).toBeGreaterThan(0);
    expect(serializeGraphForUI(rich).summary.nodeCount).toBe(3);
  });

  it("lets a caller traverse ONLY dependency edges on the richer graph", () => {
    const nodes = [node("a.ts"), node("b.ts"), node("c.ts")];
    // a imports b; a only CALLS into c (no import edge to c).
    const rich = buildCodePropertyGraph({
      nodes,
      edges: [edge("a.ts", "b.ts")],
      cpgEdges: [call("a.ts", "c.ts", 3)],
    });
    const importOnly = getTransitiveDependents(rich, "b.ts", { includeTypes: ["import"] });
    const callOnly = getTransitiveDependents(rich, "c.ts", { includeTypes: ["call"] });
    expect(importOnly.map((r) => r.node.id)).toEqual(["a.ts"]);
    expect(callOnly.map((r) => r.node.id)).toEqual(["a.ts"]);
    // ...and filtering to imports hides the call-only relationship.
    expect(getTransitiveDependents(rich, "c.ts", { includeTypes: ["import"] })).toEqual([]);
  });

  it("ignores a dangling CPG edge rather than inventing a node", () => {
    const graph = buildCodePropertyGraph({
      nodes: [node("a.ts")],
      edges: [],
      cpgEdges: [call("a.ts", "ghost.ts", 3)],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["a.ts"]);
    expect(graph.edges).toEqual([]);
    expect(graph.warnings.length).toBeGreaterThan(0);
    expect(detectCommunities(graph).count).toBe(1);
  });
});
