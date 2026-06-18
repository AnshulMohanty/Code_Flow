import { describe, expect, it } from "vitest";
import { normalizeAnalysisResult } from "./analysisNormalizer";
import { mockAnalysisResult } from "./mockAnalysis";

describe("analysisNormalizer — derives from graph + inventory (#19)", () => {
  it("derives imports from graph.edges and functions/exports from inventory (NOT the empty legacy projections)", () => {
    const result = mockAnalysisResult();
    // Precondition: the legacy flat projections are intentionally empty.
    expect(result.dependencies).toEqual([]);
    expect(result.symbols).toEqual([]);

    const web = normalizeAnalysisResult(result);

    const index = web.files.find((f) => f.path === "src/index.ts")!;
    expect(index.imports).toEqual(["src/auth.ts", "src/db.ts"]); // from graph.edges

    const auth = web.files.find((f) => f.path === "src/auth.ts")!;
    expect(auth.functions).toEqual(expect.arrayContaining(["AuthService", "verifyToken"])); // from inventory
    expect(auth.exports).toEqual(expect.arrayContaining(["AuthService", "verifyToken"]));

    // Entry points from inventory; graph counts from nodes/edges.
    expect(web.entryPoints).toContain("src/index.ts");
    expect(web.graph).toEqual({ nodes: 4, edges: 2 });
    expect(web.metrics.languages).toEqual(expect.arrayContaining(["TypeScript", "Markdown"]));
  });

  it("falls back to graph.nodes when result.files is the only node source", () => {
    const result = mockAnalysisResult();
    const web = normalizeAnalysisResult(result);
    expect(web.files).toHaveLength(result.graph!.nodes.length);
  });
});
