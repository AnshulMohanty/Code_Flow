import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../buildGraph.js";
import {
  getDirectDependencies,
  getDirectDependents,
  getTransitiveDependencies,
  getTransitiveDependents,
} from "../traversal.js";
import { dagAnalysis } from "./fixtures.js";

describe("traversal", () => {
  const graph = buildDependencyGraph(dagAnalysis);

  it("returns direct dependencies", () => {
    expect(getDirectDependencies(graph, "a").map((node) => node?.path)).toEqual(["src/b.ts"]);
  });

  it("returns direct dependents", () => {
    expect(getDirectDependents(graph, "b").map((node) => node?.path)).toEqual(["src/a.ts", "src/d.ts"]);
  });

  it("returns transitive dependencies", () => {
    expect(getTransitiveDependencies(graph, "a").map((item) => item.node.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("returns transitive dependents", () => {
    expect(getTransitiveDependents(graph, "c").map((item) => item.node.path)).toEqual(["src/b.ts", "src/a.ts", "src/d.ts"]);
  });
});
