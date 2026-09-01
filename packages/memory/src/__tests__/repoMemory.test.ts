import { describe, expect, it } from "vitest";
import { REPO_MAX_SNAPSHOTS } from "@codeflow/config";
import type { AnalysisResult } from "@codeflow/shared-types";
import { createMemoryRepoStore, describeDiff, diffSnapshots, snapshotOf } from "../repoMemory.js";
import { repoKeyOf } from "../contracts.js";

// Repo memory answers "what changed?". The properties that matter: a snapshot of the same tree is
// byte-identical (so an unchanged commit diffs to nothing BY CONSTRUCTION), the diff distinguishes
// direction, and a NEW dependency cycle is called out because it is the most actionable line a
// diff can contain.

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 10, symbolCount: 1 };
}

function result(overrides: {
  sha?: string;
  files?: string[];
  edges?: Array<[string, string]>;
  symbols?: Array<{ file: string; name: string }>;
  cycles?: string[][];
}): AnalysisResult {
  const files = overrides.files ?? ["src/a.ts", "src/b.ts"];
  const nodes = files.map(node);
  return {
    id: "r1",
    repository: { provider: "github", owner: "acme", name: "repo" },
    mode: "public_hosted",
    createdAt: "2026-08-31T00:00:00.000Z",
    commitSha: overrides.sha ?? "a".repeat(40),
    warnings: [],
    summary: {
      repository: { provider: "github", owner: "acme", name: "repo" },
      mode: "public_hosted",
      files: nodes.length,
      functions: 0,
      connections: 0,
      healthScore: null,
      healthGrade: null,
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    graph: {
      nodes,
      edges: (overrides.edges ?? []).map(([from, to]) => ({ from, to, kind: "import" as const, specifier: "./x" })),
      resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
    },
    inventory: {
      symbols: (overrides.symbols ?? []).map((entry) => ({
        name: entry.name,
        kind: "function" as const,
        filePath: entry.file,
        line: 1,
        exported: true,
        language: "TypeScript",
      })),
      entryPoints: [],
      symbolCount: (overrides.symbols ?? []).length,
      loc: {},
    },
    metrics: {
      perFile: [],
      keyFiles: [],
      hotspots: [],
      cycles: (overrides.cycles ?? []).map((cycleFiles) => ({ files: cycleFiles })),
      summary: { fileCount: nodes.length, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
    },
  };
}

const AT = "2026-08-31T00:00:00.000Z";

describe("snapshotOf", () => {
  it("is SORTED throughout, so the same tree always produces the same snapshot", () => {
    // This is what makes an unchanged commit diff to nothing by construction rather than by luck.
    const a = snapshotOf(result({ files: ["src/b.ts", "src/a.ts"], edges: [["src/b.ts", "src/a.ts"]] }), AT);
    const b = snapshotOf(result({ files: ["src/a.ts", "src/b.ts"], edges: [["src/b.ts", "src/a.ts"]] }), AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.fileIds).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keys a cycle by its SORTED members", () => {
    // The same cycle reported from a different starting node must not read as a new one.
    const a = snapshotOf(result({ cycles: [["src/b.ts", "src/a.ts"]] }), AT);
    const b = snapshotOf(result({ cycles: [["src/a.ts", "src/b.ts"]] }), AT);
    expect(a.cycles).toEqual(b.cycles);
    expect(a.cycles).toEqual(["src/a.ts|src/b.ts"]);
  });

  it("dedupes and sorts symbols per file", () => {
    const snapshot = snapshotOf(
      result({ symbols: [{ file: "src/a.ts", name: "z" }, { file: "src/a.ts", name: "a" }, { file: "src/a.ts", name: "z" }] }),
      AT,
    );
    expect(snapshot.symbolsByFile["src/a.ts"]).toEqual(["a", "z"]);
  });

  it("takes `capturedAt` as an argument — it reads no clock", () => {
    // A clock read inside a pure derivation makes it untestable and non-reproducible, the same
    // reason V3-P1's size guard is a byte ceiling rather than a timeout.
    expect(snapshotOf(result({}), "2020-01-01T00:00:00.000Z").capturedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("keys by owner/name", () => {
    expect(snapshotOf(result({}), AT).repoFullName).toBe("acme/repo");
    expect(repoKeyOf({ provider: "local", name: "solo" })).toBe("solo");
  });
});

describe("diffSnapshots", () => {
  it("reports `identical` for two snapshots of the same tree", () => {
    const before = snapshotOf(result({ sha: "a".repeat(40) }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40) }), AT);
    const diff = diffSnapshots(before, after);
    expect(diff.identical).toBe(true);
    expect(describeDiff(diff)).toMatch(/No structural change/);
  });

  it("reports added and removed files", () => {
    const before = snapshotOf(result({ files: ["src/a.ts", "src/gone.ts"] }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40), files: ["src/a.ts", "src/new.ts"] }), AT);
    const diff = diffSnapshots(before, after);
    expect(diff.addedFiles).toEqual(["src/new.ts"]);
    expect(diff.removedFiles).toEqual(["src/gone.ts"]);
  });

  it("reports a file whose SYMBOL SET changed, not one that was merely reformatted", () => {
    // Symbol sets are the closest thing to "this file changed" available without hashing contents,
    // and for "should I care?" it is more useful: a reformat produces nothing, a renamed export does.
    const before = snapshotOf(result({ symbols: [{ file: "src/a.ts", name: "oldName" }] }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40), symbols: [{ file: "src/a.ts", name: "newName" }] }), AT);
    const diff = diffSnapshots(before, after);
    expect(diff.changedFiles).toEqual([{ fileId: "src/a.ts", addedSymbols: ["newName"], removedSymbols: ["oldName"] }]);
  });

  it("does NOT report an added file as 'changed'", () => {
    const before = snapshotOf(result({ files: ["src/a.ts"] }), AT);
    const after = snapshotOf(
      result({ sha: "b".repeat(40), files: ["src/a.ts", "src/new.ts"], symbols: [{ file: "src/new.ts", name: "f" }] }),
      AT,
    );
    const diff = diffSnapshots(before, after);
    expect(diff.addedFiles).toEqual(["src/new.ts"]);
    expect(diff.changedFiles).toEqual([]);
  });

  it("reports dependency edges in both directions of change", () => {
    const before = snapshotOf(result({ edges: [["src/a.ts", "src/b.ts"]] }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40), edges: [["src/b.ts", "src/a.ts"]] }), AT);
    const diff = diffSnapshots(before, after);
    expect(diff.addedEdges).toEqual(["src/b.ts>src/a.ts"]);
    expect(diff.removedEdges).toEqual(["src/a.ts>src/b.ts"]);
  });

  it("calls out a NEW cycle separately — the most actionable line in a diff", () => {
    const before = snapshotOf(result({}), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40), cycles: [["src/a.ts", "src/b.ts"]] }), AT);
    const diff = diffSnapshots(before, after);
    expect(diff.newCycles).toEqual(["src/a.ts|src/b.ts"]);
    expect(diff.resolvedCycles).toEqual([]);
    expect(describeDiff(diff)).toMatch(/NEW dependency cycles/);
  });

  it("reports a resolved cycle too", () => {
    const before = snapshotOf(result({ cycles: [["src/a.ts", "src/b.ts"]] }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40) }), AT);
    expect(diffSnapshots(before, after).resolvedCycles).toEqual(["src/a.ts|src/b.ts"]);
  });

  it("REFUSES to diff two different repositories", () => {
    const before = snapshotOf(result({}), AT);
    const after = { ...snapshotOf(result({ sha: "b".repeat(40) }), AT), repoFullName: "other/repo" };
    expect(() => diffSnapshots(before, after)).toThrow(/two different repositories/);
  });

  it("is deterministic", () => {
    const before = snapshotOf(result({ files: ["src/a.ts"] }), AT);
    const after = snapshotOf(result({ sha: "b".repeat(40), files: ["src/a.ts", "src/z.ts", "src/m.ts"] }), AT);
    expect(JSON.stringify(diffSnapshots(before, after))).toBe(JSON.stringify(diffSnapshots(before, after)));
  });
});

describe("describeDiff", () => {
  it("BOUNDS each section and states the total it truncated from", () => {
    // This text goes into a prompt: a 900-file rename must not become a 900-line context pillar,
    // and a reader must never mistake a prefix for the whole answer.
    const before = snapshotOf(result({ files: ["src/keep.ts"] }), AT);
    const many = ["src/keep.ts", ...Array.from({ length: 25 }, (_, i) => `src/new${i}.ts`)];
    const after = snapshotOf(result({ sha: "b".repeat(40), files: many }), AT);
    const text = describeDiff(diffSnapshots(before, after), 5);
    expect(text).toMatch(/\(\+20 more of 25\)/);
  });

  it("shows short SHAs, and says so when a commit is unpinned", () => {
    const before = { ...snapshotOf(result({}), AT), commitSha: "" };
    const after = snapshotOf(result({ sha: "b".repeat(40), files: ["src/a.ts", "src/b.ts", "src/c.ts"] }), AT);
    expect(describeDiff(diffSnapshots(before, after))).toContain("(unpinned)");
    expect(describeDiff(diffSnapshots(before, after))).toContain("bbbbbbbbbbbb");
  });
});

describe("createMemoryRepoStore", () => {
  it("lists snapshots most recent FIRST", async () => {
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(result({ sha: "a".repeat(40) }), AT));
    await store.put(snapshotOf(result({ sha: "b".repeat(40) }), AT));
    expect((await store.list("acme/repo")).map((entry) => entry.commitSha[0])).toEqual(["b", "a"]);
  });

  it("OVERWRITES the same SHA rather than appending a duplicate", async () => {
    // Re-analysing a commit produces the same snapshot; a duplicate would waste a slot and make
    // `list()` misleading about how many commits are known.
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(result({ sha: "a".repeat(40), files: ["src/a.ts"] }), AT));
    await store.put(snapshotOf(result({ sha: "a".repeat(40), files: ["src/a.ts", "src/b.ts"] }), AT));
    const listed = await store.list("acme/repo");
    expect(listed).toHaveLength(1);
    expect(listed[0].fileIds).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("bounds snapshots per repository, keeping the most recent", async () => {
    const store = createMemoryRepoStore();
    for (let i = 0; i < REPO_MAX_SNAPSHOTS + 4; i++) {
      await store.put(snapshotOf(result({ sha: String(i).padStart(40, "0") }), AT));
    }
    const listed = await store.list("acme/repo");
    expect(listed).toHaveLength(REPO_MAX_SNAPSHOTS);
    expect(listed[0].commitSha).toBe(String(REPO_MAX_SNAPSHOTS + 3).padStart(40, "0"));
  });

  it("gets by SHA, returns null when unknown, and clears a repository", async () => {
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(result({ sha: "a".repeat(40) }), AT));
    expect(await store.get("acme/repo", "a".repeat(40))).not.toBeNull();
    expect(await store.get("acme/repo", "z".repeat(40))).toBeNull();
    expect(await store.get("other/repo", "a".repeat(40))).toBeNull();
    await store.clear("acme/repo");
    expect(await store.list("acme/repo")).toEqual([]);
  });

  it("hands out copies", async () => {
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(result({ sha: "a".repeat(40) }), AT));
    const handed = await store.list("acme/repo");
    handed[0].fileIds.length = 0;
    expect((await store.list("acme/repo"))[0].fileIds.length).toBeGreaterThan(0);
  });
});
