import { describe, expect, it } from "vitest";
import { createModuleResolver, parseJsonc, type ImportResolution } from "../stages/moduleResolver.js";

async function resolverFor(files: Record<string, string>) {
  return createModuleResolver({
    files: Object.keys(files).sort(),
    read: async (path) => (path in files ? files[path] : null),
  });
}

function targetOf(resolution: ImportResolution): string | undefined {
  return resolution.status === "resolved" ? resolution.targets[0]?.target : undefined;
}

const js = (source: string, specifiers: string[] = []) => ({ source, specifiers });

describe("module resolver — JS/TS", () => {
  it("maps an ESM `.js` specifier onto the `.ts` source (NodeNext)", async () => {
    const r = await resolverFor({ "src/a.ts": "", "src/b.ts": "", "src/c.tsx": "" });
    expect(targetOf(r.resolve("src/a.ts", js("./b.js"), "js"))).toBe("src/b.ts");
    expect(targetOf(r.resolve("src/a.ts", js("./c.js"), "js"))).toBe("src/c.tsx");
  });

  it("prefers a real `.js` file over the swap when both exist", async () => {
    const r = await resolverFor({ "a.ts": "", "b.js": "", "b.ts": "" });
    expect(targetOf(r.resolve("a.ts", js("./b.js"), "js"))).toBe("b.js");
  });

  it("resolves `../..` to the repo root via package.json main, with no leading slash", async () => {
    const r = await resolverFor({
      "package.json": JSON.stringify({ name: "express", main: "index.js" }),
      "index.js": "",
      "examples/auth/index.js": "",
    });
    expect(targetOf(r.resolve("examples/auth/index.js", js("../.."), "js"))).toBe("index.js");
    expect(targetOf(r.resolve("examples/auth/index.js", js("../../"), "js"))).toBe("index.js");
  });

  it("resolves the repo root to index.* when there is no package.json", async () => {
    const r = await resolverFor({ "index.ts": "", "lib/x.ts": "" });
    expect(targetOf(r.resolve("lib/x.ts", js(".."), "js"))).toBe("index.ts");
  });

  it("resolves tsconfig `paths` aliases, following `extends`", async () => {
    const r = await resolverFor({
      "tsconfig.base.json": `{
        // comments and trailing commas are legal in tsconfig
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~utils": ["src/utils/index.ts"], }, },
      }`,
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "src/components/Button.tsx": "",
      "src/utils/index.ts": "",
      "src/app.ts": "",
    });
    expect(targetOf(r.resolve("src/app.ts", js("@/components/Button"), "js"))).toBe("src/components/Button.tsx");
    expect(targetOf(r.resolve("src/app.ts", js("~utils"), "js"))).toBe("src/utils/index.ts");
    expect(r.resolve("src/app.ts", js("react"), "js").status).toBe("external");
  });

  it("follows solution-style `references` to find `paths` (Vite template)", async () => {
    const r = await resolverFor({
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/lib/utils.ts": "",
      "src/main.ts": "",
    });
    expect(targetOf(r.resolve("src/main.ts", js("@/lib/utils"), "js"))).toBe("src/lib/utils.ts");
  });

  it("resolves workspace packages through exports/main and maps dist back to src", async () => {
    const r = await resolverFor({
      "packages/graph/package.json": JSON.stringify({
        name: "@acme/graph",
        main: "dist/index.js",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./algo/*": "./dist/algo/*.js" },
      }),
      "packages/graph/src/index.ts": "",
      "packages/graph/src/algo/louvain.ts": "",
      "apps/api/src/app.ts": "",
    });
    expect(targetOf(r.resolve("apps/api/src/app.ts", js("@acme/graph"), "js"))).toBe("packages/graph/src/index.ts");
    expect(targetOf(r.resolve("apps/api/src/app.ts", js("@acme/graph/algo/louvain"), "js"))).toBe(
      "packages/graph/src/algo/louvain.ts",
    );
  });

  it("a workspace package whose entry cannot be found is unresolved, not external", async () => {
    const r = await resolverFor({
      "packages/x/package.json": JSON.stringify({ name: "x", main: "dist/nowhere.js" }),
      "apps/a.ts": "",
    });
    expect(r.resolve("apps/a.ts", js("x"), "js").status).toBe("unresolved");
  });

  it("does not loop on a package whose main points at its own directory", async () => {
    const r = await resolverFor({ "package.json": JSON.stringify({ name: "self", main: "./" }), "index.js": "", "a/b.js": "" });
    expect(targetOf(r.resolve("a/b.js", js("../"), "js"))).toBe("index.js");
  });

  it("falls back to a declaration file when no implementation exists (baseUrl `types`)", async () => {
    const r = await resolverFor({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "types/index.d.ts": "",
      "components/nav.tsx": "",
    });
    expect(targetOf(r.resolve("components/nav.tsx", js("types"), "js"))).toBe("types/index.d.ts");
  });

  it("prefers src over a COMMITTED dist when a package entry names the build", async () => {
    const r = await resolverFor({
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "dist/index.js", types: "dist/index.d.ts" }),
      "packages/ui/dist/index.js": "",
      "packages/ui/dist/index.d.ts": "",
      "packages/ui/src/index.ts": "",
      "app.ts": "",
    });
    expect(targetOf(r.resolve("app.ts", js("@acme/ui"), "js"))).toBe("packages/ui/src/index.ts");
  });

  it("strips Vite query suffixes and keeps bindings on the target", async () => {
    const r = await resolverFor({ "src/a.ts": "", "src/shader.glsl": "" });
    const resolution = r.resolve("src/a.ts", js("./shader.glsl?raw", ["shader"]), "js");
    expect(resolution).toEqual({ status: "resolved", targets: [{ target: "src/shader.glsl", bindings: ["shader"] }] });
  });
});

describe("module resolver — Python", () => {
  const files = {
    "src/requests/__init__.py": "",
    "src/requests/sessions.py": "",
    "src/requests/models.py": "",
    "src/requests/adapters/__init__.py": "",
    "src/requests/adapters/http.py": "",
    "tests/test_requests.py": "",
    "tests/helpers.py": "",
    "scripts/build.py": "",
  };

  it("`from . import sessions` targets the submodule, not __init__", async () => {
    const r = await resolverFor(files);
    const resolution = r.resolve(
      "src/requests/__init__.py",
      { source: ".", specifiers: ["sessions", "m"], names: ["sessions", "models"] },
      "python",
    );
    expect(resolution).toEqual({
      status: "resolved",
      targets: [
        { target: "src/requests/sessions.py", bindings: ["sessions"] },
        { target: "src/requests/models.py", bindings: ["m"] },
      ],
    });
  });

  it("a symbol import from a package binds to its __init__", async () => {
    const r = await resolverFor(files);
    const resolution = r.resolve(
      "src/requests/sessions.py",
      { source: ".adapters", specifiers: ["HTTPAdapter"], names: ["HTTPAdapter"] },
      "python",
    );
    expect(targetOf(resolution)).toBe("src/requests/adapters/__init__.py");
  });

  it("resolves absolute in-repo imports against the package root (src layout)", async () => {
    const r = await resolverFor(files);
    expect(targetOf(r.resolve("tests/test_requests.py", { source: "requests.models", specifiers: ["requests"] }, "python"))).toBe(
      "src/requests/models.py",
    );
    const fromImport = r.resolve(
      "tests/test_requests.py",
      { source: "requests.adapters", specifiers: ["http"], names: ["http"] },
      "python",
    );
    expect(targetOf(fromImport)).toBe("src/requests/adapters/http.py");
  });

  it("resolves a sibling import in a script directory (no __init__.py)", async () => {
    const r = await resolverFor(files);
    expect(targetOf(r.resolve("tests/test_requests.py", { source: "helpers", specifiers: ["helpers"] }, "python"))).toBe(
      "tests/helpers.py",
    );
  });

  it("stdlib and third-party imports stay external, even when a loose script shares the name", async () => {
    const r = await resolverFor(files);
    expect(r.resolve("src/requests/models.py", { source: "json", specifiers: ["json"] }, "python").status).toBe("external");
    // scripts/build.py is not a package module — `import build` elsewhere is the PyPI package.
    expect(r.resolve("src/requests/models.py", { source: "build", specifiers: ["build"] }, "python").status).toBe("external");
  });

  it("never produces a self-edge", async () => {
    const r = await resolverFor(files);
    const resolution = r.resolve(
      "src/requests/__init__.py",
      { source: ".", specifiers: ["__init__"], names: ["__init__"] },
      "python",
    );
    expect(resolution.status === "resolved" ? resolution.targets : []).toEqual([]);
  });
});

describe("parseJsonc", () => {
  it("keeps `//` inside strings and drops real comments + trailing commas", () => {
    expect(parseJsonc('{ "$schema": "https://x.dev/s.json", // c\n "a": [1, 2,], /* b */ }')).toEqual({
      $schema: "https://x.dev/s.json",
      a: [1, 2],
    });
  });
});
