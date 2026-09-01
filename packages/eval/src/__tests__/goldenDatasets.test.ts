import { describe, expect, it } from "vitest";
import { assertDatasetShape, EVAL_SCHEMA_VERSION, TEMPLATE_DATASET } from "../dataset.js";
import { loadGoldenDatasets, totalNegativeControls, totalQuestions } from "../datasets.js";

/**
 * The HERMETIC half of the eval check (V3-P0 §0.4) — this is what runs in CI.
 *
 * It cannot verify a SCORE: scoring needs an embedding provider, a real key, and money, so
 * that run is out-of-band (see .github/workflows/eval-scored.yml). What CI can and must
 * verify is that the golden set is well-formed, pinned, non-trivial and STABLE — because a
 * dataset that silently rots produces a confidently wrong number later.
 */
const loaded = await loadGoldenDatasets();

describe("golden datasets (hermetic checks — no keys, no network)", () => {
  it("ships at least two authored datasets", () => {
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    expect(loaded.map((entry) => entry.name)).toEqual([...loaded.map((entry) => entry.name)].sort());
  });

  it("every dataset passes the full runtime validation", () => {
    // loadGoldenDatasets already asserts; re-asserting here makes the failure attributable.
    for (const entry of loaded) {
      expect(() => assertDatasetShape(entry.dataset)).not.toThrow();
    }
  });

  it("every dataset is PINNED to a real 40-char commit and carries no REPLACE_ placeholders", () => {
    for (const entry of loaded) {
      expect(entry.dataset.commitSha).toMatch(/^[0-9a-f]{40}$/);
      const serialized = JSON.stringify(entry.dataset);
      expect(serialized).not.toContain("REPLACE");
      expect(entry.dataset.repoUrl).toMatch(/^https:\/\//);
      expect(entry.dataset.evalSchemaVersion).toBe(EVAL_SCHEMA_VERSION);
    }
  });

  it("records PROVENANCE — how the ground truth was established and what it measures", () => {
    // Without this, "which pipeline version are these numbers comparable against?" is
    // unanswerable, which is exactly the question a regression check has to answer.
    for (const entry of loaded) {
      expect(entry.dataset.provenance?.method, entry.name).toBeTruthy();
      expect(entry.dataset.provenance?.measures, entry.name).toBeTruthy();
    }
  });

  it("is substantial enough to measure anything: entry points + a real question count", () => {
    for (const entry of loaded) {
      expect(entry.dataset.synthesis.expectedEntryPoints.length, entry.name).toBeGreaterThan(0);
      expect(entry.dataset.questions.length, entry.name).toBeGreaterThanOrEqual(5);
    }
    expect(totalQuestions(loaded)).toBeGreaterThanOrEqual(12);
  });

  it("includes NEGATIVE CONTROLS — questions the repo cannot answer", () => {
    // A golden set with only answerable questions cannot tell a good retriever from one that
    // always returns something. These are scored on the answer path as justified refusals.
    expect(totalNegativeControls(loaded)).toBeGreaterThanOrEqual(2);
    for (const entry of loaded) {
      expect(entry.dataset.questions.some((question) => question.expectedFiles.length === 0), entry.name).toBe(true);
    }
  });

  it("grades every dataset in ONE embedding space per dataset", () => {
    for (const entry of loaded) {
      expect(entry.dataset.embeddingModel).toBeTruthy();
      expect(Number.isInteger(entry.dataset.embeddingDim) && entry.dataset.embeddingDim > 0).toBe(true);
    }
  });

  it("covers BOTH parser families the pipeline supports (JS/TS and Python)", () => {
    // A golden set that only exercises one grammar cannot catch a regression in the other.
    const allFiles = loaded.flatMap((entry) => entry.dataset.questions.flatMap((q) => q.expectedFiles));
    expect(allFiles.some((file) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file))).toBe(true);
    expect(allFiles.some((file) => file.endsWith(".py"))).toBe(true);
  });

  it("loads DETERMINISTICALLY — same files, byte-identical result", async () => {
    const again = await loadGoldenDatasets();
    expect(JSON.stringify(again)).toBe(JSON.stringify(loaded));
  });
});

describe("assertDatasetShape (runtime validation at the file boundary)", () => {
  function valid(): unknown {
    return JSON.parse(JSON.stringify(loaded[0].dataset));
  }

  it("rejects the shipped TEMPLATE, which is not runnable ground truth", () => {
    expect(() => assertDatasetShape(TEMPLATE_DATASET)).toThrow(/TEMPLATE|commitSha/i);
  });

  it("rejects a dataset that is not pinned to a full commit hash", () => {
    // An abbreviated or branch-name "sha" grades against a moving target.
    const short = valid() as Record<string, unknown>;
    short.commitSha = "661317e";
    expect(() => assertDatasetShape(short)).toThrow(/40-character hex/);
    short.commitSha = "main";
    expect(() => assertDatasetShape(short)).toThrow(/40-character hex/);
  });

  it("rejects an impossible or inverted line range", () => {
    // Such a range can NEVER be hit, so it would read as a permanent retrieval failure
    // rather than as the authoring mistake it is.
    const bad = valid() as { questions: Array<Record<string, unknown>> };
    bad.questions[0].expectedLines = [{ fileId: (bad.questions[0].expectedFiles as string[])[0], startLine: 50, endLine: 10 }];
    expect(() => assertDatasetShape(bad)).toThrow(/impossible line range/);

    const zero = valid() as { questions: Array<Record<string, unknown>> };
    zero.questions[0].expectedLines = [{ fileId: (zero.questions[0].expectedFiles as string[])[0], startLine: 0, endLine: 5 }];
    expect(() => assertDatasetShape(zero)).toThrow(/impossible line range/);
  });

  it("rejects expectedLines naming a file that is not in expectedFiles", () => {
    const bad = valid() as { questions: Array<Record<string, unknown>> };
    bad.questions[0].expectedLines = [{ fileId: "not/in/the/list.ts", startLine: 1, endLine: 2 }];
    expect(() => assertDatasetShape(bad)).toThrow(/not in expectedFiles/);
  });

  it("rejects duplicate question ids", () => {
    const bad = valid() as { questions: Array<Record<string, unknown>> };
    bad.questions.push({ ...bad.questions[0] });
    expect(() => assertDatasetShape(bad)).toThrow(/duplicates the id/);
  });

  it("rejects an absolute or Windows path in expectedFiles", () => {
    const bad = valid() as { questions: Array<Record<string, unknown>> };
    bad.questions[0].expectedFiles = ["/abs/path.ts"];
    bad.questions[0].expectedLines = undefined;
    expect(() => assertDatasetShape(bad)).toThrow(/repo-relative POSIX/);
  });

  it("ACCEPTS an empty expectedFiles list — that is a negative control, not a mistake", () => {
    const control = valid() as { questions: Array<Record<string, unknown>> };
    control.questions[0].expectedFiles = [];
    control.questions[0].expectedLines = undefined;
    expect(() => assertDatasetShape(control)).not.toThrow();
  });

  it("rejects a schema-version mismatch rather than grading against the wrong shape", () => {
    const bad = valid() as Record<string, unknown>;
    bad.evalSchemaVersion = EVAL_SCHEMA_VERSION + 1;
    expect(() => assertDatasetShape(bad)).toThrow(/evalSchemaVersion/);
  });
});
