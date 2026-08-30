// Parser-parity scoring: run BOTH engines over the authored corpus and grade each against
// the human ground truth. This is the acceptance measurement for the regex → tree-sitter
// swap: it says which engine is more accurate, per construct, rather than just showing
// that the two disagree.
//
// Fully hermetic: no repo clone, no embedding provider, no keys. Runs in CI.

import {
  createParserRegistry,
  createTreeSitterParser,
  genericParser,
  initTreeSitter,
  javascriptParser,
  jsxParser,
  ParserRegistry,
  pythonParser,
  tsxParser,
  typescriptParser,
} from "@codeflow/parsers";
import type { ParsedFile } from "@codeflow/shared-types";
import { PARITY_CORPUS, type ParityCase } from "./corpus.js";

export type ParityEngine = "regex" | "treesitter";

/** Precision / recall / F1 of one engine's findings against the authored truth. */
export interface ParityMetric {
  expected: number;
  found: number;
  truePositives: number;
  /** Truth items the engine missed. */
  missed: string[];
  /** Findings that are not in the truth set (fabrications / noise). */
  spurious: string[];
  precision: number;
  recall: number;
  f1: number;
}

export interface ParityCaseResult {
  id: string;
  path: string;
  note: string;
  engine: ParityEngine;
  /** Which engine actually produced the output (`treesitter-v1` / `parser-v1`). */
  parserVersion: string;
  symbols: ParityMetric;
  /** Recall over only the constructs the legacy regex parser targeted — the parity floor. */
  coreSymbols: ParityMetric;
  imports: ParityMetric;
}

export interface ParityEngineSummary {
  engine: ParityEngine;
  symbols: ParityMetric;
  coreSymbols: ParityMetric;
  imports: ParityMetric;
}

export interface ParityReport {
  corpusSize: number;
  perCase: ParityCaseResult[];
  totals: Record<ParityEngine, ParityEngineSummary>;
  /** True when tree-sitter is at least as good as regex on every GATED metric. */
  treeSitterAtLeastAsGood: boolean;
  /** Every gated metric where tree-sitter is strictly worse (empty ⇒ parity held). */
  regressions: string[];
  /** The gated (dimension, measure) pairs, so the verdict's basis is explicit. */
  gates: Array<{ dimension: ParityDimension; measure: ParityMeasure }>;
  summary: string;
}

export type ParityDimension = "symbols" | "coreSymbols" | "imports";
export type ParityMeasure = "precision" | "recall" | "f1";

/**
 * Which metrics the verdict is allowed to rest on.
 *
 * `symbols` and `imports` are graded against COMPLETE truth, so precision, recall and F1
 * all mean what they say. `coreSymbols` is graded against a deliberately PARTIAL truth
 * set (only the constructs the legacy regex parser targeted), so an engine that correctly
 * finds a class method or a top-level const scores it as "spurious". Precision and F1 are
 * therefore meaningless there and are NOT gated: `coreSymbols` exists purely as a RECALL
 * FLOOR — tree-sitter must not lose anything the regex engine used to find. The per-case
 * `coreSymbols.spurious` list is still reported, as information, not as a fault.
 */
export const PARITY_GATES: Array<{ dimension: ParityDimension; measure: ParityMeasure }> = [
  { dimension: "symbols", measure: "precision" },
  { dimension: "symbols", measure: "recall" },
  { dimension: "symbols", measure: "f1" },
  { dimension: "imports", measure: "precision" },
  { dimension: "imports", measure: "recall" },
  { dimension: "imports", measure: "f1" },
  { dimension: "coreSymbols", measure: "recall" },
];

/** A registry wired to the REGEX engine only — the pre-Phase-1 baseline. */
export function createRegexRegistry(): ParserRegistry {
  return createParserRegistry([
    javascriptParser,
    jsxParser,
    typescriptParser,
    tsxParser,
    pythonParser,
    genericParser,
  ]);
}

/** A registry wired to tree-sitter (with the regex engines as per-language fallbacks). */
export function createTreeSitterRegistry(): ParserRegistry {
  return createParserRegistry([
    createTreeSitterParser(javascriptParser),
    createTreeSitterParser(jsxParser),
    createTreeSitterParser(typescriptParser),
    createTreeSitterParser(tsxParser),
    createTreeSitterParser(pythonParser),
    genericParser,
  ]);
}

/**
 * Score both engines over `corpus`. Loads the tree-sitter grammars first; if they cannot
 * load, the tree-sitter registry falls back to regex and the report says so through
 * `parserVersion` (rather than silently reporting a tie).
 */
export async function runParserParity(corpus: ParityCase[] = PARITY_CORPUS): Promise<ParityReport> {
  await initTreeSitter();
  const registries: Record<ParityEngine, ParserRegistry> = {
    regex: createRegexRegistry(),
    treesitter: createTreeSitterRegistry(),
  };

  const perCase: ParityCaseResult[] = [];
  for (const parityCase of corpus) {
    for (const engine of ["regex", "treesitter"] as const) {
      const parsed = registries[engine].parseFile({ path: parityCase.path, content: parityCase.content });
      perCase.push(scoreCase(parityCase, engine, parsed));
    }
  }

  const totals: Record<ParityEngine, ParityEngineSummary> = {
    regex: aggregate("regex", perCase),
    treesitter: aggregate("treesitter", perCase),
  };

  const regressions: string[] = [];
  for (const { dimension, measure } of PARITY_GATES) {
    const treeSitterValue = totals.treesitter[dimension][measure];
    const regexValue = totals.regex[dimension][measure];
    // Tolerance guards against float noise only, not against a real drop.
    if (treeSitterValue < regexValue - 1e-9) {
      regressions.push(
        `${dimension}.${measure}: treesitter ${treeSitterValue.toFixed(4)} < regex ${regexValue.toFixed(4)}`,
      );
    }
  }

  const treeSitterAtLeastAsGood = regressions.length === 0;
  return {
    corpusSize: corpus.length,
    perCase,
    totals,
    treeSitterAtLeastAsGood,
    regressions,
    gates: PARITY_GATES,
    summary: formatSummary(totals, treeSitterAtLeastAsGood, regressions, corpus.length),
  };
}

function scoreCase(parityCase: ParityCase, engine: ParityEngine, parsed: ParsedFile): ParityCaseResult {
  const foundSymbols = parsed.symbols.map((symbol) => symbol.name);
  const foundImports = parsed.imports.map((parsedImport) => parsedImport.source);
  return {
    id: parityCase.id,
    path: parityCase.path,
    note: parityCase.note,
    engine,
    parserVersion: parsed.parserVersion,
    symbols: metric(parityCase.expectedSymbols, foundSymbols),
    // Core recall only: an engine finding MORE than the legacy target set is not a
    // precision fault, so `spurious` here is informational, not penalised.
    coreSymbols: metric(parityCase.expectedCoreSymbols, foundSymbols),
    imports: metric(parityCase.expectedImports, foundImports),
  };
}

/** Set-based precision/recall. Duplicates are collapsed: "did the engine find it" is the
 *  question, not how many times a line matched. */
export function metric(expected: string[], found: string[]): ParityMetric {
  const expectedSet = new Set(expected);
  const foundSet = new Set(found);
  const truePositives = [...expectedSet].filter((item) => foundSet.has(item));
  const missed = [...expectedSet].filter((item) => !foundSet.has(item)).sort();
  const spurious = [...foundSet].filter((item) => !expectedSet.has(item)).sort();
  const precision = foundSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositives.length / foundSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositives.length / expectedSet.size;
  return {
    expected: expectedSet.size,
    found: foundSet.size,
    truePositives: truePositives.length,
    missed,
    spurious,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

/** Micro-average across the corpus (pooled counts, so a big file is not down-weighted). */
function aggregate(engine: ParityEngine, perCase: ParityCaseResult[]): ParityEngineSummary {
  const cases = perCase.filter((result) => result.engine === engine);
  return {
    engine,
    symbols: pool(cases.map((result) => result.symbols)),
    coreSymbols: pool(cases.map((result) => result.coreSymbols)),
    imports: pool(cases.map((result) => result.imports)),
  };
}

function pool(metrics: ParityMetric[]): ParityMetric {
  const expected = sum(metrics.map((entry) => entry.expected));
  const found = sum(metrics.map((entry) => entry.found));
  const truePositives = sum(metrics.map((entry) => entry.truePositives));
  const precision = found === 0 ? (expected === 0 ? 1 : 0) : truePositives / found;
  const recall = expected === 0 ? 1 : truePositives / expected;
  return {
    expected,
    found,
    truePositives,
    missed: metrics.flatMap((entry) => entry.missed).sort(),
    spurious: metrics.flatMap((entry) => entry.spurious).sort(),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatSummary(
  totals: Record<ParityEngine, ParityEngineSummary>,
  passed: boolean,
  regressions: string[],
  corpusSize: number,
): string {
  const row = (label: string, dimension: "symbols" | "coreSymbols" | "imports") =>
    `  ${label.padEnd(13)} regex P=${pct(totals.regex[dimension].precision)} R=${pct(totals.regex[dimension].recall)}` +
    `   |   treesitter P=${pct(totals.treesitter[dimension].precision)} R=${pct(totals.treesitter[dimension].recall)}`;
  const lines = [
    `parser parity over ${corpusSize} authored cases`,
    row("symbols", "symbols"),
    row("core symbols", "coreSymbols"),
    row("imports", "imports"),
    "  (core symbols is a RECALL FLOOR only — its truth set is partial, so its precision is not gated)",
    passed
      ? "  VERDICT: tree-sitter is parity-or-better on every gated metric."
      : `  VERDICT: REGRESSION — ${regressions.join("; ")}`,
  ];
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
