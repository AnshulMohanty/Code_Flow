import { describe, expect, it } from "vitest";
import type { FileRole, PipelineContext, PipelineInput, RepoOrientation } from "@codeflow/shared-types";
import { createMapStructureStage, type WalkEntry } from "../stages/mapStructure.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

function ctx(orientation?: RepoOrientation): PipelineContext {
  return {
    repoPath: "/repo",
    commitSha: "sha",
    prior: orientation ? { orientation } : {},
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

/** Build a fake tree (paths → sizeBytes) and derive readDir/readFile from it. */
function makeTree(filePaths: Record<string, number>, gitignore?: string) {
  const files = Object.keys(filePaths);
  const readDir = async (_repoPath: string, dir: string): Promise<WalkEntry[]> => {
    const prefix = dir ? `${dir}/` : "";
    const children = new Map<string, { type: "file" | "dir"; sizeBytes: number }>();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        children.set(rest, { type: "file", sizeBytes: filePaths[file] });
      } else if (!children.has(rest.slice(0, slash))) {
        children.set(rest.slice(0, slash), { type: "dir", sizeBytes: 0 });
      }
    }
    return [...children.entries()].map(([name, meta]) => ({ name, path: prefix + name, ...meta }));
  };
  const readFile = async (_repoPath: string, relativePath: string) =>
    relativePath === ".gitignore" ? gitignore ?? null : null;
  return { readDir, readFile };
}

async function mapStructure(
  filePaths: Record<string, number>,
  opts: { gitignore?: string; orientation?: RepoOrientation } = {},
) {
  const tree = makeTree(filePaths, opts.gitignore);
  const stage = createMapStructureStage({ readDir: tree.readDir, readFile: tree.readFile, now: () => 1000 });
  const { partial } = await stage.run(input, ctx(opts.orientation));
  return partial.structure!;
}

function rolesByPath(structure: { files: { path: string; role: FileRole }[] }): Record<string, FileRole> {
  return Object.fromEntries(structure.files.map((f) => [f.path, f.role]));
}

describe("map-structure — role classification", () => {
  it("classifies source / test / config / docs / build / asset / other", async () => {
    const structure = await mapStructure({
      "src/index.ts": 100,
      "src/util.test.ts": 50,
      "src/__tests__/helper.ts": 40,
      "package.json": 20,
      "tsconfig.json": 10,
      "vite.config.ts": 15,
      ".eslintrc": 5,
      "Dockerfile": 30,
      ".github/workflows/ci.yml": 25,
      "build.gradle": 12,
      "README.md": 60,
      "docs/guide.md": 70,
      "assets/logo.png": 800,
      "notes.txt": 8,
      "go.mod": 18,
    });

    const roles = rolesByPath(structure);
    expect(roles["src/index.ts"]).toBe("source");
    expect(roles["src/util.test.ts"]).toBe("test");
    expect(roles["src/__tests__/helper.ts"]).toBe("test");
    expect(roles["package.json"]).toBe("config");
    expect(roles["tsconfig.json"]).toBe("config");
    expect(roles["vite.config.ts"]).toBe("config");
    expect(roles[".eslintrc"]).toBe("config");
    expect(roles["Dockerfile"]).toBe("build");
    expect(roles[".github/workflows/ci.yml"]).toBe("build");
    expect(roles["build.gradle"]).toBe("build");
    expect(roles["README.md"]).toBe("docs");
    expect(roles["docs/guide.md"]).toBe("docs");
    expect(roles["assets/logo.png"]).toBe("asset");
    expect(roles["notes.txt"]).toBe("other");
    expect(roles["go.mod"]).toBe("config");
  });

  it("records ext, language-by-extension and sizeBytes per file", async () => {
    const structure = await mapStructure({ "src/app.ts": 123, "logo.svg": 456 });
    const ts = structure.files.find((f) => f.path === "src/app.ts")!;
    expect(ts).toMatchObject({ ext: ".ts", language: "TypeScript", sizeBytes: 123, role: "source" });
    const svg = structure.files.find((f) => f.path === "logo.svg")!;
    expect(svg).toMatchObject({ ext: ".svg", language: "Unknown", sizeBytes: 456, role: "asset" });
  });
});

describe("map-structure — ignores", () => {
  it("excludes the hard ignore set (node_modules/.git/dist/build/vendor/.venv)", async () => {
    const structure = await mapStructure({
      "src/index.ts": 1,
      "node_modules/dep/index.js": 1,
      ".git/config": 1,
      "dist/bundle.js": 1,
      "build/out.js": 1,
      "vendor/lib.rb": 1,
      ".venv/lib/python/site.py": 1,
    });
    expect(structure.files.map((f) => f.path)).toEqual(["src/index.ts"]);
  });

  it("respects .gitignore patterns (glob, dir, negation)", async () => {
    const structure = await mapStructure(
      {
        "src/index.ts": 1,
        "debug.log": 1,
        "logs/app.log": 1,
        "keep.log": 1,
        "secret.txt": 1,
        "tmp/cache.bin": 1,
      },
      { gitignore: "*.log\n!keep.log\nsecret.txt\ntmp/\n" },
    );
    const paths = structure.files.map((f) => f.path).sort();
    expect(paths).toEqual(["keep.log", "src/index.ts"]); // *.log ignored except keep.log; secret.txt + tmp/ gone
  });
});

describe("map-structure — layout detection", () => {
  it("monorepo: top-level packages/ tree", async () => {
    const s = await mapStructure({ "packages/a/index.ts": 1, "packages/b/index.ts": 1, "package.json": 1 });
    expect(s.layout).toBe("monorepo");
  });

  it("src-rooted: top-level src/, no packages", async () => {
    const s = await mapStructure({ "src/index.ts": 1, "package.json": 1 });
    expect(s.layout).toBe("src-rooted");
  });

  it("app-rooted: top-level app/, no src/packages", async () => {
    const s = await mapStructure({ "app/page.tsx": 1, "package.json": 1 });
    expect(s.layout).toBe("app-rooted");
  });

  it("flat: nothing special at the root", async () => {
    const s = await mapStructure({ "index.ts": 1, "package.json": 1 });
    expect(s.layout).toBe("flat");
  });

  it("layout=monorepo does not overwrite a disagreeing orientation.projectType", async () => {
    const orientation: RepoOrientation = {
      languages: ["JavaScript"],
      frameworks: [],
      projectType: "application",
      manifests: [],
      readme: null,
    };
    const s = await mapStructure({ "packages/a/index.ts": 1 }, { orientation });
    expect(s.layout).toBe("monorepo"); // owned fact wins here; orientation left as-is upstream
  });
});

describe("map-structure — completeness", () => {
  it("returns the FULL file list uncapped", async () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) many[`src/file${i}.ts`] = i;
    const s = await mapStructure(many);
    expect(s.fileCount).toBe(1000);
    expect(s.files).toHaveLength(1000);
  });

  it("empty repo → empty-but-valid structure, no throw", async () => {
    const s = await mapStructure({});
    expect(s.files).toEqual([]);
    expect(s.fileCount).toBe(0);
    expect(s.layout).toBe("flat");
  });

  it("throws if repoPath is missing (Ingest must run first)", async () => {
    const tree = makeTree({});
    const stage = createMapStructureStage({ readDir: tree.readDir, readFile: tree.readFile, now: () => 1 });
    const noRepo: PipelineContext = { ...ctx(), repoPath: undefined };
    await expect(stage.run(input, noRepo)).rejects.toThrow(/repoPath/);
  });
});
