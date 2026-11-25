import { describe, expect, it } from "vitest";
import type { AnalysisResultSlices } from "@codeflow/shared-types";
import { deriveEntryPoints } from "../pipeline/orchestrator.js";
import { declaresMain } from "../stages/inventory.js";

describe("result.entryPoints (derived from Inventory)", () => {
  it("projects inventory.entryPoints onto graph fileIds — deduped, sorted, kind → reason", () => {
    const slices = {
      inventory: {
        symbols: [],
        symbolCount: 0,
        loc: {},
        entryPoints: [
          { filePath: "apps/worker/src/index.ts", kind: "main", evidence: "package-json-main" },
          { filePath: "apps/api/src/index.ts", kind: "server", evidence: "filename-convention" },
          { filePath: "apps/api/src/index.ts", kind: "main", evidence: "package-json-main" },
          { filePath: "gone.ts", kind: "index", evidence: "filename-convention" },
        ],
      },
      graph: {
        nodes: ["apps/api/src/index.ts", "apps/worker/src/index.ts"].map((id) => ({
          id,
          path: id,
          name: "index.ts",
          layer: "source",
          language: "TypeScript",
          lines: 1,
          symbolCount: 0,
        })),
        edges: [],
        resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      },
    } as unknown as Partial<AnalysisResultSlices>;
    expect(deriveEntryPoints(slices)).toEqual([
      { fileId: "apps/api/src/index.ts", reason: "server" },
      { fileId: "apps/worker/src/index.ts", reason: "main" },
    ]);
  });

  it("is absent (not an empty claim) when Inventory did not run", () => {
    expect(deriveEntryPoints({})).toBeUndefined();
  });
});

describe("declaresMain — a program entry the CODE declares, in each language's own way", () => {
  it("recognises Go, Java, C#, C/C++, Rust and Python entry points", () => {
    expect(declaresMain(".go", "package main\n\nimport \"os\"\n\nfunc main() {\n\tos.Exit(run())\n}\n")).toBe(true);
    expect(declaresMain(".java", "public class App {\n  public static void main(String[] args) {}\n}\n")).toBe(true);
    expect(declaresMain(".java", "class App { static void main(final String... args) {} }")).toBe(true);
    expect(declaresMain(".cs", "class Program {\n  static async Task<int> Main(string[] args) => 0;\n}\n")).toBe(true);
    expect(declaresMain(".c", "#include <stdio.h>\nint main(int argc, char **argv) {\n  return 0;\n}\n")).toBe(true);
    expect(declaresMain(".rs", "fn main() {\n    println!(\"hi\");\n}\n")).toBe(true);
    expect(declaresMain(".py", "def run():\n    pass\n\nif __name__ == \"__main__\":\n    run()\n")).toBe(true);
  });

  it("does not mistake look-alikes for an entry point", () => {
    expect(declaresMain(".go", "package server\n\nfunc main() {}\n")).toBe(false); // not package main
    expect(declaresMain(".go", "package main\n\nfunc mainLoop() {}\n")).toBe(false);
    expect(declaresMain(".java", "class A { void main(String[] a) {} }")).toBe(false); // not static
    expect(declaresMain(".c", "static int domain(void) { return 0; }\n")).toBe(false);
    expect(declaresMain(".py", "x = '__main__'\n")).toBe(false);
    expect(declaresMain(".ts", "export function main() {}\n")).toBe(false); // JS/TS entries come from package.json and names
  });

  it("ignores a minified megabyte line rather than scanning it", () => {
    expect(declaresMain(".java", `${"x".repeat(5000)} static void main(String[] a)`)).toBe(false);
  });
});
