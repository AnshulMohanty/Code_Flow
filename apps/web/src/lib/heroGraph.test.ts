import { describe, expect, it } from "vitest";
import type { GraphModel } from "./graphModel";
import { areaOf, buildHeroGraph, downstreamOf, heroLabel } from "./heroGraph";

/**
 * The hero map's numbers are the ones a reader sees on hover, so they are checked against the
 * graph by hand: downstream = every module that transitively imports this one, hops = how far the
 * furthest of them is — over the FULL graph, not just the drawn part.
 */

function model(edges: Array<[string, string]>, extra: string[] = []): GraphModel {
  const ids = [...new Set([...edges.flat(), ...extra])];
  return {
    nodes: ids.map((id) => ({ id, path: id, name: id.split("/").pop()!, role: "source", centrality: 0, loc: 0, inCycle: false, size: 1 })),
    links: edges.map(([source, target]) => ({ source, target, kind: "import" as const, inCycle: false })),
    nodeCount: ids.length,
    linkCount: edges.length,
    unresolvedCount: 0,
    externalCount: 0,
  };
}

describe("buildHeroGraph", () => {
  // app → api → core ← cli ; core → util
  const graph = model(
    [
      ["src/app.ts", "src/api.ts"],
      ["src/api.ts", "src/core.ts"],
      ["src/cli.ts", "src/core.ts"],
      ["src/core.ts", "src/util.ts"],
    ],
    ["README.md"],
  );

  it("reports the true downstream count and hop depth on hover", () => {
    const layout = buildHeroGraph(graph);
    const util = layout.nodes.find((node) => node.id === "src/util.ts")!;
    // core, api, cli, app all reach util; app is 3 hops away.
    expect(util.downstream).toBe(4);
    expect(util.hops).toBe(3);
    const app = layout.nodes.find((node) => node.id === "src/app.ts")!;
    expect(app.downstream).toBe(0);
  });

  it("puts the most foundational module at the centre ring", () => {
    const layout = buildHeroGraph(graph);
    const util = layout.nodes.find((node) => node.id === "src/util.ts")!;
    expect(util.ring).toBe(0);
    expect(Math.max(...layout.nodes.map((node) => node.ring))).toBeGreaterThan(0);
  });

  it("never draws an isolated file, and states the cut against the full count", () => {
    const layout = buildHeroGraph(graph);
    expect(layout.nodes.map((node) => node.id)).not.toContain("README.md");
    expect(layout.drawn).toBe(5);
    expect(layout.total).toBe(6);
  });

  it("draws only real edges between drawn modules", () => {
    const layout = buildHeroGraph(graph);
    expect(layout.edges).toHaveLength(4);
    for (const edge of layout.edges) {
      const from = layout.nodes[edge.from].id;
      const to = layout.nodes[edge.to].id;
      expect(graph.links.some((link) => link.source === from && link.target === to)).toBe(true);
    }
  });

  it("computes hover figures over the FULL graph even when the drawing is capped", () => {
    const layout = buildHeroGraph(graph, 2);
    const util = layout.nodes.find((node) => node.id === "src/util.ts");
    if (util) expect(util.downstream).toBe(4);
    expect(layout.drawn).toBe(2);
  });

  it("is deterministic", () => {
    expect(buildHeroGraph(graph)).toEqual(buildHeroGraph(graph));
  });
});

describe("labels and areas", () => {
  it("names an index file by its package", () => {
    expect(heroLabel("packages/shared-types/src/index.ts")).toBe("shared-types");
    expect(heroLabel("apps/web/src/site/HeroGraph.tsx")).toBe("site/HeroGraph");
    expect(heroLabel("pkg/__init__.py")).toBe("pkg");
  });

  it("groups by package in a monorepo and by top directory otherwise", () => {
    expect(areaOf("packages/graph/src/x.ts")).toBe("packages/graph");
    expect(areaOf("src/lib/x.ts")).toBe("src");
    expect(areaOf("README.md")).toBe("(root)");
  });

  it("downstreamOf counts each importer once, at its shortest distance", () => {
    const importers = new Map([
      ["c", ["b", "a"]],
      ["b", ["a"]],
      ["a", []],
    ]);
    const result = downstreamOf(importers, "c");
    expect(result.count).toBe(2);
    expect(result.byHop.get("a")).toBe(1);
    expect(result.hops).toBe(1);
  });
});
