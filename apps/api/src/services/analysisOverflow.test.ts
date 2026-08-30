import { describe, expect, it } from "vitest";
import type { AnalysisResult, CpgEdge, GraphEdge } from "@codeflow/shared-types";
import {
  BSON_DOCUMENT_LIMIT_BYTES,
  BSON_OVERHEAD_RATIO,
  describeMissingOverflow,
  estimateBsonBytes,
  jsonBytes,
  measureAnalysis,
  OVERFLOW_BUDGET_JSON_BYTES,
  OVERFLOW_CANDIDATES,
  rehydrateAnalysis,
  splitOverflow,
} from "./analysisOverflow.js";

/**
 * V3-P5 task 5 (ledger #20): measured, size-aware externalization.
 *
 * The budget is exercised with a SMALL configured budget rather than by building an 8 MB fixture:
 * the logic under test is "measure, shed in order, stop when it fits", which is identical at any
 * scale, and an 8 MB fixture would add ~30 seconds to the suite to test nothing extra. The real
 * 8 MB threshold is asserted separately as a constant, against the measured BSON ratio.
 */

function edge(i: number): GraphEdge {
  return {
    id: `e${i}`,
    from: `src/a${i}.ts`,
    to: `src/b${i}.ts`,
    type: "import",
    confidence: 1,
    evidence: `import './b${i}'`,
  };
}

function cpgEdge(i: number): CpgEdge {
  return { from: `src/a${i}.ts`, to: `src/b${i}.ts`, kind: "call", symbol: `fn${i}`, count: 1, line: i };
}

function resultWith(counts: { edges?: number; cpg?: number; routes?: number } = {}): AnalysisResult {
  return {
    id: "an-1",
    repository: { provider: "github", owner: "acme", name: "app" },
    warnings: [],
    graph: {
      nodes: [{ id: "src/a0.ts" }, { id: "src/b0.ts" }],
      edges: Array.from({ length: counts.edges ?? 2 }, (_, i) => edge(i)),
      resolution: { resolved: 2, unresolved: 0 },
      ...(counts.cpg ? { cpgEdges: Array.from({ length: counts.cpg }, (_, i) => cpgEdge(i)) } : {}),
      ...(counts.routes
        ? { routes: Array.from({ length: counts.routes }, (_, i) => ({ fileId: "src/a0.ts", path: `/r${i}`, method: "GET", line: i })) }
        : {}),
    },
  } as unknown as AnalysisResult;
}

describe("the measured constants", () => {
  it("uses the MEASURED BSON ratio, not an assumption that BSON equals JSON", () => {
    // Measured with BSON.calculateObjectSize over 1k/20k/100k/200k cpgEdges: 1.083, stable.
    // Comparing JSON.stringify().length against 16MB directly understates the real size by 8%.
    expect(BSON_OVERHEAD_RATIO).toBeCloseTo(1.083, 3);
    expect(estimateBsonBytes(1_000_000)).toBe(1_083_000);
  });

  it("keeps the budget comfortably below the hard limit once converted to BSON", () => {
    expect(estimateBsonBytes(OVERFLOW_BUDGET_JSON_BYTES)).toBeLessThan(BSON_DOCUMENT_LIMIT_BYTES);
    // Roughly half, which is the deliberate margin: the ratio was measured on one shape.
    expect(estimateBsonBytes(OVERFLOW_BUDGET_JSON_BYTES) / BSON_DOCUMENT_LIMIT_BYTES).toBeLessThan(0.6);
  });

  it("sheds cpgEdges FIRST and dependency edges LAST", () => {
    // Ordered by what a read needs, not by size: nothing in the default view touches cpgEdges,
    // while the dependency graph is the product's main visual.
    expect(OVERFLOW_CANDIDATES[0]).toBe("graph.cpgEdges");
    expect(OVERFLOW_CANDIDATES[OVERFLOW_CANDIDATES.length - 1]).toBe("graph.edges");
  });

  it("never makes graph.nodes a candidate, because grounding resolves citations against it", () => {
    // Externalising nodes would let a storage failure turn a valid citation into a rejected one —
    // converting a storage problem into a correctness problem.
    expect(OVERFLOW_CANDIDATES).not.toContain("graph.nodes" as never);
  });
});

describe("splitOverflow — the common case costs nothing", () => {
  it("leaves a small analysis completely untouched", () => {
    const result = resultWith({ edges: 3, cpg: 3 });
    const split = splitOverflow(result);
    expect(split.manifest).toBeNull();
    expect(split.payload).toEqual({});
    expect(split.stillTooLarge).toBeNull();
    // The SAME object, not a clone: cloning every analysis to serve the rare one would double peak
    // memory for nothing.
    expect(split.stored).toBe(result);
  });
});

describe("splitOverflow — over budget", () => {
  it("externalizes cpgEdges first and keeps dependency edges inline", () => {
    const result = resultWith({ edges: 5, cpg: 40 });
    const split = splitOverflow(result, { budgetJsonBytes: 1200 });
    expect(split.manifest?.fields).toEqual(["graph.cpgEdges"]);
    expect(split.stored.graph?.cpgEdges).toBeUndefined();
    expect(split.stored.graph?.edges).toHaveLength(5);
    expect(split.payload["graph.cpgEdges"]).toHaveLength(40);
  });

  it("STOPS as soon as the remainder fits, rather than shedding everything", () => {
    // This early stop is the whole difference from a blanket rule.
    const result = resultWith({ edges: 5, cpg: 200, routes: 5 });
    const split = splitOverflow(result, { budgetJsonBytes: 2000 });
    expect(split.manifest?.fields).toEqual(["graph.cpgEdges"]);
    expect(split.stored.graph?.routes).toHaveLength(5);
  });

  it("escalates through the order when one field is not enough", () => {
    const result = resultWith({ edges: 300, cpg: 300, routes: 300 });
    const split = splitOverflow(result, { budgetJsonBytes: 900 });
    expect(split.manifest?.fields).toEqual(["graph.cpgEdges", "graph.routes", "graph.edges"]);
    expect(split.stored.graph?.edges).toEqual([]);
  });

  it("does NOT mutate the caller's result", () => {
    // The same result object is returned to the user who requested the analysis; shedding fields
    // from it would serve them an incomplete one.
    const result = resultWith({ edges: 5, cpg: 40 });
    splitOverflow(result, { budgetJsonBytes: 1200 });
    expect(result.graph?.cpgEdges).toHaveLength(40);
  });

  it("skips an absent or empty candidate instead of manifesting it", () => {
    // Externalising `undefined` would make a rehydrate write the key back as present-but-empty,
    // which is exactly the "this repo has no calls" lie.
    const result = resultWith({ edges: 400 });
    const split = splitOverflow(result, { budgetJsonBytes: 900 });
    expect(split.manifest?.fields).toEqual(["graph.edges"]);
    expect(Object.keys(split.payload)).toEqual(["graph.edges"]);
  });

  it("reports stillTooLarge with the numbers AND the largest remaining fields", () => {
    // A driver error from Mongo names no field; this does.
    const result = resultWith({ edges: 2, cpg: 2 });
    const split = splitOverflow(result, { budgetJsonBytes: 10 });
    // Budget 10 forces a shed; the hard limit is what stillTooLarge tests, and this document is
    // nowhere near it — so it must be null.
    expect(split.stillTooLarge).toBeNull();
  });

  it("flags stillTooLarge when even a fully-shed result exceeds the hard limit", () => {
    const huge = resultWith({ edges: 2 });
    // A non-candidate field big enough to blow the limit on its own.
    // Sized to actually cross the ~14.8MB JSON equivalent of the 16MB BSON limit. Measured rather
    // than guessed: at ~130 bytes per entry it takes ~120k entries, so the fixture is deliberately
    // past that instead of near it.
    (huge as unknown as { files: unknown }).files = Array.from({ length: 140_000 }, (_, i) => ({
      id: `src/deeply/nested/path/to/some/module/number/${i}/index.ts`,
      language: "typescript",
      sizeBytes: 2048,
      loc: 120,
    }));
    const split = splitOverflow(huge, { budgetJsonBytes: 1000 });
    expect(split.stillTooLarge).toBeTruthy();
    expect(split.stillTooLarge).toMatch(/16MB document limit/);
    expect(split.stillTooLarge).toMatch(/files=/);
  });
});

describe("rehydrateAnalysis", () => {
  it("puts everything back", () => {
    const original = resultWith({ edges: 5, cpg: 40 });
    const split = splitOverflow(original, { budgetJsonBytes: 1200 });
    const { result, missing } = rehydrateAnalysis(split.stored, split.manifest, split.payload);
    expect(missing).toEqual([]);
    expect(result.graph?.cpgEdges).toHaveLength(40);
    // Byte-identical to what went in, which is the actual requirement.
    expect(JSON.stringify(result)).toBe(JSON.stringify(original));
  });

  it("restores every field of a multi-field split, including emptied edges", () => {
    const original = resultWith({ edges: 300, cpg: 300, routes: 300 });
    const split = splitOverflow(original, { budgetJsonBytes: 900 });
    const { result, missing } = rehydrateAnalysis(split.stored, split.manifest, split.payload);
    expect(missing).toEqual([]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(original));
  });

  it("is a no-op with no manifest", () => {
    const result = resultWith({ edges: 3 });
    expect(rehydrateAnalysis(result, null, null).result).toBe(result);
  });

  it("reports what it could NOT load and leaves the field ABSENT, not empty", () => {
    // The ambiguity this closes is named in shared-types: absent cpgEdges means "the parser could
    // not produce them", so an empty array here would be a false statement about the repository.
    const split = splitOverflow(resultWith({ edges: 5, cpg: 40 }), { budgetJsonBytes: 1200 });
    const { result, missing } = rehydrateAnalysis(split.stored, split.manifest, {});
    expect(missing).toEqual(["graph.cpgEdges"]);
    expect(result.graph?.cpgEdges).toBeUndefined();
    expect(Object.keys(result.graph ?? {})).not.toContain("cpgEdges");
  });

  it("restores what it can when the payload is PARTIAL", () => {
    const split = splitOverflow(resultWith({ edges: 300, cpg: 300, routes: 300 }), { budgetJsonBytes: 900 });
    const { result, missing } = rehydrateAnalysis(split.stored, split.manifest, {
      "graph.cpgEdges": split.payload["graph.cpgEdges"],
    });
    expect(missing).toEqual(["graph.routes", "graph.edges"]);
    expect(result.graph?.cpgEdges).toHaveLength(300);
  });

  it("does not throw when the overflow store is unreachable — a usable analysis beats an error", () => {
    const split = splitOverflow(resultWith({ edges: 5, cpg: 40 }), { budgetJsonBytes: 1200 });
    expect(() => rehydrateAnalysis(split.stored, split.manifest, null)).not.toThrow();
  });
});

describe("describeMissingOverflow", () => {
  it("says INCOMPLETE, not empty, so a storage failure is not read as a fact about the repo", () => {
    const message = describeMissingOverflow(["graph.cpgEdges"]);
    expect(message).toMatch(/INCOMPLETE/);
    expect(message).toMatch(/NOT because the repository has none of them/);
    expect(message).toMatch(/graph\.cpgEdges/);
  });
});

describe("measureAnalysis", () => {
  it("reports per-field bytes and counts, which is what the deferred large-repo measurement needs", () => {
    const measured = measureAnalysis(resultWith({ edges: 4, cpg: 7, routes: 2 }));
    expect(measured.totalJsonBytes).toBeGreaterThan(0);
    expect(measured.estimatedBsonBytes).toBeGreaterThan(measured.totalJsonBytes);
    const cpg = measured.fields.find((entry) => entry.field === "graph.cpgEdges");
    expect(cpg?.count).toBe(7);
    expect(cpg?.jsonBytes).toBeGreaterThan(0);
  });

  it("reports 0 bytes for an absent field rather than the string 'undefined'", () => {
    const measured = measureAnalysis(resultWith({ edges: 4 }));
    expect(measured.fields.find((entry) => entry.field === "graph.cpgEdges")?.jsonBytes).toBe(0);
  });

  it("jsonBytes measures UTF-8 bytes, not characters", () => {
    expect(jsonBytes("🙂")).toBeGreaterThan(4);
  });
});
