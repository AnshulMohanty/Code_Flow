import { describe, expect, it } from "vitest";
import { PARITY_CORPUS } from "../parity/corpus.js";
import { metric, PARITY_GATES, runParserParity } from "../parity/parserParity.js";

// Hermetic: authored source strings + local grammar wasm. No clone, no keys, no network.
// This is the acceptance gate for the regex → tree-sitter swap, so it belongs in CI, not
// only in the CLI.
const report = await runParserParity();

describe("parser parity (tree-sitter vs regex, against authored ground truth)", () => {
  it("actually ran tree-sitter for every language in the corpus", () => {
    // Guards against a silent all-fallback run reporting a meaningless tie.
    const treeSitterCases = report.perCase.filter((result) => result.engine === "treesitter");
    expect(treeSitterCases).toHaveLength(PARITY_CORPUS.length);
    for (const result of treeSitterCases) {
      expect(result.parserVersion).toBe("treesitter-v1");
    }
    expect(report.perCase.filter((result) => result.engine === "regex").every((r) => r.parserVersion === "parser-v1")).toBe(
      true,
    );
  });

  it("is parity-or-better on every gated metric", () => {
    expect(report.regressions).toEqual([]);
    expect(report.treeSitterAtLeastAsGood).toBe(true);
  });

  it("gates full-truth precision/recall/F1 but only the recall FLOOR on the partial core set", () => {
    // Documents why coreSymbols.precision is excluded: its truth set is partial, so
    // correctly finding extra symbols would score as imprecision.
    expect(PARITY_GATES).toEqual(
      expect.arrayContaining([
        { dimension: "symbols", measure: "precision" },
        { dimension: "symbols", measure: "recall" },
        { dimension: "imports", measure: "precision" },
        { dimension: "imports", measure: "recall" },
        { dimension: "coreSymbols", measure: "recall" },
      ]),
    );
    expect(PARITY_GATES).not.toEqual(
      expect.arrayContaining([{ dimension: "coreSymbols", measure: "precision" }]),
    );
  });

  it("loses nothing the regex engine used to find (core-symbol recall floor)", () => {
    expect(report.totals.treesitter.coreSymbols.recall).toBeGreaterThanOrEqual(
      report.totals.regex.coreSymbols.recall,
    );
  });

  it("is a strict improvement, not a wash — the regex baseline really does miss things", () => {
    // If the baseline scored perfectly the corpus would prove nothing.
    expect(report.totals.regex.symbols.recall).toBeLessThan(1);
    expect(report.totals.treesitter.symbols.recall).toBeGreaterThan(report.totals.regex.symbols.recall);
    expect(report.totals.treesitter.imports.precision).toBeGreaterThan(report.totals.regex.imports.precision);
  });

  it("finds every authored symbol and import with no fabrications", () => {
    expect(report.totals.treesitter.symbols.missed).toEqual([]);
    expect(report.totals.treesitter.symbols.spurious).toEqual([]);
    expect(report.totals.treesitter.imports.missed).toEqual([]);
    expect(report.totals.treesitter.imports.spurious).toEqual([]);
  });

  it("is deterministic — a second run scores byte-identically", async () => {
    const second = await runParserParity();
    expect(JSON.stringify(second)).toBe(JSON.stringify(report));
  });
});

describe("parity metric", () => {
  it("scores set precision/recall and collapses duplicates", () => {
    const scored = metric(["a", "b", "c"], ["a", "a", "b", "z"]);
    expect(scored).toEqual(
      expect.objectContaining({
        expected: 3,
        found: 3, // {a, b, z}
        truePositives: 2,
        missed: ["c"],
        spurious: ["z"],
      }),
    );
    expect(scored.recall).toBeCloseTo(2 / 3);
    expect(scored.precision).toBeCloseTo(2 / 3);
  });

  it("treats an empty truth set as satisfied and an empty finding set as a miss", () => {
    expect(metric([], []).recall).toBe(1);
    expect(metric([], []).precision).toBe(1);
    expect(metric(["a"], []).recall).toBe(0);
    expect(metric(["a"], []).precision).toBe(0);
  });
});
