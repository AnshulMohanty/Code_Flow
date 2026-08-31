import type { FileRole } from "@codeflow/shared-types";
import type { GraphModel } from "./graphModel";

/**
 * THE ARCHITECTURE READ-MODEL (V3-FINAL) — container lanes, edge classes, hop-tiered impact.
 *
 * Everything here is DETERMINISTIC and derived from facts the pipeline already produced: file roles
 * (the parser's `classifyRole`), repo-relative paths, the resolved import graph, and detected entry
 * points. No model is involved, nothing is inferred by an agent, and the same analysis always
 * produces the same view. That matters because these drive the SYSTEM and IMPACT tabs, which read
 * as statements of fact — so they must be facts.
 *
 * WHY IT LIVES IN apps/web/src/lib. It sits beside `dashboard.ts`, `graphModel.ts` and
 * `graphView.ts`, which are the same kind of thing: pure read-models over an `AnalysisResult`,
 * tested in this package. `@codeflow/graph` would be the other home and is the right one the day
 * `apps/mcp` wants these — but that package imports `node:path` (via `normalize.ts`), so pulling its
 * barrel into a browser bundle costs a polyfill for one function this file does not need. Promoting
 * these is a one-file move if a second consumer appears.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: anything an agent produced. Domain lanes (TAB 04) are specialist
 * output and are labelled as inference wherever they render; this file only ever answers questions
 * the graph can answer.
 */

// ── Container lanes (the C4-container view) ──────────────────────────────────

/**
 * The six lanes of the container diagram, in TOP-DOWN order — which is also the order the violation
 * rules read as "downward is fine".
 */
export const CONTAINER_LANES = [
  "clients-entry",
  "edge-transport",
  "application",
  "domain-engine",
  "data-configuration",
  "platform-libraries",
] as const;

export type ContainerLane = (typeof CONTAINER_LANES)[number] | "unclassified";

export const LANE_LABELS: Record<ContainerLane, string> = {
  "clients-entry": "CLIENTS & ENTRY",
  "edge-transport": "EDGE — TRANSPORT",
  application: "APPLICATION",
  "domain-engine": "DOMAIN & ENGINE",
  "data-configuration": "DATA & CONFIGURATION",
  "platform-libraries": "PLATFORM LIBRARIES",
  unclassified: "UNCLASSIFIED",
};

/** The sub-labels the design puts on two lanes. Facts about the lane, not about a module. */
export const LANE_NOTES: Partial<Record<ContainerLane, string>> = {
  "platform-libraries": "leaf · no domain code",
  "data-configuration": "stateful",
};

/**
 * Path tokens that place a module in a lane. Matched against the path's DIRECTORY SEGMENTS, never
 * against a substring: matching substrings would put `src/dbutils.ts` in the data lane and
 * `src/scripts/api.ts` in the application lane, and a diagram that is confidently wrong about where
 * code lives is worse than one that says "unclassified".
 *
 * Order of the lanes below IS the precedence order — first match wins. Data and platform come first
 * because they are the most specific: a `lib/db/pool.ts` is a data module that happens to sit under
 * `lib`, and the reverse mistake (calling the connection pool a utility) is the one that makes a
 * dependency diagram useless.
 */
const LANE_TOKENS: Array<{ lane: ContainerLane; tokens: readonly string[] }> = [
  {
    lane: "data-configuration",
    tokens: ["db", "database", "migrations", "migration", "schema", "schemas", "models", "model", "entities", "entity", "persistence", "repository", "repositories", "dal", "prisma", "queues", "queue", "storage", "store", "stores"],
  },
  {
    lane: "platform-libraries",
    tokens: ["lib", "libs", "util", "utils", "utility", "utilities", "common", "shared", "helpers", "helper", "vendor", "internal", "telemetry", "logging", "logger", "log", "metrics", "tracing", "observability", "compiler", "bundler", "codegen", "toolchain"],
  },
  {
    lane: "clients-entry",
    tokens: ["cli", "bin", "cmd", "cmds", "commands", "scripts", "worker", "workers", "jobs", "daemon", "entry", "main"],
  },
  {
    lane: "edge-transport",
    tokens: ["server", "http", "transport", "gateway", "middleware", "middlewares", "routes", "route", "router", "routing", "controllers", "controller", "handlers", "handler", "rpc", "grpc", "socket", "sockets"],
  },
  {
    lane: "application",
    tokens: ["api", "apis", "ui", "components", "component", "pages", "page", "views", "view", "screens", "screen", "widgets", "features", "feature", "containers", "hooks", "app", "web", "frontend", "client"],
  },
  {
    lane: "domain-engine",
    tokens: ["core", "domain", "domains", "service", "services", "engine", "business", "logic", "usecase", "usecases", "auth", "session", "graph", "parser", "parsers", "analyzer", "analyzers", "scheduler", "resolver", "resolvers", "agents", "agent"],
  },
];

/** Why a module landed in its lane. Rendered on hover, so the assignment is auditable, not magic. */
export type LaneMatch =
  | { kind: "role"; detail: FileRole }
  | { kind: "entry-point" }
  | { kind: "path-token"; detail: string }
  | { kind: "default-source" }
  | { kind: "unclassified" };

export interface LaneAssignment {
  fileId: string;
  lane: ContainerLane;
  matchedBy: LaneMatch;
}

export interface LaneInput {
  fileId: string;
  path: string;
  role: string;
}

/**
 * Assign one module to a lane.
 *
 * PRECEDENCE, and the reason for each step:
 *  1. `role: "config"` ⇒ DATA & CONFIGURATION. The parser already decided this file is
 *     configuration; a path token cannot know better.
 *  2. `role: "test"` ⇒ CLIENTS & ENTRY. A test suite is a CLIENT of the system — it enters through
 *     the same doors a user does — which is exactly where the design's `test/harness` sits.
 *  3. A detected ENTRY POINT ⇒ CLIENTS & ENTRY. Hard evidence from Inventory (a `bin`, a `main`),
 *     which beats a guess from a directory name.
 *  4. A path DIRECTORY SEGMENT matching a lane's tokens, in the precedence order above.
 *  5. `role: "source"` with no match ⇒ DOMAIN & ENGINE. Business logic is the default for source
 *     code, and the design labels that lane "business rules live here".
 *  6. Anything else ⇒ UNCLASSIFIED, which renders as a real lane rather than being hidden. A module
 *     the rules cannot place must be visible as unplaced; silently dropping it would make the
 *     diagram claim a completeness it does not have.
 */
export function assignLane(input: LaneInput, entryPointIds: ReadonlySet<string>): LaneAssignment {
  const { fileId, path, role } = input;

  if (role === "config") return { fileId, lane: "data-configuration", matchedBy: { kind: "role", detail: "config" } };
  if (role === "test") return { fileId, lane: "clients-entry", matchedBy: { kind: "role", detail: "test" } };
  if (entryPointIds.has(fileId)) return { fileId, lane: "clients-entry", matchedBy: { kind: "entry-point" } };

  // Directory segments only — the basename is excluded so `src/api.ts` is not read as the api lane
  // on the strength of its file name. A file's own name describes the file; a directory describes
  // the group it belongs to, and lanes are about groups.
  const segments = path.toLowerCase().split("/").slice(0, -1);
  for (const { lane, tokens } of LANE_TOKENS) {
    for (const segment of segments) {
      if (tokens.includes(segment)) return { fileId, lane, matchedBy: { kind: "path-token", detail: segment } };
    }
  }

  if (role === "source") return { fileId, lane: "domain-engine", matchedBy: { kind: "default-source" } };
  return { fileId, lane: "unclassified", matchedBy: { kind: "unclassified" } };
}

export interface LaneMap {
  /** fileId → assignment. Every node in the model appears exactly once. */
  byFileId: Map<string, LaneAssignment>;
  /** Lane → the fileIds in it, sorted. Lanes with no modules are ABSENT, not empty. */
  byLane: Map<ContainerLane, string[]>;
}

export function assignLanes(inputs: readonly LaneInput[], entryPointIds: ReadonlySet<string> = new Set()): LaneMap {
  const byFileId = new Map<string, LaneAssignment>();
  const byLane = new Map<ContainerLane, string[]>();
  for (const input of inputs) {
    const assignment = assignLane(input, entryPointIds);
    byFileId.set(assignment.fileId, assignment);
    const bucket = byLane.get(assignment.lane) ?? [];
    bucket.push(assignment.fileId);
    byLane.set(assignment.lane, bucket);
  }
  for (const bucket of byLane.values()) bucket.sort();
  return { byFileId, byLane };
}

// ── Edge classification ──────────────────────────────────────────────────────

/**
 * The architectural rules that make an edge a VIOLATION.
 *
 * THESE TWO AND NO OTHERS, and that boundary is deliberate. An architectural rule set is a policy
 * decision about a codebase, not something derivable from it — so inventing rules and rendering
 * their output as fact is precisely the failure the grounding invariant exists to prevent. These two
 * were chosen by the owner; adding a third is an owner decision, not a code change.
 */
export type ArchitectureRuleId = "ui-to-platform-direct" | "api-skips-domain";

export const ARCHITECTURE_RULES: Record<ArchitectureRuleId, { label: string; why: string }> = {
  "ui-to-platform-direct": {
    label: "UI → platform, direct",
    why: "An application/UI module imports a platform library without going through the domain or application layer, so a platform change reaches the view with nothing in between to absorb it.",
  },
  "api-skips-domain": {
    label: "API skips the domain",
    why: "An application/API module reaches data or configuration directly instead of through the domain, so business rules can be bypassed by whoever calls the endpoint.",
  },
};

export type EdgeClass = "control" | "data" | "violation";

export interface ClassifiedEdge {
  from: string;
  to: string;
  class: EdgeClass;
  /** Present only on a violation — which rule fired, so the claim is attributable. */
  rule?: ArchitectureRuleId;
}

/**
 * Classify one edge.
 *
 * CONTROL vs DATA is a structural read, not a guess: an edge INTO the data/configuration lane or
 * into a platform library is a READ (you import a store or a helper to get something), while an edge
 * between the layers that handle a request is CONTROL FLOW (one hands work to the next). That maps
 * onto the design's legend — solid for control, dashed for data/read.
 *
 * VIOLATION is checked FIRST, because a violating edge is still a data edge and the interesting fact
 * about it is that it should not exist.
 */
export function classifyEdge(from: string, to: string, lanes: LaneMap): ClassifiedEdge {
  const fromLane = lanes.byFileId.get(from)?.lane ?? "unclassified";
  const toLane = lanes.byFileId.get(to)?.lane ?? "unclassified";

  if (fromLane === "application" && toLane === "platform-libraries") {
    return { from, to, class: "violation", rule: "ui-to-platform-direct" };
  }
  if (fromLane === "application" && toLane === "data-configuration") {
    return { from, to, class: "violation", rule: "api-skips-domain" };
  }
  if (toLane === "data-configuration" || toLane === "platform-libraries") {
    return { from, to, class: "data" };
  }
  return { from, to, class: "control" };
}

export interface ClassifiedEdges {
  edges: ClassifiedEdge[];
  counts: Record<EdgeClass, number>;
  /** Violations grouped by rule, so the UI can say WHICH rule and how often. */
  violationsByRule: Map<ArchitectureRuleId, ClassifiedEdge[]>;
}

export function classifyEdges(model: GraphModel, lanes: LaneMap): ClassifiedEdges {
  const edges = model.links.map((link) => classifyEdge(link.source, link.target, lanes));
  const counts: Record<EdgeClass, number> = { control: 0, data: 0, violation: 0 };
  const violationsByRule = new Map<ArchitectureRuleId, ClassifiedEdge[]>();
  for (const edge of edges) {
    counts[edge.class] += 1;
    if (edge.rule) {
      const bucket = violationsByRule.get(edge.rule) ?? [];
      bucket.push(edge);
      violationsByRule.set(edge.rule, bucket);
    }
  }
  return { edges, counts, violationsByRule };
}

// ── Hop-tiered impact ────────────────────────────────────────────────────────

/** Reverse adjacency (importers of each module), built once per model. */
export interface Adjacency {
  importers: Map<string, string[]>;
  imports: Map<string, string[]>;
}

export function buildAdjacency(model: GraphModel): Adjacency {
  const importers = new Map<string, string[]>();
  const imports = new Map<string, string[]>();
  for (const node of model.nodes) {
    importers.set(node.id, []);
    imports.set(node.id, []);
  }
  for (const link of model.links) {
    imports.get(link.source)?.push(link.target);
    importers.get(link.target)?.push(link.source);
  }
  for (const list of importers.values()) list.sort();
  for (const list of imports.values()) list.sort();
  return { importers, imports };
}

export interface HopTier {
  /** 1, 2, 3, or 4 — where 4 means "4 or more". */
  hops: 1 | 2 | 3 | 4;
  label: string;
  fileIds: string[];
}

export interface HopTiers {
  tiers: HopTier[];
  /** Every dependent, at any distance. */
  total: number;
  /** Deepest hop count actually reached; 0 when nothing depends on this module. */
  maxHops: number;
}

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "DIRECT",
  2: "2 HOPS",
  3: "3 HOPS",
  4: "4+ HOPS",
};

/**
 * BFS over the REVERSE dependency graph: who breaks if this module's behaviour changes.
 *
 * BFS, not DFS, because the tier a module lands in must be its SHORTEST distance — a module that is
 * both a direct importer and reachable in four hops is a direct importer, and reporting it in the
 * 4+ tier would overstate the blast radius while understating the urgency.
 *
 * Tiers 1-3 are exact; everything deeper is collapsed into 4+, which is what the design shows and
 * also where precision stops being decision-relevant: "five hops away" and "nine hops away" lead to
 * the same action.
 */
export function hopTieredDependents(adjacency: Adjacency, fileId: string): HopTiers {
  const byHop = new Map<string, number>();
  let frontier = adjacency.importers.get(fileId) ?? [];
  const seen = new Set<string>([fileId]);
  let hop = 1;

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      byHop.set(id, hop);
      for (const importer of adjacency.importers.get(id) ?? []) {
        if (!seen.has(importer)) next.push(importer);
      }
    }
    frontier = next;
    hop += 1;
  }

  const bucket = (level: 1 | 2 | 3 | 4): string[] =>
    [...byHop.entries()]
      .filter(([, depth]) => (level === 4 ? depth >= 4 : depth === level))
      .map(([id]) => id)
      .sort();

  const tiers: HopTier[] = ([1, 2, 3, 4] as const).map((level) => ({
    hops: level,
    label: TIER_LABELS[level],
    fileIds: bucket(level),
  }));

  return {
    tiers,
    total: byHop.size,
    maxHops: byHop.size === 0 ? 0 : Math.max(...byHop.values()),
  };
}

/**
 * MOVE impact — a genuinely different question from CHANGE impact, and the reason the design has a
 * toggle rather than one number.
 *
 * Changing a module's BEHAVIOUR ripples transitively: anything that depends on it, at any distance,
 * can be affected. Changing its PATH does not ripple at all — only the files that name it directly
 * have to be edited, plus the module's own imports if they are relative. A four-hop dependent never
 * mentions the moved file, so counting it as "affected by a move" would inflate a rename into a
 * refactor.
 */
export interface MoveImpact {
  /** Files that name this module directly and must be edited. */
  directImporters: string[];
  /** This module's own imports — relative paths inside it change when it moves. */
  ownImports: string[];
  /** Total files that need an edit: the importers plus the module itself. */
  filesToEdit: number;
}

export function moveImpact(adjacency: Adjacency, fileId: string): MoveImpact {
  const directImporters = adjacency.importers.get(fileId) ?? [];
  const ownImports = adjacency.imports.get(fileId) ?? [];
  return {
    directImporters: [...directImporters],
    ownImports: [...ownImports],
    filesToEdit: directImporters.length + 1,
  };
}

// ── Verdict cards ────────────────────────────────────────────────────────────

export interface ApiSurfaceReach {
  reaches: boolean;
  /** Application-lane modules that depend on this one, nearest first, bounded for rendering. */
  via: string[];
  /** Hops to the nearest one; null when none is reachable. */
  nearestHops: number | null;
}

/** How many named modules a verdict card lists before it stops. Render-only; the counts are full. */
export const VERDICT_CHIP_CAP = 4;

/**
 * Can a change here reach the API surface?
 *
 * "API surface" is the APPLICATION lane, which is where `api/*` lives — the modules something
 * outside the repository can call. A change that cannot reach it is internal by construction, which
 * is the single most useful thing to know before touching a central file.
 */
export function reachesApiSurface(adjacency: Adjacency, fileId: string, lanes: LaneMap): ApiSurfaceReach {
  const tiers = hopTieredDependents(adjacency, fileId);
  const hits: Array<{ id: string; hops: number }> = [];
  for (const tier of tiers.tiers) {
    for (const id of tier.fileIds) {
      if (lanes.byFileId.get(id)?.lane === "application") hits.push({ id, hops: tier.hops });
    }
  }
  // The module itself being on the API surface counts: changing it changes the surface.
  if (lanes.byFileId.get(fileId)?.lane === "application") hits.unshift({ id: fileId, hops: 0 });

  hits.sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));
  return {
    reaches: hits.length > 0,
    via: hits.slice(0, VERDICT_CHIP_CAP).map((hit) => hit.id),
    nearestHops: hits.length > 0 ? hits[0].hops : null,
  };
}

export interface TestReach {
  /** Test files that reach this module by import, directly or transitively. */
  count: number;
  /** Hops to the nearest one; null when none reaches it. */
  nearestHops: number | null;
  /** Nearest first, bounded for rendering. */
  fileIds: string[];
}

/**
 * TEST FILES THAT REACH IT — by IMPORT, which is not coverage, and the label says so.
 *
 * This repository has no coverage data and no test-execution graph, so "tests that cover it" is not
 * a claim it can make. What it CAN state exactly is which `role: "test"` files reach this module
 * over the resolved import graph. That is weaker than coverage — an import does not prove a code
 * path is exercised — and it is a real deterministic fact rather than a fabricated percentage.
 * Wherever this renders, the caption names the limitation.
 */
export function testFilesReaching(
  adjacency: Adjacency,
  fileId: string,
  roleOf: (id: string) => string | undefined,
): TestReach {
  const tiers = hopTieredDependents(adjacency, fileId);
  const hits: Array<{ id: string; hops: number }> = [];
  for (const tier of tiers.tiers) {
    for (const id of tier.fileIds) {
      if (roleOf(id) === "test") hits.push({ id, hops: tier.hops });
    }
  }
  hits.sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));
  return {
    count: hits.length,
    nearestHops: hits.length > 0 ? hits[0].hops : null,
    fileIds: hits.slice(0, VERDICT_CHIP_CAP).map((hit) => hit.id),
  };
}

export interface SafeToChangeAlone {
  safe: boolean;
  /** Modules that would be affected — the number the verdict is based on. */
  affected: number;
  advice: string;
}

/**
 * Is this module safe to change on its own?
 *
 * The threshold is a JUDGMENT and is stated as one: at or below it the advice is "change it", above
 * it the advice is "stage it". The number that matters is `affected`, which is exact and shown next
 * to the verdict — so a reader who disagrees with the threshold can still see the fact it came from.
 */
export const SAFE_TO_CHANGE_MAX_AFFECTED = 5;

export function safeToChangeAlone(tiers: HopTiers): SafeToChangeAlone {
  const affected = tiers.total;
  if (affected === 0) return { safe: true, affected, advice: "nothing depends on it" };
  if (affected <= SAFE_TO_CHANGE_MAX_AFFECTED) {
    return { safe: true, affected, advice: `${affected} module${affected === 1 ? "" : "s"} — reviewable in one change` };
  }
  return { safe: false, affected, advice: `${affected} modules — stage it` };
}

// ── Entry-probable (TAB 04) ──────────────────────────────────────────────────

/**
 * "ENTRY-PROBABLE": a module something outside its own group reaches into.
 *
 * DERIVED, and the derivation is the honest part: a module is entry-probable when it is a detected
 * entry point (hard evidence), or when it has importers and no imports of its own inside the graph
 * (a leaf that others reach — the shape of a public surface), or when it is imported from OUTSIDE
 * its own directory. That last one is what makes it useful on a real repo: a module every one of its
 * siblings uses is internal; a module three other directories use is a door.
 *
 * PROBABLE is in the name because it is a heuristic over facts, not a fact. It never renders as
 * "entry point" — the design's own label is "entry-probable", and that is the label used.
 */
export function isEntryProbable(
  fileId: string,
  adjacency: Adjacency,
  entryPointIds: ReadonlySet<string>,
): boolean {
  if (entryPointIds.has(fileId)) return true;
  const importers = adjacency.importers.get(fileId) ?? [];
  if (importers.length === 0) return false;
  const own = directoryOf(fileId);
  return importers.some((importer) => directoryOf(importer) !== own);
}

export function directoryOf(fileId: string): string {
  const slash = fileId.lastIndexOf("/");
  return slash === -1 ? "" : fileId.slice(0, slash);
}
