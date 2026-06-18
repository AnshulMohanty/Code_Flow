import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../buildGraph.js";
import { computeCentrality } from "../centrality.js";
import { dagAnalysis } from "./fixtures.js";

describe("computeCentrality", () => {
  it("computes in and out degree correctly", () => {
    const scores = computeCentrality(buildDependencyGraph(dagAnalysis));
    const byId = new Map(scores.map((score) => [score.id, score]));

    expect(byId.get("b")).toEqual(
      expect.objectContaining({
        inDegree: 2,
        outDegree: 1,
        totalDegree: 3,
        dependentCount: 2,
        dependencyCount: 1,
      }),
    );
    expect(byId.get("isolated")).toEqual(expect.objectContaining({ totalDegree: 0 }));
  });
});
