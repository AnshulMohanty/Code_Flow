import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../buildGraph.js";
import { detectHighCouplingFiles, detectIsolatedFiles } from "../coupling.js";
import { serializeGraphForUI } from "../serialization.js";
import { dagAnalysis } from "./fixtures.js";

describe("coupling", () => {
  const graph = buildDependencyGraph(dagAnalysis);

  it("detects high coupling files", () => {
    const coupled = detectHighCouplingFiles(graph, { incoming: 2, outgoing: 2, totalDegree: 3, blastRadius: 3 });

    expect(coupled.map((item) => item.path)).toContain("src/b.ts");
    expect(coupled.find((item) => item.path === "src/b.ts")?.reasons.length).toBeGreaterThan(0);
  });

  it("detects isolated files", () => {
    expect(detectIsolatedFiles(graph).map((node) => node.path)).toEqual(["src/isolated.ts"]);
  });

  it("serializes JSON-safe nodes, links, and summary", () => {
    const serialized = serializeGraphForUI(graph);
    const encoded = JSON.stringify(serialized);

    expect(JSON.parse(encoded)).toEqual(
      expect.objectContaining({
        nodes: expect.any(Array),
        links: expect.any(Array),
        summary: expect.objectContaining({
          nodeCount: 5,
          edgeCount: 3,
          isolatedFileCount: 1,
        }),
      }),
    );
  });
});
