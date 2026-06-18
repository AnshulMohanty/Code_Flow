import { describe, expect, it } from "vitest";
import { buildDashboard } from "./dashboard";
import { mockAnalysisResult } from "./mockAnalysis";

describe("buildDashboard", () => {
  it("derives imports/importers from graph.edges and symbols from inventory (#19 rules)", () => {
    const model = buildDashboard(mockAnalysisResult());

    const index = model.files["src/index.ts"];
    expect(index.imports).toEqual(["src/auth.ts", "src/db.ts"]);

    const auth = model.files["src/auth.ts"];
    expect(auth.importers).toEqual(["src/index.ts"]);
    expect(auth.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["AuthService", "verifyToken"]));
    expect(auth.loc).toBe(64);
  });

  it("ranks complexity relatively (1 = most complex) with the bar fraction", () => {
    const model = buildDashboard(mockAnalysisResult());
    // src/auth.ts has the highest complexity (69) of the three with metrics.
    expect(model.files["src/auth.ts"].metrics?.complexityRank).toBe(1);
    expect(model.files["src/auth.ts"].metrics?.complexityRelative).toBe(1);
    expect(model.files["src/index.ts"].metrics!.complexityRank).toBeGreaterThan(1);
  });

  it("summarizes structure: layout + role counts + directory groups", () => {
    const model = buildDashboard(mockAnalysisResult());
    expect(model.structure.layout).toBe("src-rooted");
    const source = model.structure.roleCounts.find((r) => r.role === "source");
    expect(source?.count).toBe(3);
    expect(model.structure.byDirectory.some((g) => g.directory === "src")).toBe(true);
  });

  it("Start Here uses AI synthesis when present", () => {
    const model = buildDashboard(mockAnalysisResult());
    expect(model.startHere.available).toBe(true);
    expect(model.startHere.readingOrder.map((s) => s.fileId)).toEqual(["src/index.ts", "src/auth.ts"]);
  });

  it("Start Here degrades honestly to key-files + an 'at capacity' note when synthesis is absent", () => {
    const partial = mockAnalysisResult();
    delete (partial as { ai?: unknown }).ai; // budget-exhausted ⇒ no synthesis
    const model = buildDashboard(partial);

    expect(model.startHere.available).toBe(false);
    expect(model.startHere.fallbackNote).toMatch(/at capacity/i);
    expect(model.startHere.readingOrder.map((s) => s.fileId)).toEqual(["src/index.ts", "src/auth.ts", "src/db.ts"]);
  });

  it("grounds every neighbour link to a real node (no dangling)", () => {
    const model = buildDashboard(mockAnalysisResult());
    const ids = new Set(model.fileList.map((f) => f.id));
    for (const file of model.fileList) {
      for (const id of [...file.imports, ...file.importers]) expect(ids.has(id)).toBe(true);
    }
  });
});
