import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../buildGraph.js";
import { dagAnalysis, edge, files, parsedFiles } from "./fixtures.js";

describe("buildDependencyGraph", () => {
  it("creates nodes and edges from an AnalysisResult", () => {
    const graph = buildDependencyGraph(dagAnalysis);

    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodeById.get("a")?.path).toBe("src/a.ts");
    expect(graph.outgoing.get("a")?.map((item) => item.to)).toEqual(["b"]);
    expect(graph.incoming.get("b")?.map((item) => item.from)).toEqual(["a", "d"]);
  });

  it("creates nodes and edges from ParsedFile input", () => {
    const graph = buildDependencyGraph(parsedFiles);

    expect(graph.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.edges[0]).toEqual(expect.objectContaining({ from: graph.nodes[0].id, to: graph.nodes[1].id }));
  });

  it("deduplicates duplicate edges", () => {
    const graph = buildDependencyGraph({
      files: files.slice(0, 2),
      dependencies: [edge("one", "a", "b", 1), edge("two", "a", "b", 1)],
    });

    expect(graph.edges).toHaveLength(1);
  });
});
