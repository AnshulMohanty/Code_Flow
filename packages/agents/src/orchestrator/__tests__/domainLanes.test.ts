import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "@codeflow/shared-types";
import { buildDomainLanes, LANE_MAX_HEADLINES, LANE_MAX_MODULES, SPECIALIST_TAGS } from "../domainLanes.js";
import type { RepoKnowledgeBase } from "../consolidate.js";

/**
 * V3-FINAL. The fan-out's per-community findings were paid for and discarded: the supervisor read a
 * bounded twelve and the rest died with the run, so no surface could show a user what five
 * specialists found. These assertions are about the projection that fixes it — and specifically
 * about the two things a durable artefact of MODEL output must get right: every module id is real,
 * and nothing invented is presented as a fact.
 */

function resultWith(nodeIds: string[]): AnalysisResult {
  const nodes = nodeIds.map((id) => ({
    id,
    path: id,
    name: id.split("/").pop()!,
    layer: "source",
    language: "TypeScript",
    lines: 10,
    symbolCount: 1,
  }));
  return { files: nodes, graph: { nodes, edges: [] } } as unknown as AnalysisResult;
}

function kbWith(
  communities: Array<{
    cluster: number;
    keyFiles?: string[];
    specialists?: string[];
    points?: Array<{ headline: string; fileIds: string[]; corroboratedBy: string[] }>;
  }>,
): RepoKnowledgeBase {
  return {
    repoFullName: "acme/repo",
    commitSha: "a".repeat(40),
    capturedAt: "1970-01-01T00:00:00.000Z",
    facts: [],
    communities: communities.map((community) => ({
      cluster: community.cluster,
      fileCount: (community.keyFiles ?? []).length,
      keyFiles: community.keyFiles ?? [],
      specialists: (community.specialists ?? ["architecture"]) as never,
      points: (community.points ?? []).map((point) => ({
        headline: point.headline,
        detail: "d".repeat(50),
        importance: "medium" as const,
        corroboratedBy: point.corroboratedBy as never,
        fileIds: point.fileIds,
      })),
      gaps: [],
    })),
    faq: [],
    reduction: {
      findingsIn: 0,
      pointsOut: 0,
      mergedDuplicates: 0,
      droppedUngroundedFileIds: 0,
      omittedClusters: [],
      jsonBytes: 0,
    },
  };
}

const never = () => false;

describe("buildDomainLanes — grounded, bounded, and never a fact it is not", () => {
  it("RE-GROUNDS every module id against the graph, dropping what does not exist", () => {
    // A stale id in a durable artefact would outlive the run that produced it — the same failure the
    // three grounding passes prevent, one layer later.
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([
        {
          cluster: 0,
          keyFiles: ["src/auth/session.ts", "src/ghost.ts"],
          points: [{ headline: "identity is trusted", fileIds: ["src/auth/session.ts", "src/invented.ts"], corroboratedBy: ["security"] }],
        },
      ]),
      result: resultWith(["src/auth/session.ts"]),
      isEntryProbable: never,
    });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].moduleIds).toEqual(["src/auth/session.ts"]);
  });

  it("DROPS a lane whose every module was ungrounded, rather than rendering an empty one", () => {
    // An empty lane would claim a domain was detected when nothing about it survived grounding.
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([{ cluster: 0, keyFiles: ["src/ghost.ts"], points: [] }]),
      result: resultWith(["src/real.ts"]),
      isEntryProbable: never,
    });
    expect(lanes).toEqual([]);
  });

  it("DERIVES the title from real shared paths — never model prose", () => {
    // A model-written title ("Authentication & identity") reads as a fact while being a guess, and
    // would be a second thing to ground.
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([{ cluster: 0, keyFiles: ["src/auth/session.ts", "src/auth/verify.ts"] }]),
      result: resultWith(["src/auth/session.ts", "src/auth/verify.ts"]),
      isEntryProbable: never,
    });
    expect(lanes[0].title).toBe("src/auth");
  });

  it("falls back to the first module's directory when the group shares nothing", () => {
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([{ cluster: 0, keyFiles: ["src/a/x.ts", "lib/b/y.ts"] }]),
      result: resultWith(["src/a/x.ts", "lib/b/y.ts"]),
      isEntryProbable: never,
    });
    // Sorted module ids put `lib/b/y.ts` first; the title still points at something real.
    expect(lanes[0].title).toBe("lib/b");
  });

  it("names the DOMINANT lens by finding count, deterministically", () => {
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([
        {
          cluster: 0,
          keyFiles: ["src/auth/a.ts"],
          specialists: ["architecture", "security"],
          points: [
            { headline: "one", fileIds: ["src/auth/a.ts"], corroboratedBy: ["security"] },
            { headline: "two", fileIds: ["src/auth/a.ts"], corroboratedBy: ["security", "architecture"] },
          ],
        },
      ]),
      result: resultWith(["src/auth/a.ts"]),
      isEntryProbable: never,
    });
    expect(lanes[0].agentTag).toBe(SPECIALIST_TAGS.security);
  });

  it("says `unattributed` rather than defaulting to a lens that did not speak", () => {
    // Silently defaulting to `architecture` would attribute a security finding to the wrong lens.
    const kb = kbWith([{ cluster: 0, keyFiles: ["src/a.ts"], specialists: [] }]);
    const lanes = buildDomainLanes({ knowledgeBase: kb, result: resultWith(["src/a.ts"]), isEntryProbable: never });
    expect(lanes[0].agentTag).toBe("unattributed");
  });

  it("counts CORROBORATION — findings two independent lenses agreed on", () => {
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([
        {
          cluster: 0,
          keyFiles: ["src/a.ts"],
          points: [
            { headline: "agreed", fileIds: ["src/a.ts"], corroboratedBy: ["security", "architecture"] },
            { headline: "solo", fileIds: ["src/a.ts"], corroboratedBy: ["security"] },
          ],
        },
      ]),
      result: resultWith(["src/a.ts"]),
      isEntryProbable: never,
    });
    expect(lanes[0].corroborated).toBe(1);
  });

  it("counts entry-probable modules from the INJECTED graph derivation, not from the agent", () => {
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([{ cluster: 0, keyFiles: ["src/a.ts", "src/b.ts"] }]),
      result: resultWith(["src/a.ts", "src/b.ts"]),
      isEntryProbable: (fileId) => fileId === "src/a.ts",
    });
    expect(lanes[0].entryProbable).toBe(1);
  });

  it("BOUNDS modules and headlines, because this rides the analysis document", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/m${String(i).padStart(2, "0")}.ts`);
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([
        {
          cluster: 0,
          keyFiles: many,
          points: Array.from({ length: 10 }, (_, i) => ({
            headline: `h${i}`,
            fileIds: many,
            corroboratedBy: ["architecture"],
          })),
        },
      ]),
      result: resultWith(many),
      isEntryProbable: never,
    });
    expect(lanes[0].moduleIds).toHaveLength(LANE_MAX_MODULES);
    expect(lanes[0].headlines).toHaveLength(LANE_MAX_HEADLINES);
  });

  it("orders lanes by size then cluster, so the view is stable across runs", () => {
    const lanes = buildDomainLanes({
      knowledgeBase: kbWith([
        { cluster: 5, keyFiles: ["src/a.ts"] },
        { cluster: 2, keyFiles: ["src/b.ts", "src/c.ts", "src/d.ts"] },
      ]),
      result: resultWith(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
      isEntryProbable: never,
    });
    expect(lanes.map((lane) => lane.cluster)).toEqual([2, 5]);
  });

  it("is REPRODUCIBLE: the same knowledge base yields a byte-identical projection", () => {
    const kb = kbWith([
      { cluster: 0, keyFiles: ["src/a/x.ts", "src/a/y.ts"], points: [{ headline: "h", fileIds: ["src/a/x.ts"], corroboratedBy: ["security"] }] },
      { cluster: 1, keyFiles: ["src/b/z.ts"] },
    ]);
    const result = resultWith(["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"]);
    const once = buildDomainLanes({ knowledgeBase: kb, result, isEntryProbable: never });
    const twice = buildDomainLanes({ knowledgeBase: kb, result, isEntryProbable: never });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
