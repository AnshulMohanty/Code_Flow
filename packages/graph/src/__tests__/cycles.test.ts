import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../buildGraph.js";
import { findCircularDependencies } from "../cycles.js";
import { cycleAnalysis, dagAnalysis, longerCycleAnalysis } from "./fixtures.js";

describe("findCircularDependencies", () => {
  it("finds a simple cycle", () => {
    const cycles = findCircularDependencies(buildDependencyGraph(cycleAnalysis()));

    expect(cycles).toEqual([["src/a.ts", "src/b.ts", "src/c.ts"]]);
  });

  it("finds a longer cycle", () => {
    const cycles = findCircularDependencies(buildDependencyGraph(longerCycleAnalysis()));

    expect(cycles).toEqual([["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]]);
  });

  it("returns no false cycle for a DAG", () => {
    expect(findCircularDependencies(buildDependencyGraph(dagAnalysis))).toEqual([]);
  });
});
