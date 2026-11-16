import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeLocal } from "../analyzeLocal.js";
import type { AnalysisResult } from "@codeflow/shared-types";
import { assertSafeRef, changedFilesSince, checkoutToTemp, computeImpact, renderImpactMarkdown, selectTests } from "../impact.js";

let repo: string;

async function write(relative: string, content: string) {
  const full = path.join(repo, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "codeflow-impact-"));
  git("init", "-q", "-b", "main");
  await write("package.json", JSON.stringify({ name: "demo", main: "src/index.ts" }));
  await write("src/index.ts", "import { run } from './app';\nrun();\n");
  await write("src/app.ts", "import { helper } from './util';\nexport const run = () => helper();\n");
  await write("src/util.ts", "export const helper = () => 1;\n");
  await write("src/lonely.ts", "export const lonely = 1;\n");
  await write("test/app.test.ts", "import { run } from '../src/app';\nrun();\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  // The PR: util now imports app at load time (a NEW cycle), lonely imports a file that does not
  // exist (a BROKEN import), and a new untested file appears (untracked, never committed).
  await write("src/util.ts", "import { run } from './app';\nexport const helper = () => 1;\nexport const again = run;\n");
  await write("src/lonely.ts", "import { gone } from './gone';\nexport const lonely = gone;\n");
  git("commit", "-q", "-am", "feature");
  await write("src/fresh.ts", "export const fresh = 1;\n");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("impact (end to end, real git)", () => {
  it("lists committed, modified and untracked changes against the merge-base", async () => {
    const changed = await changedFilesSince(repo, "main");
    expect(changed).toEqual([
      { path: "src/fresh.ts", status: "added" },
      { path: "src/lonely.ts", status: "modified" },
      { path: "src/util.ts", status: "modified" },
    ]);
  });

  it("reports the new cycle, the broken import, dependents, tests and entry points", async () => {
    const changed = await changedFilesSince(repo, "main");
    const head = (await analyzeLocal({ repoPath: repo, skipIndex: true })).result;
    const checkout = await checkoutToTemp(repo, "main");
    let baseResult;
    try {
      baseResult = (await analyzeLocal({ repoPath: checkout.dir, skipIndex: true })).result;
    } finally {
      await checkout.cleanup();
    }
    const report = computeImpact(head, changed, { base: "main", baseResult });

    expect(report.newCycles).toEqual([expect.arrayContaining(["src/app.ts", "src/util.ts"])]);
    expect(report.brokenImports).toEqual([{ from: "src/lonely.ts", specifier: "./gone" }]);
    const util = report.files.find((file) => file.path === "src/util.ts")!;
    expect(util.transitiveDependents).toBeGreaterThanOrEqual(2); // app.ts and index.ts
    expect(util.testsReaching).toBe(1);
    expect(report.entryPointsAffected).toContain("src/index.ts");
    expect(report.untested).toEqual(["src/fresh.ts", "src/lonely.ts"]);

    const markdown = renderImpactMarkdown(report);
    expect(markdown).toContain("❌ **1 new import cycle(s)**");
    expect(markdown).toContain("`src/lonely.ts` imports `./gone`");
  });
});

describe("test selection", () => {
  it("selects the tests whose import closure reaches the change, plus changed tests themselves", async () => {
    const head = (await analyzeLocal({ repoPath: repo, skipIndex: true, factsCache: false })).result;
    // util ← app ← test/app.test.ts
    expect(selectTests(head, [{ path: "src/util.ts", status: "modified" }])).toEqual({ tests: ["test/app.test.ts"], all: false });
    expect(selectTests(head, [{ path: "test/app.test.ts", status: "modified" }]).tests).toEqual(["test/app.test.ts"]);
    // Nothing reaches lonely.ts: nothing to run.
    expect(selectTests(head, [{ path: "src/lonely.ts", status: "modified" }])).toEqual({ tests: [], all: false });
  });

  it("selects EVERY test when a change cannot be traced through imports (a manifest, a config)", async () => {
    const head = (await analyzeLocal({ repoPath: repo, skipIndex: true, factsCache: false })).result;
    const selection = selectTests(head, [{ path: "package.json", status: "modified" }, { path: "src/util.ts", status: "modified" }]);
    expect(selection.all).toBe(true);
    expect(selection.tests).toEqual(["test/app.test.ts"]);
    expect(selection.reason).toContain("package.json");
  });

  it("Go: a package's own tests and its dependents' package tests, though no test imports the file", () => {
    const node = (id: string, layer: string) => ({ id, path: id, name: id, layer, language: "Go", lines: 1, symbolCount: 0 });
    const head = {
      graph: {
        nodes: [
          node("store/open.go", "source"),
          node("store/open_test.go", "test"),
          node("api/server.go", "source"),
          node("api/server_test.go", "test"),
          node("cli/main.go", "source"),
          node("cli/main_test.go", "test"),
        ],
        edges: [{ from: "api/server.go", to: "store/open.go", kind: "import", specifier: "example.com/store" }],
      },
    } as unknown as AnalysisResult;
    expect(selectTests(head, [{ path: "store/open.go", status: "modified" }]).tests).toEqual(["api/server_test.go", "store/open_test.go"]);
  });
});

describe("ref safety", () => {
  it("refuses a ref git would parse as an option", async () => {
    expect(() => assertSafeRef("--output=/tmp/x")).toThrow(/unsafe git ref/);
    expect(() => assertSafeRef("-p")).toThrow(/unsafe git ref/);
    expect(() => assertSafeRef("main thing")).toThrow(/unsafe git ref/);
    expect(assertSafeRef("origin/main")).toBe("origin/main");
    await expect(checkoutToTemp(repo, "--output=/tmp/codeflow-pwn")).rejects.toThrow(/unsafe git ref/);
  });
});
