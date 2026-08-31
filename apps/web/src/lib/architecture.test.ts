import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_RULES,
  assignLane,
  assignLanes,
  buildAdjacency,
  classifyEdge,
  classifyEdges,
  hopTieredDependents,
  isEntryProbable,
  moveImpact,
  reachesApiSurface,
  safeToChangeAlone,
  testFilesReaching,
  type LaneInput,
} from "./architecture";
import type { GraphModel } from "./graphModel";

// Every assertion below is about a DETERMINISTIC derivation over facts the pipeline produced. The
// properties that matter are the honesty ones: a lane assignment that cannot be explained, a
// violation the owner did not sanction, or a blast radius that counts a four-hop dependent as
// affected by a rename would each put a confident wrong statement in front of a user.

const NONE = new Set<string>();

function lanesOf(inputs: LaneInput[], entryPoints: string[] = []) {
  return assignLanes(inputs, new Set(entryPoints));
}

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, role: "source", centrality: 0, loc: 10, inCycle: false, size: 2 };
}

function model(ids: string[], links: Array<[string, string]>): GraphModel {
  return {
    nodes: ids.map(node),
    links: links.map(([source, target]) => ({ source, target, kind: "import" as const, inCycle: false })),
    nodeCount: ids.length,
    linkCount: links.length,
    unresolvedCount: 0,
    externalCount: 0,
  };
}

describe("assignLane — every placement is explainable", () => {
  it("puts a config file in DATA & CONFIGURATION on the parser's role, not on a path guess", () => {
    const assignment = assignLane({ fileId: "next.config.js", path: "next.config.js", role: "config" }, NONE);
    expect(assignment.lane).toBe("data-configuration");
    expect(assignment.matchedBy).toEqual({ kind: "role", detail: "config" });
  });

  it("puts a TEST file in CLIENTS & ENTRY — a test suite enters the system like a user", () => {
    const assignment = assignLane({ fileId: "src/core/a.test.ts", path: "src/core/a.test.ts", role: "test" }, NONE);
    expect(assignment.lane).toBe("clients-entry");
    expect(assignment.matchedBy).toEqual({ kind: "role", detail: "test" });
  });

  it("prefers HARD entry-point evidence over a directory name", () => {
    // `src/core/main.ts` would match the domain lane by its `core` segment; a detected entry point
    // is evidence from Inventory and beats a guess.
    const assignment = assignLane(
      { fileId: "src/core/main.ts", path: "src/core/main.ts", role: "source" },
      new Set(["src/core/main.ts"]),
    );
    expect(assignment.lane).toBe("clients-entry");
    expect(assignment.matchedBy).toEqual({ kind: "entry-point" });
  });

  it("matches a DIRECTORY SEGMENT, never a substring", () => {
    // `dbutils` is not the data lane, and `apiary` is not the application lane. A diagram that is
    // confidently wrong about where code lives is worse than one that says "unclassified".
    expect(assignLane({ fileId: "src/dbutils/x.ts", path: "src/dbutils/x.ts", role: "source" }, NONE).lane).toBe(
      "domain-engine",
    );
    expect(assignLane({ fileId: "src/apiary/x.ts", path: "src/apiary/x.ts", role: "source" }, NONE).lane).toBe(
      "domain-engine",
    );
  });

  it("ignores the BASENAME — a file's name describes the file, a directory describes the group", () => {
    expect(assignLane({ fileId: "src/api.ts", path: "src/api.ts", role: "source" }, NONE).lane).toBe("domain-engine");
    expect(assignLane({ fileId: "src/api/index.ts", path: "src/api/index.ts", role: "source" }, NONE).lane).toBe(
      "application",
    );
  });

  it("puts data BEFORE platform, so lib/db/pool.ts is a data module not a utility", () => {
    const assignment = assignLane({ fileId: "src/lib/db/pool.ts", path: "src/lib/db/pool.ts", role: "source" }, NONE);
    expect(assignment.lane).toBe("data-configuration");
    expect(assignment.matchedBy).toEqual({ kind: "path-token", detail: "db" });
  });

  it("defaults unmatched SOURCE to DOMAIN & ENGINE — business logic is the default for code", () => {
    const assignment = assignLane({ fileId: "src/pricing/rules.ts", path: "src/pricing/rules.ts", role: "source" }, NONE);
    expect(assignment.lane).toBe("domain-engine");
    expect(assignment.matchedBy).toEqual({ kind: "default-source" });
  });

  it("marks anything else UNCLASSIFIED rather than hiding it", () => {
    // A module the rules cannot place must be VISIBLE as unplaced; dropping it would make the
    // diagram claim a completeness it does not have.
    const assignment = assignLane({ fileId: "logo.svg", path: "logo.svg", role: "asset" }, NONE);
    expect(assignment.lane).toBe("unclassified");
    expect(assignment.matchedBy).toEqual({ kind: "unclassified" });
  });

  it("places every input exactly once, and omits empty lanes rather than showing them as 0", () => {
    const lanes = lanesOf([
      { fileId: "src/api/a.ts", path: "src/api/a.ts", role: "source" },
      { fileId: "src/core/b.ts", path: "src/core/b.ts", role: "source" },
      { fileId: "src/api/c.ts", path: "src/api/c.ts", role: "source" },
    ]);
    expect(lanes.byFileId.size).toBe(3);
    expect(lanes.byLane.get("application")).toEqual(["src/api/a.ts", "src/api/c.ts"]);
    expect(lanes.byLane.has("edge-transport")).toBe(false);
  });
});

describe("classifyEdge — only the two rules the owner sanctioned", () => {
  const lanes = lanesOf([
    { fileId: "src/ui/table.tsx", path: "src/ui/table.tsx", role: "source" },
    { fileId: "src/api/rest.ts", path: "src/api/rest.ts", role: "source" },
    { fileId: "src/lib/log.ts", path: "src/lib/log.ts", role: "source" },
    { fileId: "src/db/pool.ts", path: "src/db/pool.ts", role: "source" },
    { fileId: "src/core/resolver.ts", path: "src/core/resolver.ts", role: "source" },
    { fileId: "src/server/route.ts", path: "src/server/route.ts", role: "source" },
  ]);

  it("UI → platform direct is a VIOLATION, and names the rule", () => {
    const edge = classifyEdge("src/ui/table.tsx", "src/lib/log.ts", lanes);
    expect(edge.class).toBe("violation");
    expect(edge.rule).toBe("ui-to-platform-direct");
    expect(ARCHITECTURE_RULES[edge.rule!].why).toContain("platform library");
  });

  it("API → data direct is a VIOLATION, and names the rule", () => {
    const edge = classifyEdge("src/api/rest.ts", "src/db/pool.ts", lanes);
    expect(edge.class).toBe("violation");
    expect(edge.rule).toBe("api-skips-domain");
  });

  it("API → domain is NOT a violation — that is the path the rule wants", () => {
    expect(classifyEdge("src/api/rest.ts", "src/core/resolver.ts", lanes).class).toBe("control");
  });

  it("DOMAIN → platform is NOT a violation: only the two sanctioned rules fire", () => {
    // A third rule ("no upward edges", say) would be a policy nobody chose, rendered as fact.
    const edge = classifyEdge("src/core/resolver.ts", "src/lib/log.ts", lanes);
    expect(edge.class).toBe("data");
    expect(edge.rule).toBeUndefined();
  });

  it("an edge INTO data or platform is DATA/READ; between request layers it is CONTROL", () => {
    expect(classifyEdge("src/core/resolver.ts", "src/db/pool.ts", lanes).class).toBe("data");
    expect(classifyEdge("src/server/route.ts", "src/api/rest.ts", lanes).class).toBe("control");
  });

  it("counts by class and groups violations by rule, so a claim is attributable", () => {
    const graph = model(
      ["src/ui/table.tsx", "src/api/rest.ts", "src/lib/log.ts", "src/db/pool.ts", "src/core/resolver.ts"],
      [
        ["src/ui/table.tsx", "src/lib/log.ts"],
        ["src/api/rest.ts", "src/db/pool.ts"],
        ["src/api/rest.ts", "src/core/resolver.ts"],
        ["src/core/resolver.ts", "src/db/pool.ts"],
      ],
    );
    const classified = classifyEdges(graph, lanes);
    expect(classified.counts).toEqual({ control: 1, data: 1, violation: 2 });
    expect(classified.violationsByRule.get("ui-to-platform-direct")).toHaveLength(1);
    expect(classified.violationsByRule.get("api-skips-domain")).toHaveLength(1);
  });
});

describe("hopTieredDependents — BFS over the reverse graph", () => {
  // a <- b <- c <- d <- e  (e imports d imports c imports b imports a)
  const chain = model(["a", "b", "c", "d", "e"], [
    ["b", "a"],
    ["c", "b"],
    ["d", "c"],
    ["e", "d"],
  ]);
  const adjacency = buildAdjacency(chain);

  it("tiers by shortest distance", () => {
    const tiers = hopTieredDependents(adjacency, "a");
    expect(tiers.tiers.map((tier) => tier.fileIds)).toEqual([["b"], ["c"], ["d"], ["e"]]);
    expect(tiers.total).toBe(4);
    expect(tiers.maxHops).toBe(4);
  });

  it("collapses everything past 3 into the 4+ tier", () => {
    const long = model(["a", "b", "c", "d", "e", "f"], [
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
      ["e", "d"],
      ["f", "e"],
    ]);
    const tiers = hopTieredDependents(buildAdjacency(long), "a");
    expect(tiers.tiers[3].fileIds).toEqual(["e", "f"]);
    expect(tiers.maxHops).toBe(5);
  });

  it("uses the SHORTEST path — a direct importer is never reported deeper", () => {
    // `far` imports `a` directly AND through the chain. It is a DIRECT importer.
    const both = model(["a", "b", "c", "far"], [
      ["b", "a"],
      ["c", "b"],
      ["far", "c"],
      ["far", "a"],
    ]);
    const tiers = hopTieredDependents(buildAdjacency(both), "a");
    expect(tiers.tiers[0].fileIds).toContain("far");
    expect(tiers.tiers[2].fileIds).not.toContain("far");
  });

  it("reports an empty radius for an orphan, and does not count the module itself", () => {
    const tiers = hopTieredDependents(buildAdjacency(model(["lonely"], [])), "lonely");
    expect(tiers.total).toBe(0);
    expect(tiers.maxHops).toBe(0);
  });

  it("terminates on a CYCLE rather than looping forever", () => {
    const cyclic = model(["a", "b", "c"], [
      ["b", "a"],
      ["c", "b"],
      ["a", "c"],
    ]);
    const tiers = hopTieredDependents(buildAdjacency(cyclic), "a");
    expect(tiers.total).toBe(2);
  });

  it("returns an empty result for an unknown module instead of throwing", () => {
    expect(hopTieredDependents(buildAdjacency(model(["a"], [])), "nope").total).toBe(0);
  });
});

describe("moveImpact — a rename is not a refactor", () => {
  const chain = model(["a", "b", "c", "d"], [
    ["b", "a"],
    ["c", "b"],
    ["d", "c"],
  ]);
  const adjacency = buildAdjacency(chain);

  it("counts ONLY direct importers, because a four-hop dependent never names the moved file", () => {
    const impact = moveImpact(adjacency, "a");
    expect(impact.directImporters).toEqual(["b"]);
    // CHANGE affects three; MOVE affects one. Reporting the same number for both would inflate a
    // rename into a refactor.
    expect(hopTieredDependents(adjacency, "a").total).toBe(3);
    expect(impact.filesToEdit).toBe(2); // the importer plus the moved file itself
  });

  it("reports the module's OWN imports, whose relative paths change when it moves", () => {
    expect(moveImpact(adjacency, "c").ownImports).toEqual(["b"]);
  });
});

describe("verdict cards", () => {
  const lanes = lanesOf([
    { fileId: "src/config/env.ts", path: "src/config/env.ts", role: "source" },
    { fileId: "src/core/resolver.ts", path: "src/core/resolver.ts", role: "source" },
    { fileId: "src/api/rest.ts", path: "src/api/rest.ts", role: "source" },
    { fileId: "src/lib/log.ts", path: "src/lib/log.ts", role: "source" },
    { fileId: "src/core/resolver.test.ts", path: "src/core/resolver.test.ts", role: "test" },
  ]);
  const graph = model(
    ["src/config/env.ts", "src/core/resolver.ts", "src/api/rest.ts", "src/lib/log.ts", "src/core/resolver.test.ts"],
    [
      ["src/core/resolver.ts", "src/config/env.ts"],
      ["src/api/rest.ts", "src/core/resolver.ts"],
      ["src/core/resolver.test.ts", "src/core/resolver.ts"],
    ],
  );
  const adjacency = buildAdjacency(graph);
  const roleOf = (id: string) => (id.endsWith(".test.ts") ? "test" : "source");

  it("REACHES API SURFACE follows the reverse graph into the application lane", () => {
    const reach = reachesApiSurface(adjacency, "src/config/env.ts", lanes);
    expect(reach.reaches).toBe(true);
    expect(reach.via).toEqual(["src/api/rest.ts"]);
    expect(reach.nearestHops).toBe(2);
  });

  it("counts a module that IS on the API surface at zero hops", () => {
    const reach = reachesApiSurface(adjacency, "src/api/rest.ts", lanes);
    expect(reach.reaches).toBe(true);
    expect(reach.nearestHops).toBe(0);
  });

  it("says NO when nothing on the surface can reach it", () => {
    const reach = reachesApiSurface(adjacency, "src/lib/log.ts", lanes);
    expect(reach.reaches).toBe(false);
    expect(reach.nearestHops).toBeNull();
    expect(reach.via).toEqual([]);
  });

  it("TEST FILES THAT REACH IT counts role=test importers, by import and not by coverage", () => {
    const reach = testFilesReaching(adjacency, "src/core/resolver.ts", roleOf);
    expect(reach.count).toBe(1);
    expect(reach.nearestHops).toBe(1);
    expect(reach.fileIds).toEqual(["src/core/resolver.test.ts"]);
  });

  it("reports ZERO test files rather than guessing a coverage figure", () => {
    const reach = testFilesReaching(adjacency, "src/lib/log.ts", roleOf);
    expect(reach.count).toBe(0);
    expect(reach.nearestHops).toBeNull();
  });

  it("SAFE TO CHANGE ALONE states the exact affected count next to the verdict", () => {
    expect(safeToChangeAlone(hopTieredDependents(adjacency, "src/lib/log.ts"))).toEqual({
      safe: true,
      affected: 0,
      advice: "nothing depends on it",
    });
    const central = safeToChangeAlone(hopTieredDependents(adjacency, "src/config/env.ts"));
    expect(central.affected).toBe(3);
    expect(central.safe).toBe(true);
  });

  it("flips to NOT safe above the stated threshold, and says how many", () => {
    const wide = model(
      ["hub", ...Array.from({ length: 9 }, (_, i) => `dep${i}`)],
      Array.from({ length: 9 }, (_, i) => [`dep${i}`, "hub"] as [string, string]),
    );
    const verdict = safeToChangeAlone(hopTieredDependents(buildAdjacency(wide), "hub"));
    expect(verdict.safe).toBe(false);
    expect(verdict.affected).toBe(9);
    expect(verdict.advice).toContain("stage it");
  });
});

describe("isEntryProbable — a heuristic over facts, never rendered as a fact", () => {
  const graph = model(["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "src/c/orphan.ts"], [
    ["src/a/y.ts", "src/a/x.ts"],
    ["src/b/z.ts", "src/a/x.ts"],
  ]);
  const adjacency = buildAdjacency(graph);

  it("is true for a detected entry point, on hard evidence alone", () => {
    expect(isEntryProbable("src/c/orphan.ts", adjacency, new Set(["src/c/orphan.ts"]))).toBe(true);
  });

  it("is true for a module imported from OUTSIDE its own directory — the shape of a door", () => {
    expect(isEntryProbable("src/a/x.ts", adjacency, NONE)).toBe(true);
  });

  it("is FALSE for a module nothing imports", () => {
    expect(isEntryProbable("src/c/orphan.ts", adjacency, NONE)).toBe(false);
  });

  it("is FALSE for a module only its own directory uses — that is internal, not a door", () => {
    const internal = model(["src/a/x.ts", "src/a/y.ts"], [["src/a/y.ts", "src/a/x.ts"]]);
    expect(isEntryProbable("src/a/x.ts", buildAdjacency(internal), NONE)).toBe(false);
  });
});

describe("determinism", () => {
  it("the same input yields byte-identical output", () => {
    // These drive views that read as statements of fact, so two runs disagreeing would mean the
    // "facts" depend on iteration order.
    const inputs: LaneInput[] = [
      { fileId: "src/api/a.ts", path: "src/api/a.ts", role: "source" },
      { fileId: "src/db/b.ts", path: "src/db/b.ts", role: "source" },
      { fileId: "src/lib/c.ts", path: "src/lib/c.ts", role: "source" },
    ];
    const graph = model(["src/api/a.ts", "src/db/b.ts", "src/lib/c.ts"], [
      ["src/api/a.ts", "src/db/b.ts"],
      ["src/api/a.ts", "src/lib/c.ts"],
    ]);
    const once = classifyEdges(graph, lanesOf(inputs));
    const twice = classifyEdges(graph, lanesOf([...inputs].reverse()));
    // Edge ORDER follows the model's link order (stable); the CLASSIFICATION is order-independent.
    expect(JSON.stringify(once.counts)).toBe(JSON.stringify(twice.counts));
    expect(JSON.stringify(once.edges)).toBe(JSON.stringify(twice.edges));
  });
});
