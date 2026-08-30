import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * SIZE-AWARE EXTERNALIZATION OF THE STORED ANALYSIS (V3-P5 task 5, ledger #20).
 *
 * THE PROBLEM, and why it kept being deferred. Mongo rejects any document over 16 MB. V3-P1 added
 * `graph.cpgEdges` and `graph.routes` to the stored analysis, both uncapped, so the document grows
 * with the repository. V3-P2 removed the LARGE contributor (inline RAG vectors, ledger #8) and then
 * deliberately did NOT resolve this one, on the grounds that the graph slice's growth was UNMEASURED
 * on a real large repo and externalising on a guess is building without evidence. That reasoning was
 * right, and it is also why the fix is not "always externalize".
 *
 * WHAT CHANGED IS THAT IT IS NOW MEASURED, twice:
 *
 *   1. BSON IS 1.083x THE JSON SIZE for this data's shape — measured with
 *      `BSON.calculateObjectSize` over 1k / 20k / 100k / 200k synthetic cpgEdges, and the ratio is
 *      stable across all four. That matters because the obvious instinct is to compare
 *      `JSON.stringify().length` against 16 MB, which UNDERSTATES the real size by 8% (BSON adds a
 *      type byte and a length prefix per value, and turns every array index into a string key).
 *   2. 100,000 cpgEdges ALONE is 13.8 MB of JSON / 14.9 MB of BSON. So the ceiling is not
 *      theoretical: a single large monorepo file's worth of call edges gets there.
 *
 * SO: MEASURE EACH DOCUMENT, EXTERNALIZE ONLY WHEN IT MATTERS. A small repo's document is stored
 * exactly as before — no second collection, no second read, no behaviour change at all — and a large
 * one sheds its heaviest optional fields, in a fixed priority order, until it fits. That is strictly
 * better than the two obvious alternatives: always-inline breaks above the limit, and
 * always-externalize makes every read of every small analysis pay for a join.
 *
 * A FAILED REHYDRATE MUST BE LOUD, and this is the subtle part. `shared-types` already flags the
 * exact ambiguity: absent `cpgEdges` means "the parser could not produce them", so an analysis whose
 * externalized edges failed to load would be indistinguishable from a repo with genuinely no calls
 * or routes. `rehydrateAnalysis` therefore reports what it could not load, and the caller pushes a
 * warning naming the fields — never silently hands back a result that looks complete.
 */

/** Mongo's hard per-document ceiling. */
export const BSON_DOCUMENT_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Measured BSON:JSON size ratio for this data (see the header). Used to convert a cheap
 * `JSON.stringify` measurement into the number that actually matters, rather than pretending the two
 * are the same.
 */
export const BSON_OVERHEAD_RATIO = 1.083;

/**
 * The JSON budget above which fields get externalized.
 *
 * 8 MB, which is ~8.7 MB of BSON — a bit over half the limit. The margin is deliberate and it is NOT
 * a hedge against the ratio being wrong: the ratio was measured on ONE shape, and a shape with more,
 * shorter fields carries proportionally more BSON overhead. The document also carries `summary`,
 * the repository metadata and Mongo's own `_id` outside the `result` this measures. Half the limit
 * costs nothing (documents that size are rare) and removes the class of bug where a slightly
 * different shape silently crosses the line.
 */
export const OVERFLOW_BUDGET_JSON_BYTES = 8 * 1024 * 1024;

/**
 * Fields eligible for externalization, in the order they are shed. Most-shed-first.
 *
 * ORDERED BY WHAT A READ NEEDS, not by size. `cpgEdges` goes first because nothing in the default
 * view touches it — it powers the richer graph queries, which are opt-in, and it is also the single
 * biggest field by a wide margin. `routes` next: one view, absent on most repos. `graph.edges` last
 * and reluctantly, because the dependency graph IS the product's main visual; shedding it is a
 * choice between a slow render and no document at all.
 *
 * `graph.nodes` and `inventory.symbols` are deliberately NOT candidates. Grounding checks resolve a
 * citation's fileId against `graph.nodes`, so externalising nodes would make a failed rehydrate able
 * to turn a valid citation into a rejected one — converting a storage problem into a correctness
 * problem, which is the one trade this must never make.
 */
export const OVERFLOW_CANDIDATES = ["graph.cpgEdges", "graph.routes", "graph.edges"] as const;

export type OverflowField = (typeof OVERFLOW_CANDIDATES)[number];

/** What was externalized, stored alongside the document so a read knows what to fetch. */
export interface OverflowManifest {
  fields: OverflowField[];
  /** JSON bytes of the result BEFORE the split — kept because it is the number that justified it. */
  originalJsonBytes: number;
  /** JSON bytes after. */
  storedJsonBytes: number;
}

export interface OverflowSplit {
  /** The result to store inline, with externalized fields removed. */
  stored: AnalysisResult;
  /** Field path -> value, to store in the overflow collection. Empty when nothing was shed. */
  payload: Record<string, unknown>;
  /** Null when nothing was externalized, which is the common case. */
  manifest: OverflowManifest | null;
  /**
   * Set when the result STILL exceeds the hard limit after shedding every candidate. The caller
   * must not silently store it — Mongo would reject it with a driver error that names no field.
   */
  stillTooLarge: string | null;
}

/** JSON bytes of a value. UTF-8, because that is what gets stored. */
export function jsonBytes(value: unknown): number {
  const serialised = JSON.stringify(value);
  return serialised === undefined ? 0 : Buffer.byteLength(serialised, "utf8");
}

/** The measured BSON size for a JSON byte count. */
export function estimateBsonBytes(jsonByteCount: number): number {
  return Math.round(jsonByteCount * BSON_OVERHEAD_RATIO);
}

/** Per-candidate sizes plus the total, for logging and for the deferred large-repo measurement. */
export function measureAnalysis(result: AnalysisResult): {
  totalJsonBytes: number;
  estimatedBsonBytes: number;
  fields: Array<{ field: OverflowField; jsonBytes: number; count: number }>;
} {
  const totalJsonBytes = jsonBytes(result);
  return {
    totalJsonBytes,
    estimatedBsonBytes: estimateBsonBytes(totalJsonBytes),
    fields: OVERFLOW_CANDIDATES.map((field) => {
      const value = readField(result, field);
      return {
        field,
        jsonBytes: jsonBytes(value),
        count: Array.isArray(value) ? value.length : 0,
      };
    }),
  };
}

/**
 * Split a result into what to store inline and what to externalize.
 *
 * Sheds candidates in order and STOPS as soon as the remainder fits — so a document that only needs
 * `cpgEdges` removed keeps its dependency edges inline. That "stop early" is the difference between
 * this and a blanket rule, and it is why the common case pays nothing.
 */
export function splitOverflow(
  result: AnalysisResult,
  options: { budgetJsonBytes?: number } = {},
): OverflowSplit {
  const budget = options.budgetJsonBytes ?? OVERFLOW_BUDGET_JSON_BYTES;
  const originalJsonBytes = jsonBytes(result);

  if (originalJsonBytes <= budget) {
    // The common case: nothing changes. Same object, not a clone — a copy here would double peak
    // memory for every analysis in order to serve the rare one.
    return { stored: result, payload: {}, manifest: null, stillTooLarge: null };
  }

  // Structural clone before mutating: the caller's result is used for the API response too, and
  // shedding fields from it would return an incomplete analysis to the user who just requested it.
  const stored = structuredClone(result) as AnalysisResult;
  const payload: Record<string, unknown> = {};
  const shed: OverflowField[] = [];

  for (const field of OVERFLOW_CANDIDATES) {
    if (jsonBytes(stored) <= budget) break;
    const value = readField(stored, field);
    // An absent or empty field is not worth a manifest entry: externalising `undefined` would make
    // a rehydrate write the key back as present-but-empty, which is exactly the "no calls" lie.
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    payload[field] = value;
    clearField(stored, field);
    shed.push(field);
  }

  const storedJsonBytes = jsonBytes(stored);
  const hardLimitJsonBytes = Math.floor(BSON_DOCUMENT_LIMIT_BYTES / BSON_OVERHEAD_RATIO);

  return {
    stored,
    payload,
    manifest: shed.length ? { fields: shed, originalJsonBytes, storedJsonBytes } : null,
    stillTooLarge:
      storedJsonBytes > hardLimitJsonBytes
        ? `analysis is ${mb(storedJsonBytes)} of JSON (~${mb(estimateBsonBytes(storedJsonBytes))} BSON) ` +
          `after externalizing ${shed.length ? shed.join(", ") : "nothing"}; the 16MB document limit ` +
          `allows ~${mb(hardLimitJsonBytes)} of JSON. Largest remaining fields: ${largestRemaining(stored)}`
        : null,
  };
}

/**
 * Put externalized fields back.
 *
 * Returns the fields it could NOT restore rather than throwing, so the caller can serve a usable
 * analysis and say what is missing. Throwing would make an unreachable overflow collection break
 * every read of every large analysis, including the parts that need none of these fields.
 */
export function rehydrateAnalysis(
  stored: AnalysisResult,
  manifest: OverflowManifest | null,
  payload: Record<string, unknown> | null,
): { result: AnalysisResult; missing: OverflowField[] } {
  if (!manifest || manifest.fields.length === 0) return { result: stored, missing: [] };

  const result = structuredClone(stored) as AnalysisResult;
  const missing: OverflowField[] = [];

  for (const field of manifest.fields) {
    const value = payload?.[field];
    if (value === undefined) {
      // Left ABSENT rather than defaulted to []. An empty array claims "this repo has no call
      // edges", which is a false statement about the code; absence plus the warning below is the
      // honest one.
      missing.push(field);
      continue;
    }
    writeField(result, field, value);
  }

  return { result, missing };
}

/**
 * The warning to attach when a rehydrate came back incomplete.
 *
 * Worded to close the ambiguity `shared-types` flags: it says INCOMPLETE, not empty, so nobody reads
 * a storage failure as a fact about the repository.
 */
export function describeMissingOverflow(missing: OverflowField[]): string {
  return (
    `Stored analysis is INCOMPLETE: ${missing.join(", ")} could not be loaded from the overflow store. ` +
    "These fields are missing for storage reasons, NOT because the repository has none of them."
  );
}

// --- field access ------------------------------------------------------------
// Three tiny helpers rather than a generic path walker: the candidate list is fixed and two levels
// deep, and a generic `set(obj, "a.b.c", v)` would be more code plus a class of typo this cannot have.

function readField(result: AnalysisResult, field: OverflowField): unknown {
  switch (field) {
    case "graph.cpgEdges":
      return result.graph?.cpgEdges;
    case "graph.routes":
      return result.graph?.routes;
    case "graph.edges":
      return result.graph?.edges;
  }
}

function clearField(result: AnalysisResult, field: OverflowField): void {
  if (!result.graph) return;
  switch (field) {
    case "graph.cpgEdges":
      delete result.graph.cpgEdges;
      return;
    case "graph.routes":
      delete result.graph.routes;
      return;
    case "graph.edges":
      // `edges` is REQUIRED on RepoGraph, so it cannot be deleted without lying about the type.
      // Emptied instead, and the manifest is what records that it was shed — which is why a
      // rehydrate consults the manifest rather than testing for emptiness.
      result.graph.edges = [];
      return;
  }
}

function writeField(result: AnalysisResult, field: OverflowField, value: unknown): void {
  if (!result.graph) return;
  switch (field) {
    case "graph.cpgEdges":
      result.graph.cpgEdges = value as NonNullable<AnalysisResult["graph"]>["cpgEdges"];
      return;
    case "graph.routes":
      result.graph.routes = value as NonNullable<AnalysisResult["graph"]>["routes"];
      return;
    case "graph.edges":
      result.graph.edges = value as NonNullable<AnalysisResult["graph"]>["edges"];
      return;
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The biggest remaining slices, so a hard failure names what to fix instead of just failing. */
function largestRemaining(result: AnalysisResult): string {
  const slices: Array<[string, unknown]> = [
    ["graph.nodes", result.graph?.nodes],
    ["inventory.symbols", result.inventory?.symbols],
    ["metrics.perFile", result.metrics?.perFile],
    ["ai.rag.chunks", result.ai?.rag?.chunks],
    ["files", result.files],
  ];
  return slices
    .map(([name, value]) => ({ name, bytes: jsonBytes(value) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((entry) => `${entry.name}=${mb(entry.bytes)}`)
    .join(", ");
}
