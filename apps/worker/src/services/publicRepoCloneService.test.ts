import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLanguageBreakdown,
  buildPublicCloneUrl,
  cleanupRepoPath,
  discoverRepoFiles,
  languageForExtension,
  normalizeGitHubRepoInput,
  shouldExcludeDirectory,
} from "./publicRepoCloneService.js";

let tempRoot: string;
let originalKeepTmp: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "codeflow-clone-service-test-"));
  originalKeepTmp = process.env.CODEFLOW_KEEP_TMP;
});

afterEach(async () => {
  if (originalKeepTmp === undefined) {
    delete process.env.CODEFLOW_KEEP_TMP;
  } else {
    process.env.CODEFLOW_KEEP_TMP = originalKeepTmp;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe("publicRepoCloneService", () => {
  it("normalizes safe GitHub owner repo and branch input", () => {
    expect(
      normalizeGitHubRepoInput({
        owner: "facebook",
        repo: "react",
        branch: "release/19.0",
      }),
    ).toEqual({
      owner: "facebook",
      repo: "react",
      branch: "release/19.0",
    });
  });

  it("rejects invalid owner repo and branch input", () => {
    expect(() => normalizeGitHubRepoInput({ owner: "face book", repo: "react" })).toThrow(/owner/i);
    expect(() => normalizeGitHubRepoInput({ owner: "facebook", repo: "../react" })).toThrow(/repository/i);
    expect(() => normalizeGitHubRepoInput({ owner: "facebook", repo: "react", branch: "../main" })).toThrow(/branch/i);
    expect(() => normalizeGitHubRepoInput({ owner: "facebook", repo: "react", branch: "-main" })).toThrow(/branch/i);
    expect(() => normalizeGitHubRepoInput({ owner: "facebook", repo: "react", branch: "main;rm" })).toThrow(/branch/i);
  });

  it("builds only github.com HTTPS clone URLs", () => {
    expect(buildPublicCloneUrl("facebook", "react")).toBe("https://github.com/facebook/react.git");
  });

  it("recognizes excluded generated and heavy directories", () => {
    expect(shouldExcludeDirectory(".git")).toBe(true);
    expect(shouldExcludeDirectory("node_modules")).toBe(true);
    expect(shouldExcludeDirectory("src")).toBe(false);
  });

  it("discovers files while excluding heavy folders and building language counts", async () => {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await mkdir(path.join(tempRoot, "node_modules", "left-pad"), { recursive: true });
    await mkdir(path.join(tempRoot, ".git"), { recursive: true });
    await writeFile(path.join(tempRoot, "src", "index.ts"), "const x = 1;\nexport { x };\n");
    await writeFile(path.join(tempRoot, "README.md"), "# Test\n");
    await writeFile(path.join(tempRoot, "node_modules", "left-pad", "index.js"), "module.exports = null;\n");
    await writeFile(path.join(tempRoot, ".git", "HEAD"), "ref: refs/heads/main\n");

    const discovered = await discoverRepoFiles(tempRoot);

    expect(discovered.files.map((file) => file.path).sort()).toEqual(["README.md", "src/index.ts"]);
    expect(discovered.languageBreakdown).toEqual({
      Markdown: 1,
      TypeScript: 1,
    });
    expect(discovered.totalFiles).toBe(2);
    expect(discovered.truncated).toBe(false);
  });

  it("caps discovered files at maxFiles", async () => {
    await writeFile(path.join(tempRoot, "a.ts"), "a\n");
    await writeFile(path.join(tempRoot, "b.ts"), "b\n");

    const discovered = await discoverRepoFiles(tempRoot, { maxFiles: 1 });

    expect(discovered.files).toHaveLength(1);
    expect(discovered.truncated).toBe(true);
  });

  it("maps language breakdown helpers", () => {
    expect(languageForExtension(".tsx")).toBe("TypeScript");
    expect(languageForExtension(".unknown")).toBe("Other");
    expect(buildLanguageBreakdown([{ language: "TypeScript" }, { language: "TypeScript" }, { language: "Markdown" }]))
      .toEqual({
        Markdown: 1,
        TypeScript: 2,
      });
  });

  it("cleans up temporary clones unless explicitly kept", async () => {
    const cloneDir = path.join(tempRoot, "clone");
    await mkdir(cloneDir);

    await cleanupRepoPath(cloneDir);

    await expect(discoverRepoFiles(cloneDir)).rejects.toThrow();
  });
});
