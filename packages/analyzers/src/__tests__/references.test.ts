import { describe, expect, it } from "vitest";
import { physicalLineCount } from "../stages/inventory.js";
import {
  buildReferenceIndex,
  extractCodeReferences,
  formatVerificationReport,
  verifyReferences,
  type ReferenceIndex,
} from "../verify/references.js";

const index: ReferenceIndex = {
  paths: [
    "packages/analyzers/src/stages/rag.ts",
    "packages/analyzers/src/index.ts",
    "apps/api/src/index.ts",
    "apps/worker/src/index.ts",
    "README.md",
    "src/requests/models.py",
  ],
  lineCount: (path) =>
    ({
      "packages/analyzers/src/stages/rag.ts": 766,
      "packages/analyzers/src/index.ts": 90,
      "apps/api/src/index.ts": 80,
      "apps/worker/src/index.ts": 420,
      "src/requests/models.py": 1000,
    })[path],
  symbolsIn: (path) =>
    ({
      "packages/analyzers/src/stages/rag.ts": [
        { name: "createRagStage", line: 128, endLine: 300 },
        { name: "embedWithRetry", line: 720, endLine: 745 },
      ],
      "src/requests/models.py": [
        { name: "Request", line: 250, endLine: 320 },
        { name: "prepare", line: 300, endLine: 318 },
      ],
      "apps/api/src/index.ts": [],
    })[path],
};

describe("extractCodeReferences", () => {
  it("reads path:line, ranges, #L anchors, GitHub blob URLs and trailing 'line N'", () => {
    const refs = extractCodeReferences(
      [
        "See src/a.ts:42 and src/b.ts:10-20.",
        "Also https://github.com/acme/repo/blob/0123abc/lib/c.py#L5-L9 and `d/e.go` line 7.",
        "The diff touches a/src/f.tsx.",
      ].join("\n"),
    );
    expect(refs.map((r) => [r.path, r.startLine, r.endLine])).toEqual([
      ["src/a.ts", 42, undefined],
      ["src/b.ts", 10, 20],
      ["lib/c.py", 5, 9],
      ["d/e.go", 7, undefined],
      ["src/f.tsx", undefined, undefined],
    ]);
  });

  it("keeps Next.js route groups and dynamic segments, but not wrapping parentheses", () => {
    const refs = extractCodeReferences("(see app/(dashboard)/[id]/page.tsx:3)");
    expect(refs.map((r) => [r.path, r.startLine])).toEqual([["app/(dashboard)/[id]/page.tsx", 3]]);
  });

  it("attaches the backticked symbol written next to a reference", () => {
    const refs = extractCodeReferences("`createRagStage` in packages/analyzers/src/stages/rag.ts:128 builds the index.");
    expect(refs[0]).toMatchObject({ path: "packages/analyzers/src/stages/rag.ts", startLine: 128, symbol: "createRagStage" });
  });

  it("marks a bare filename in prose as loose (it may just be a product name)", () => {
    const refs = extractCodeReferences("Built with Node.js. Edit `config.json` or app.ts:3.");
    expect(refs.map((r) => [r.path, r.loose ?? false])).toEqual([
      ["Node.js", true],
      ["config.json", false],
      ["app.ts", false],
    ]);
  });
});

describe("verifyReferences", () => {
  it("passes real references and fails fabricated files, lines and symbols", async () => {
    const report = await verifyReferences(
      [
        "1. `createRagStage` in packages/analyzers/src/stages/rag.ts:128 builds the index.", // pass
        "2. The worker boots in apps/worker/src/index.ts:9999.", // line out of range
        "3. Retries live in `retryForever` (packages/analyzers/src/stages/rag.ts:720).", // symbol not declared
        "4. `embedWithRetry` at packages/analyzers/src/stages/rag.ts:40 retries.", // wrong lines
        "5. Config is loaded by packages/config/src/loader.ts.", // missing file
        "6. stages/rag.ts is the RAG stage.", // unique suffix → pass
        "7. index.ts:3 is ambiguous.", // ambiguous
        "8. Built on Node.js.", // prose — dropped
      ].join("\n"),
      index,
    );
    expect(report.references.map((r) => [r.path, r.verdict])).toEqual([
      ["packages/analyzers/src/stages/rag.ts", "ok"],
      ["apps/worker/src/index.ts", "line-out-of-range"],
      ["packages/analyzers/src/stages/rag.ts", "symbol-not-in-file"],
      ["packages/analyzers/src/stages/rag.ts", "symbol-not-at-lines"],
      ["packages/config/src/loader.ts", "missing-file"],
      ["stages/rag.ts", "ok-resolved"],
      ["index.ts", "ambiguous-file"],
    ]);
    expect([report.pass, report.warn, report.fail]).toEqual([2, 1, 4]);
  });

  it("accepts a method cited by its owner's name (`Request.prepare`)", async () => {
    const report = await verifyReferences("`Request.prepare` — src/requests/models.py:300", index);
    expect(report.references[0]).toMatchObject({ status: "pass" });
  });

  it("says a symbol is unverifiable rather than wrong when the file was not parsed", async () => {
    const report = await verifyReferences("`Install` in README.md", index);
    expect(report.references[0]).toMatchObject({ status: "warn", verdict: "symbol-unverifiable" });
  });

  it("formats a markdown table for PR comments", async () => {
    const report = await verifyReferences("apps/worker/src/index.ts:9999", index);
    const markdown = formatVerificationReport(report, "markdown");
    expect(markdown).toContain("| ❌ | `apps/worker/src/index.ts:9999` | line 9999 is outside the file (420 lines) |");
  });
});

describe("buildReferenceIndex", () => {
  it("bounds lines by PHYSICAL length, never by loc (which skips blanks and comments)", async () => {
    const result = {
      graph: { nodes: [{ id: "src/a.ts", lines: 50 }] },
      inventory: { symbols: [], loc: { "src/a.ts": 50 }, lines: { "src/a.ts": 80 }, entryPoints: [], symbolCount: 0 },
    } as unknown as Parameters<typeof buildReferenceIndex>[0];
    const report = await verifyReferences("src/a.ts:75 and src/a.ts:81", buildReferenceIndex(result));
    expect(report.references.map((r) => r.verdict)).toEqual(["ok", "line-out-of-range"]);
  });

  it("leaves lines unchecked (warn) rather than guessing when the length is unknown", async () => {
    const result = { graph: { nodes: [{ id: "docs/guide.md", lines: 0 }] }, inventory: undefined } as unknown as Parameters<
      typeof buildReferenceIndex
    >[0];
    const report = await verifyReferences("docs/guide.md:12", buildReferenceIndex(result));
    expect(report.references[0]).toMatchObject({ status: "warn", verdict: "lines-unverifiable" });
  });
});

describe("physicalLineCount", () => {
  it("counts lines the way an editor numbers them", () => {
    expect([physicalLineCount(""), physicalLineCount("a"), physicalLineCount("a\n"), physicalLineCount("a\r\nb"), physicalLineCount("a\n\n")]).toEqual([
      0, 1, 1, 2, 2,
    ]);
  });
});
