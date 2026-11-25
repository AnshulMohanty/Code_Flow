import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPublicCloneUrl, cleanupRepoPath, normalizeGitHubRepoInput } from "./publicRepoCloneService.js";

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

  it("cleans up temporary clones unless explicitly kept", async () => {
    const cloneDir = path.join(tempRoot, "clone");
    await mkdir(cloneDir);

    await cleanupRepoPath(cloneDir);

    await expect(stat(cloneDir)).rejects.toThrow();
  });
});
