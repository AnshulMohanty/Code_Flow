import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRepoFile } from "./repoFileReader.js";

let base: string;
let repo: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "codeflow-reader-"));
  repo = path.join(base, "repo");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(base, "secret.env"), "GEMINI_API_KEY=leaked\n");
  await writeFile(path.join(repo, "docs", "guide.md"), "# Guide\n");
  // An untrusted clone pointing outside itself, and one link that stays inside.
  await symlink(path.join(base, "secret.env"), path.join(repo, "README.md"));
  await symlink("../secret.env", path.join(repo, "docs", "env.md"));
  await symlink("docs/guide.md", path.join(repo, "GUIDE.md"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("readRepoFile — the clone is untrusted", () => {
  it("refuses a symlink that resolves outside the clone (README -> a secret)", async () => {
    expect(await readRepoFile(repo, "README.md")).toBeNull();
    expect(await readRepoFile(repo, "docs/env.md")).toBeNull();
    expect(await readRepoFile(repo, "../secret.env")).toBeNull();
  });

  it("still reads real files and symlinks that stay inside the repository", async () => {
    expect(await readRepoFile(repo, "docs/guide.md")).toBe("# Guide\n");
    expect(await readRepoFile(repo, "GUIDE.md")).toBe("# Guide\n");
  });

  it("returns null for a missing file or a directory", async () => {
    expect(await readRepoFile(repo, "nope.md")).toBeNull();
    expect(await readRepoFile(repo, "docs")).toBeNull();
  });
});
