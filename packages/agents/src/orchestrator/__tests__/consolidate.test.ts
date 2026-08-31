import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "@codeflow/shared-types";
import {
  consolidateKnowledge,
  KB_MAX_COMMUNITIES,
  KB_MAX_DETAIL_CHARS,
  KB_MAX_POINTS_PER_COMMUNITY,
  queryKnowledgeBase,
  renderKnowledgeBase,
} from "../consolidate.js";
import type { Blackboard, SpecialistFinding, SpecialistId } from "../contracts.js";

/**
 * V3-P5 task 6: offline consolidation of per-community findings into a compact queryable KB.
 *
 * Hermetic by construction — consolidation is extractive, so there is nothing to mock: no provider,
 * no clock, no RNG. That is the property most of these tests are really asserting.
 */

const AT = "2026-03-01T00:00:00.000Z";

function finding(
  specialist: SpecialistId,
  cluster: number,
  headline: string,
  overrides: Partial<SpecialistFinding> = {},
): SpecialistFinding {
  return {
    specialist,
    cluster,
    headline,
    detail: `Detail from ${specialist} about cluster ${cluster}.`,
    importance: "medium",
    fileIds: [`src/c${cluster}/a.ts`],
    ...overrides,
  };
}

function blackboardOf(findings: SpecialistFinding[], entries: Blackboard["entries"] = []): Blackboard {
  return { entries, findings };
}

function resultOf(options: { files?: string[]; clusters?: Array<{ id: number; files: string[] }> } = {}): AnalysisResult {
  const files = options.files ?? ["src/c0/a.ts", "src/c0/b.ts", "src/c1/a.ts", "src/index.ts"];
  return {
    id: "an-1",
    repository: { provider: "github", owner: "acme", name: "app" },
    commitSha: "abc123",
    warnings: [],
    entryPoints: [{ fileId: "src/index.ts", reason: "package.json main" }],
    graph: {
      nodes: files.map((id) => ({ id })),
      edges: [{ id: "e0", from: "src/index.ts", to: "src/c0/a.ts", type: "import", confidence: 1, evidence: "import" }],
      resolution: { resolved: 1, unresolved: 0 },
    },
    metrics: {
      summary: { fileCount: files.length },
      perFile: [
        { fileId: "src/c0/a.ts", fanIn: 3, fanOut: 1 },
        { fileId: "src/c0/b.ts", fanIn: 1, fanOut: 0 },
        { fileId: "src/c1/a.ts", fanIn: 0, fanOut: 2 },
      ],
      cycles: [{ files: ["src/c0/a.ts", "src/c0/b.ts"] }],
      clusters: {
        algorithm: "louvain",
        count: options.clusters?.length ?? 2,
        modularity: 0.42,
        clusters: (options.clusters ?? [
          { id: 0, files: ["src/c0/a.ts", "src/c0/b.ts"] },
          { id: 1, files: ["src/c1/a.ts"] },
        ]).map((cluster) => ({
          id: cluster.id,
          files: cluster.files,
          size: cluster.files.length,
          internalWeight: 2,
          externalWeight: 1,
        })),
      },
    },
  } as unknown as AnalysisResult;
}

describe("consolidateKnowledge — determinism, which is the point of doing it without an LLM", () => {
  it("produces byte-identical output for identical input", () => {
    const input = { result: resultOf(), blackboard: blackboardOf([finding("architecture", 0, "Owns user persistence")]), capturedAt: AT };
    expect(JSON.stringify(consolidateKnowledge(input))).toBe(JSON.stringify(consolidateKnowledge(input)));
  });

  it("is INDEPENDENT of blackboard append order", () => {
    // Findings arrive from concurrent specialists, so their order is a race. If the KB depended on
    // it, two runs of the same analysis would produce different knowledge bases.
    const result = resultOf();
    const a = finding("architecture", 0, "Owns user persistence");
    const b = finding("security", 1, "Validates nothing");
    const c = finding("data-flow", 0, "Reads from the queue");
    const forward = consolidateKnowledge({ result, blackboard: blackboardOf([a, b, c]), capturedAt: AT });
    const backward = consolidateKnowledge({ result, blackboard: blackboardOf([c, b, a]), capturedAt: AT });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("reads NO clock — capturedAt is whatever the caller supplied", () => {
    const kb = consolidateKnowledge({ result: resultOf(), blackboard: blackboardOf([]), capturedAt: "1999-01-01T00:00:00.000Z" });
    expect(kb.capturedAt).toBe("1999-01-01T00:00:00.000Z");
  });
});

describe("merging — corroboration is the thing consolidation adds", () => {
  it("merges the same point from two lenses and records BOTH", () => {
    // The information that did not exist before: two independent lenses agreeing.
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Owns user persistence"),
        finding("dependency-risk", 0, "owns USER persistence."),
      ]),
      capturedAt: AT,
    });
    const points = kb.communities[0].points;
    expect(points).toHaveLength(1);
    expect(points[0].corroboratedBy).toEqual(["architecture", "dependency-risk"]);
    expect(kb.reduction.mergedDuplicates).toBe(1);
  });

  it("does NOT merge headlines that differ only by a NUMBER — a real bug this had", () => {
    // The first version used the RETRIEVAL tokenizer for the merge key, which drops tokens shorter
    // than LEXICAL_MIN_TOKEN_LENGTH because single characters are noise when retrieving code. As a
    // merge key that made "Cluster 1 is risky" and "Cluster 2 is risky" normalise identically, so
    // two findings about different things collapsed into one and reported themselves as
    // corroborating each other. Caught by the point-cap test, which saw nine headlines become one.
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Table 1 is unindexed"),
        finding("architecture", 0, "Table 2 is unindexed"),
        finding("architecture", 0, "Table 3 is unindexed"),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points).toHaveLength(3);
    expect(kb.reduction.mergedDuplicates).toBe(0);
  });

  it("does NOT merge different points", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Owns user persistence"),
        finding("security", 0, "Owns user validation"),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points).toHaveLength(2);
    expect(kb.reduction.mergedDuplicates).toBe(0);
  });

  it("does NOT merge the same headline from DIFFERENT communities", () => {
    // Two modules can both own persistence; collapsing them would erase which is which.
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Owns persistence"),
        finding("architecture", 1, "Owns persistence"),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities).toHaveLength(2);
    expect(kb.reduction.mergedDuplicates).toBe(0);
  });

  it("takes the HIGHEST importance of a merged group", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Unbounded query", { importance: "low" }),
        finding("security", 0, "unbounded query", { importance: "high" }),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points[0].importance).toBe("high");
  });

  it("keeps the LONGEST detail of a merged group", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Unbounded query", { detail: "short" }),
        finding("security", 0, "unbounded query", { detail: "a considerably fuller explanation of the same thing" }),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points[0].detail).toMatch(/considerably fuller/);
  });

  it("ranks CORROBORATION above a lone finding at equal importance", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Agreed point"),
        finding("security", 0, "agreed point"),
        finding("api-surface", 0, "Solo point"),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points[0].headline).toBe("Agreed point");
    expect(kb.communities[0].points[0].corroboratedBy).toHaveLength(2);
  });
});

describe("grounding — re-checked, not trusted", () => {
  it("DROPS a fileId that is not a graph node, and counts it", () => {
    // A KB outlives the run that produced it, so an ungrounded citation would be the same failure
    // the three grounding passes exist to prevent, one layer later.
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([
        finding("architecture", 0, "Owns persistence", { fileIds: ["src/c0/a.ts", "src/imaginary.ts"] }),
      ]),
      capturedAt: AT,
    });
    expect(kb.communities[0].points[0].fileIds).toEqual(["src/c0/a.ts"]);
    expect(kb.reduction.droppedUngroundedFileIds).toBe(1);
  });

  it("does not count deterministic cluster files as dropped agent claims", () => {
    // The counter measures how often AGENTS cite files they should not. Folding an internal
    // partition mismatch into it would make one number mean two things.
    const kb = consolidateKnowledge({
      result: resultOf({ files: ["src/c0/a.ts"], clusters: [{ id: 0, files: ["src/c0/a.ts", "src/not-in-graph.ts"] }] }),
      blackboard: blackboardOf([finding("architecture", 0, "Owns persistence", { fileIds: ["src/c0/a.ts"] })]),
      capturedAt: AT,
    });
    expect(kb.reduction.droppedUngroundedFileIds).toBe(0);
    expect(kb.communities[0].keyFiles).toEqual(["src/c0/a.ts"]);
  });
});

describe("deterministic facts", () => {
  it("states scale, entry points, cycles, hubs and communities", () => {
    const kb = consolidateKnowledge({ result: resultOf(), blackboard: blackboardOf([]), capturedAt: AT });
    const ids = kb.facts.map((fact) => fact.id);
    expect(ids).toEqual(["scale", "entry-points", "cycles", "hubs", "communities"]);
    expect(kb.facts.find((fact) => fact.id === "hubs")?.statement).toMatch(/src\/c0\/a\.ts \(3 importers\)/);
  });

  it("reports the cycle COUNT plus one example, not every cycle", () => {
    // 40 cycles would otherwise become 40 facts nobody reads.
    const result = resultOf();
    (result.metrics as unknown as { cycles: unknown }).cycles = [
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts", "d.ts"] },
      { files: ["e.ts", "f.ts"] },
    ];
    const kb = consolidateKnowledge({ result, blackboard: blackboardOf([]), capturedAt: AT });
    const cycles = kb.facts.find((fact) => fact.id === "cycles");
    expect(cycles?.statement).toMatch(/are 3 dependency cycles/);
    expect(cycles?.statement).toMatch(/for example/);
  });

  it("omits facts it has no data for rather than inventing them", () => {
    const bare = { id: "an-2", repository: { provider: "github", name: "app" }, warnings: [] } as unknown as AnalysisResult;
    expect(consolidateKnowledge({ result: bare, blackboard: blackboardOf([]), capturedAt: AT }).facts).toEqual([]);
  });
});

describe("the FAQ", () => {
  it("answers the questions a newcomer asks, and labels the SOURCE of each", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([finding("architecture", 0, "Owns user persistence")]),
      capturedAt: AT,
    });
    const questions = kb.faq.map((entry) => entry.question);
    expect(questions).toContain("Where does execution start?");
    expect(questions).toContain("Are there dependency cycles?");
    expect(questions).toContain("Which files matter most / are most depended on?");
    expect(questions).toContain("What does community 0 do?");
    // A graph fact and a model judgement must be distinguishable.
    expect(kb.faq.find((entry) => entry.question === "Where does execution start?")?.source).toBe("graph");
    expect(kb.faq.find((entry) => entry.question === "What does community 0 do?")?.source).toBe("agents");
  });

  it("states the ABSENCE of cycles rather than omitting the question", () => {
    // "No cycles" is a real and good answer; omitting it makes a clean repo look unanalysed.
    const result = resultOf();
    (result.metrics as unknown as { cycles: unknown }).cycles = [];
    const kb = consolidateKnowledge({ result, blackboard: blackboardOf([]), capturedAt: AT });
    expect(kb.faq.find((entry) => entry.question === "Are there dependency cycles?")?.answer).toBe(
      "No dependency cycles were detected.",
    );
  });

  it("surfaces high-importance findings as a risks question", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([finding("security", 0, "Raw SQL from request input", { importance: "high" })]),
      capturedAt: AT,
    });
    const risks = kb.faq.find((entry) => entry.question === "What are the biggest risks or problems?");
    expect(risks?.answer).toMatch(/Raw SQL from request input/);
  });

  it("mentions corroboration in the community answer when there is any", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([finding("architecture", 0, "Owns persistence"), finding("security", 0, "owns persistence")]),
      capturedAt: AT,
    });
    expect(kb.faq.find((entry) => entry.question === "What does community 0 do?")?.answer).toMatch(
      /agreed by architecture, security/,
    );
  });
});

describe("compactness — the bounds, each on a different axis", () => {
  it("caps points per community and truncates a long detail", () => {
    const findings = Array.from({ length: KB_MAX_POINTS_PER_COMMUNITY + 4 }, (_, i) =>
      finding("architecture", 0, `Point number ${i}`, { detail: "x".repeat(KB_MAX_DETAIL_CHARS + 200) }),
    );
    const kb = consolidateKnowledge({ result: resultOf(), blackboard: blackboardOf(findings), capturedAt: AT });
    expect(kb.communities[0].points).toHaveLength(KB_MAX_POINTS_PER_COMMUNITY);
    expect(kb.communities[0].points[0].detail.length).toBe(KB_MAX_DETAIL_CHARS);
    expect(kb.communities[0].points[0].detail.endsWith("…")).toBe(true);
  });

  it("caps communities and REPORTS which were omitted", () => {
    const findings = Array.from({ length: KB_MAX_COMMUNITIES + 3 }, (_, i) => finding("architecture", i, `Point ${i}`));
    const kb = consolidateKnowledge({ result: resultOf(), blackboard: blackboardOf(findings), capturedAt: AT });
    expect(kb.communities).toHaveLength(KB_MAX_COMMUNITIES);
    expect(kb.reduction.omittedClusters).toHaveLength(3);
    // Sorted, so the report is stable.
    expect(kb.reduction.omittedClusters).toEqual([...kb.reduction.omittedClusters].sort((a, b) => a - b));
  });

  it("measures its own size, so 'compact' carries a number", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([finding("architecture", 0, "Owns persistence")]),
      capturedAt: AT,
    });
    expect(kb.reduction.jsonBytes).toBeGreaterThan(0);
    expect(kb.reduction.findingsIn).toBe(1);
    expect(kb.reduction.pointsOut).toBe(1);
  });
});

describe("gaps — a lens that produced nothing is never silent", () => {
  it("records refusals and failures with their reason", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf(
        [finding("architecture", 0, "Owns persistence")],
        [
          { specialist: "architecture", cluster: 0, status: "ok", findings: [], droppedFileIds: [], samples: 1 },
          { specialist: "security", cluster: 0, status: "refused", reason: "no security-relevant code", findings: [], droppedFileIds: [], samples: 1 },
          { specialist: "api-surface", cluster: 0, status: "skipped-budget", reason: "daily ceiling reached", findings: [], droppedFileIds: [], samples: 0 },
        ],
      ),
      capturedAt: AT,
    });
    expect(kb.communities[0].gaps).toEqual([
      { specialist: "api-surface", reason: "daily ceiling reached" },
      { specialist: "security", reason: "no security-relevant code" },
    ]);
  });

  it("falls back to the status when no reason was given", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf(
        [finding("architecture", 0, "Owns persistence")],
        [{ specialist: "security", cluster: 0, status: "failed", findings: [], droppedFileIds: [], samples: 1 }],
      ),
      capturedAt: AT,
    });
    expect(kb.communities[0].gaps[0].reason).toBe("failed");
  });
});

describe("queryKnowledgeBase", () => {
  const kb = consolidateKnowledge({
    result: resultOf(),
    blackboard: blackboardOf([
      finding("architecture", 0, "Owns user persistence", { detail: "Cluster 0 holds the repository classes and the ORM mapping." }),
      finding("security", 1, "Validates nothing", { detail: "Cluster 1 accepts request bodies without checking them." }),
    ]),
    capturedAt: AT,
  });

  it("finds the right entry for a question", () => {
    const hits = queryKnowledgeBase(kb, "where does execution start");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toMatch(/src\/index\.ts/);
  });

  it("matches an FAQ by its QUESTION, not only its answer", () => {
    // "are there cycles?" must find the cycles entry even though the answer may not use the word.
    const hits = queryKnowledgeBase(kb, "dependency cycles");
    expect(hits.some((hit) => hit.kind === "faq" || hit.kind === "fact")).toBe(true);
  });

  it("finds an agent finding by its prose", () => {
    const hits = queryKnowledgeBase(kb, "ORM mapping repository classes");
    expect(hits[0].text).toMatch(/ORM mapping/);
  });

  it("REFUSES rather than returning the least-bad entry", () => {
    // Same rule as the similarity floor: a KB that always replies is indistinguishable from one
    // that is guessing.
    expect(queryKnowledgeBase(kb, "kubernetes helm ingress annotations")).toEqual([]);
  });

  it("returns nothing for an empty question", () => {
    expect(queryKnowledgeBase(kb, "   ")).toEqual([]);
  });

  it("respects k", () => {
    expect(queryKnowledgeBase(kb, "cluster files community", 2).length).toBeLessThanOrEqual(2);
  });

  it("is deterministic, including ties", () => {
    const first = queryKnowledgeBase(kb, "cluster community files", 5);
    const second = queryKnowledgeBase(kb, "cluster community files", 5);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("carries grounded fileIds on every hit it returns", () => {
    const nodeIds = new Set((resultOf().graph?.nodes ?? []).map((node) => node.id));
    for (const hit of queryKnowledgeBase(kb, "persistence ORM index start", 5)) {
      for (const fileId of hit.fileIds) expect(nodeIds.has(fileId)).toBe(true);
    }
  });
});

describe("renderKnowledgeBase", () => {
  it("renders facts, communities, the FAQ and the reduction numbers", () => {
    const kb = consolidateKnowledge({
      result: resultOf(),
      blackboard: blackboardOf([finding("architecture", 0, "Owns persistence"), finding("security", 0, "owns persistence")]),
      capturedAt: AT,
    });
    const text = renderKnowledgeBase(kb);
    expect(text).toMatch(/acme\/app @ abc123/);
    expect(text).toMatch(/## Facts/);
    expect(text).toMatch(/### Community 0/);
    expect(text).toMatch(/\[agreed by architecture, security\]/);
    expect(text).toMatch(/## FAQ/);
    expect(text).toMatch(/consolidated 2 finding\(s\) → 1 point\(s\)/);
  });
});
