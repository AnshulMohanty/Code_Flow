import { describe, expect, it } from "vitest";
import { getBlastRadius } from "../blastRadius.js";
import { buildDependencyGraph } from "../buildGraph.js";
import { dagAnalysis, files, edge } from "./fixtures.js";

describe("getBlastRadius", () => {
  it("uses reverse dependency traversal", () => {
    const graph = buildDependencyGraph(dagAnalysis);
    const radius = getBlastRadius(graph, "c");

    expect(radius.selectedFile).toBe("src/c.ts");
    expect(radius.directDependents.map((node) => node?.path)).toEqual(["src/b.ts"]);
    expect(radius.transitiveDependents.map((node) => node.path)).toEqual(["src/b.ts", "src/a.ts", "src/d.ts"]);
    expect(radius.affectedCount).toBe(3);
    expect(radius.maxDepth).toBe(2);
  });

  it("respects maxDepth and minConfidence", () => {
    const graph = buildDependencyGraph({
      files: files.slice(0, 3),
      dependencies: [edge("a-b", "a", "b", 1), edge("b-c", "b", "c", 0.4)],
    });

    expect(getBlastRadius(graph, "c", { minConfidence: 0.8 }).affectedCount).toBe(0);
    expect(getBlastRadius(graph, "c", { maxDepth: 1 }).transitiveDependents.map((node) => node.path)).toEqual([
      "src/b.ts",
    ]);
  });
});
