import type { AnalysisResult } from "@codeflow/shared-types";
import { describe, expect, it } from "vitest";
import { isNotable, type ImpactReport } from "../impact.js";
import { checkRules, globToRegex, parseRules } from "../rules.js";
import { filesRunByPackageJson, findUnreferenced } from "../unused.js";

function result(edges: Array<[string, string, string?]>, nodes: Array<[string, string, string?]> = []): AnalysisResult {
  const ids = new Set([...edges.flatMap(([from, to]) => [from, to]), ...nodes.map(([id]) => id)]);
  const extra = new Map(nodes.map(([id, layer, language]) => [id, { layer, language }]));
  return {
    graph: {
      nodes: [...ids].map((id) => ({
        id,
        path: id,
        name: id,
        layer: extra.get(id)?.layer ?? "source",
        language: extra.get(id)?.language ?? "TypeScript",
        lines: 10,
        symbolCount: 1,
      })),
      edges: edges.map(([from, to, specifier]) => ({ from, to, kind: "import", specifier: specifier ?? `./${to}` })),
      cpgEdges: [],
    },
  } as unknown as AnalysisResult;
}

describe("architecture rules", () => {
  it("globs: ** spans directories, * stays in one segment", () => {
    expect(globToRegex("apps/web/**").test("apps/web/src/a/b.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegex("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegex("a.b/*").test("aXb/c")).toBe(false); // the dot is literal
  });

  it("flags a forbidden edge however it was written, honours except, and can be limited to changed files", () => {
    const graph = result([
      ["apps/web/src/App.tsx", "apps/worker/src/jobs.ts", "@acme/worker"],
      ["apps/web/src/api.ts", "apps/worker/src/types.ts", "../../worker/src/types"],
      ["apps/web/src/ok.ts", "packages/ui/src/index.ts"],
    ]);
    const rules = [{ name: "web never imports the worker", from: "apps/web/**", forbid: "apps/worker/**", except: ["apps/worker/src/types.ts"] }];
    expect(checkRules(graph, rules)).toEqual([
      { rule: "web never imports the worker", from: "apps/web/src/App.tsx", to: "apps/worker/src/jobs.ts", specifier: "@acme/worker" },
    ]);
    expect(checkRules(graph, rules, new Set(["apps/web/src/ok.ts"]))).toEqual([]);
  });

  it("rejects a malformed rules file instead of silently checking nothing", () => {
    expect(parseRules("{").errors[0]).toMatch(/not valid JSON/);
    expect(parseRules("{}").errors).toEqual(['codeflow.rules.json needs a "rules" array']);
    expect(parseRules('{"rules":[{"name":"x","from":"a/**"}]}').errors[0]).toMatch(/"forbid"/);
    expect(parseRules('{"rules":[{"name":"x","from":"a/**","forbid":["b/**"]}]}')).toEqual({
      rules: [{ name: "x", from: "a/**", forbid: ["b/**"] }],
      errors: [],
    });
  });
});

describe("unreferenced files", () => {
  it("lists a judged source file nothing uses, never an entry point, a convention file or a test", () => {
    const graph = result(
      [["src/app.ts", "src/used.ts"]],
      [
        ["src/dead.ts", "source"],
        ["src/index.ts", "source"],
        ["src/vite.config.ts", "source"],
        ["src/dead.test.ts", "test"],
        ["public/config.js", "source", "JavaScript"],
        ["pkg/Unused.java", "source", "Java"],
        ["lib/util.c", "source", "C"],
        ["lib/unused.h", "source", "C"],
      ],
    );
    // `src/app.ts` imports something but nothing imports it — yet `app.*` is a conventional entry name,
    // so it is not listed; nor are index.*, configs, tests, public/ assets, Java, or C source files.
    expect(findUnreferenced(graph).files.map((file) => file.path)).toEqual(["lib/unused.h", "src/dead.ts"]);
  });

  it("a file a package.json runs is used — dist paths map back to src", () => {
    const files = new Set(["packages/eval/src/cli.ts", "packages/eval/src/checkCli.ts", "tools/x.ts"]);
    const used = filesRunByPackageJson(
      [{ path: "packages/eval/package.json", json: { scripts: { eval: "tsx src/cli.ts" }, bin: { check: "dist/checkCli.js" } } }],
      files,
    );
    expect([...used].sort()).toEqual(["packages/eval/src/checkCli.ts", "packages/eval/src/cli.ts"]);
  });
});

describe("quiet mode", () => {
  const base: ImpactReport = {
    changed: [{ path: "src/a.ts", status: "modified" }],
    files: [{ path: "src/a.ts", status: "modified", role: "source", directDependents: 1, transitiveDependents: 1, testsReaching: 0, entryPointsReaching: [] }],
    blastRadius: [],
    entryPointsAffected: [],
    testsReaching: [],
    untested: ["src/a.ts"],
    newCycles: [],
    cyclesTouched: [],
    brokenImports: [],
    ruleViolations: [],
    totalSourceFiles: 10,
  };

  it("stays silent for an untested change nothing much depends on", () => {
    expect(isNotable(base)).toBe(false);
  });

  it("speaks for a cycle, a broken import, a rule, or an untested change to a load-bearing file", () => {
    expect(isNotable({ ...base, newCycles: [["a", "b"]] })).toBe(true);
    expect(isNotable({ ...base, brokenImports: [{ from: "src/a.ts", specifier: "./gone" }] })).toBe(true);
    expect(isNotable({ ...base, ruleViolations: [{ rule: "r", from: "a", to: "b", specifier: "b" }] })).toBe(true);
    expect(isNotable({ ...base, files: [{ ...base.files[0], transitiveDependents: 5 }] })).toBe(true);
  });
});
