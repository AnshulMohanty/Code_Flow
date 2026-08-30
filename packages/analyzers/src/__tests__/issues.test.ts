import { describe, expect, it } from "vitest";
import type { FileMetrics, RepoMetrics } from "@codeflow/shared-types";
import { countIssues, deriveIssues } from "../pipeline/issues.js";

// V3-P0 — `issues` used to be a producerless slice the web read in four places, so an
// absent producer rendered as a finding of "no problems". Hermetic: plain metric fixtures.

function fileMetrics(fileId: string, extra: Partial<FileMetrics> = {}): FileMetrics {
  return { fileId, centrality: 0, fanIn: 0, fanOut: 0, blastRadius: 0, complexity: 0, ...extra };
}

function metrics(overrides: Partial<RepoMetrics> = {}): RepoMetrics {
  return {
    perFile: [],
    keyFiles: [],
    hotspots: [],
    cycles: [],
    summary: { fileCount: 0, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
    ...overrides,
  };
}

describe("deriveIssues", () => {
  it("reports nothing when nothing was measured (never a guess)", () => {
    expect(deriveIssues({})).toEqual([]);
    expect(deriveIssues({ metrics: metrics() })).toEqual([]);
  });

  it("reports every dependency cycle, escalating severity with cycle length", () => {
    const issues = deriveIssues({
      metrics: metrics({
        cycles: [{ files: ["a.ts", "b.ts"] }, { files: ["p.ts", "q.ts", "r.ts", "s.ts"] }],
        summary: { fileCount: 6, edgeCount: 8, cycleCount: 2, isolatedFileCount: 0, maxBlastRadius: 1 },
      }),
    });
    const cycles = issues.filter((issue) => issue.id.startsWith("cycle:"));
    expect(cycles).toHaveLength(2);
    expect(cycles.find((issue) => issue.id === "cycle:p.ts>q.ts>r.ts>s.ts")?.severity).toBe("high");
    expect(cycles.find((issue) => issue.id === "cycle:a.ts>b.ts")?.severity).toBe("medium");
    // Attributed to the cycle's lowest fileId so the issue is stably addressable.
    expect(cycles.find((issue) => issue.id === "cycle:a.ts>b.ts")?.fileId).toBe("a.ts");
    expect(cycles.every((issue) => issue.category === "architecture")).toBe(true);
  });

  it("reports a structural hub as a SHARE of the repo, not a raw count", () => {
    const issues = deriveIssues({
      metrics: metrics({
        perFile: [fileMetrics("hub.ts", { blastRadius: 6 })],
        summary: { fileCount: 10, edgeCount: 9, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 6 },
      }),
    });
    const hub = issues.find((issue) => issue.id === "blast-radius:hub.ts");
    expect(hub?.severity).toBe("high"); // 60% >= 50%
    expect(hub?.title).toContain("60%");
    expect(hub?.message).toContain("6 of 10 files");
  });

  it("does NOT report a hub on a repo too small for a share to mean anything", () => {
    // In a 3-file repo "affects 66% of the repository" is arithmetic, not a finding.
    const issues = deriveIssues({
      metrics: metrics({
        perFile: [fileMetrics("hub.ts", { blastRadius: 2 })],
        summary: { fileCount: 3, edgeCount: 2, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 2 },
      }),
    });
    expect(issues.filter((issue) => issue.id.startsWith("blast-radius:"))).toEqual([]);
  });

  it("reports high coupling on an absolute degree threshold", () => {
    const issues = deriveIssues({
      metrics: metrics({
        perFile: [fileMetrics("busy.ts", { centrality: 22, fanIn: 15, fanOut: 7 }), fileMetrics("calm.ts", { centrality: 3 })],
        summary: { fileCount: 30, edgeCount: 40, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 2 },
      }),
    });
    const coupling = issues.filter((issue) => issue.id.startsWith("coupling:"));
    expect(coupling).toHaveLength(1);
    expect(coupling[0].fileId).toBe("busy.ts");
    expect(coupling[0].message).toContain("imports 7 files and is imported by 15");
  });

  it("collapses a mostly-disconnected graph into ONE honest dependency issue", () => {
    // N separate "this file is isolated" notices would be noise, and the real message is
    // about the graph's completeness, not about any one file.
    const issues = deriveIssues({
      metrics: metrics({
        summary: { fileCount: 10, edgeCount: 1, cycleCount: 0, isolatedFileCount: 8, maxBlastRadius: 1 },
      }),
    });
    const isolated = issues.filter((issue) => issue.category === "dependency");
    expect(isolated).toHaveLength(1);
    expect(isolated[0].title).toContain("8 of 10 files");
    expect(isolated[0].message).toMatch(/path aliases|not fully supported/);
    expect(isolated[0].fileId).toBeUndefined(); // a graph-wide finding, not a file's fault
  });

  it("never fabricates a SECURITY finding — no security analysis is performed", () => {
    const issues = deriveIssues({
      metrics: metrics({
        perFile: [fileMetrics("hub.ts", { blastRadius: 9, centrality: 40, fanIn: 30, fanOut: 10 })],
        cycles: [{ files: ["a.ts", "b.ts", "c.ts", "d.ts"] }],
        summary: { fileCount: 10, edgeCount: 40, cycleCount: 1, isolatedFileCount: 9, maxBlastRadius: 9 },
      }),
    });
    expect(issues.some((issue) => issue.category === "security")).toBe(false);
    expect(countIssues(issues).securityIssues).toBe(0);
  });

  it("is deterministic: sorted by severity then id, and re-runs byte-identically", () => {
    const input = {
      metrics: metrics({
        perFile: [
          fileMetrics("z.ts", { centrality: 25, fanIn: 20, fanOut: 5 }),
          fileMetrics("a.ts", { centrality: 30, fanIn: 25, fanOut: 5, blastRadius: 8 }),
        ],
        cycles: [{ files: ["m.ts", "n.ts"] }],
        summary: { fileCount: 12, edgeCount: 60, cycleCount: 1, isolatedFileCount: 0, maxBlastRadius: 8 },
      }),
    };
    const first = deriveIssues(input);
    expect(JSON.stringify(deriveIssues(input))).toBe(JSON.stringify(first));

    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    for (let i = 1; i < first.length; i += 1) {
      const prev = first[i - 1];
      const next = first[i];
      expect(rank[prev.severity] <= rank[next.severity]).toBe(true);
      if (prev.severity === next.severity) expect(prev.id <= next.id).toBe(true);
    }
  });

  it("counts architecture violations for the summary slice", () => {
    const issues = deriveIssues({
      metrics: metrics({
        cycles: [{ files: ["a.ts", "b.ts"] }],
        summary: { fileCount: 10, edgeCount: 10, cycleCount: 1, isolatedFileCount: 0, maxBlastRadius: 1 },
      }),
    });
    expect(countIssues(issues)).toEqual({ securityIssues: 0, architectureViolations: 1 });
  });
});
