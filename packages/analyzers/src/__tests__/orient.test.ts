import { describe, expect, it } from "vitest";
import type { PipelineContext, PipelineInput } from "@codeflow/shared-types";
import { createOrientStage } from "../stages/orient.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

/** ctx with repoPath populated (as Ingest would leave it). */
function ctx(repoPath = "/repo"): PipelineContext {
  return {
    repoPath,
    commitSha: "sha",
    prior: {},
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

/** Fake reader over an in-memory { path: content } map. */
function readerFor(files: Record<string, string>) {
  return async (_repoPath: string, relativePath: string) =>
    relativePath in files ? files[relativePath] : null;
}

async function orient(files: Record<string, string>) {
  const stage = createOrientStage({ readFile: readerFor(files), now: () => 1000 });
  const { partial } = await stage.run(input, ctx());
  return partial.orientation!;
}

describe("orient stage — manifest + README detection", () => {
  it("JS monorepo: workspaces → monorepo, TS dep → TypeScript, React framework, README captured", async () => {
    const o = await orient({
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
        dependencies: { react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
      "README.md": "# Acme\nA monorepo.",
    });

    expect(o.languages).toEqual(expect.arrayContaining(["JavaScript", "TypeScript"]));
    expect(o.frameworks).toContain("React");
    expect(o.projectType).toBe("monorepo");
    expect(o.manifests).toEqual([{ path: "package.json", ecosystem: "npm" }]);
    expect(o.readme).toEqual({ path: "README.md", text: "# Acme\nA monorepo." });
  });

  it("Python library: setup.py find_packages → library, Flask framework", async () => {
    const o = await orient({
      "setup.py": "from setuptools import setup, find_packages\nsetup(name='lib', packages=find_packages())",
      "requirements.txt": "flask==3.0.0\nrequests>=2",
    });

    expect(o.languages).toEqual(["Python"]);
    expect(o.frameworks).toContain("Flask");
    expect(o.projectType).toBe("library");
    expect(o.manifests.map((m) => m.path)).toEqual(expect.arrayContaining(["setup.py", "requirements.txt"]));
    expect(o.readme).toBeNull(); // no README present
  });

  it("Go CLI: cobra dependency in go.mod → cli, Cobra framework", async () => {
    const o = await orient({
      "go.mod": "module example.com/tool\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n",
      "README": "Tool CLI",
    });

    expect(o.languages).toEqual(["Go"]);
    expect(o.frameworks).toContain("Cobra");
    expect(o.projectType).toBe("cli");
    expect(o.manifests).toEqual([{ path: "go.mod", ecosystem: "go" }]);
    expect(o.readme).toEqual({ path: "README", text: "Tool CLI" });
  });

  it("npm library: public package with exports and no bin/workspaces → library", async () => {
    const o = await orient({
      "package.json": JSON.stringify({ name: "lib", exports: "./index.js", dependencies: {} }),
    });
    expect(o.projectType).toBe("library");
  });

  it("empty repo: no manifest, no README → empty-but-valid orientation, no throw", async () => {
    const o = await orient({});

    expect(o.languages).toEqual([]);
    expect(o.frameworks).toEqual([]);
    expect(o.manifests).toEqual([]);
    expect(o.projectType).toBe("unknown");
    expect(o.readme).toBeNull();
  });

  it("captures the FULL raw README text as a fact (no truncation)", async () => {
    const big = "# Title\n" + "x".repeat(50_000);
    const o = await orient({ "package.json": "{}", "README.md": big });
    expect(o.readme?.text).toBe(big);
    expect(o.readme?.text.length).toBe(big.length);
  });

  it("malformed package.json is still counted as a manifest without throwing", async () => {
    const o = await orient({ "package.json": "{ not json" });
    expect(o.manifests).toEqual([{ path: "package.json", ecosystem: "npm" }]);
    expect(o.languages).toEqual(["JavaScript"]);
    expect(o.projectType).toBe("application"); // present, no monorepo/cli/library signal
  });

  it("throws if repoPath is missing (Ingest must run first)", async () => {
    const stage = createOrientStage({ readFile: readerFor({}), now: () => 1 });
    const noRepo: PipelineContext = { ...ctx(), repoPath: undefined };
    await expect(stage.run(input, noRepo)).rejects.toThrow(/repoPath/);
  });
});
