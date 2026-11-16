import { describe, expect, it } from "vitest";
import { grammarsFor } from "../language.js";
import { hasGrammar, initTreeSitter, resetTreeSitterForTests, treeSitterStatus } from "../treesitter/runtime.js";

// Its own file: it resets the module-level grammar cache, which must not race other suites.
describe("tree-sitter runtime — lazy, per-language loading", () => {
  it("loads only the grammars asked for, and adds more on a later request", async () => {
    resetTreeSitterForTests();
    expect(treeSitterStatus()).toEqual({ ready: false, loaded: [], failed: [] });

    const first = await initTreeSitter({ languages: ["go"] });
    expect(first.loaded).toEqual(["go"]);
    expect(hasGrammar("python")).toBe(false);

    const second = await initTreeSitter({ languages: ["python", "go"] });
    expect(second.loaded).toEqual(["python", "go"]);
  });

  it("grammarsFor maps a file list to the grammars it needs, in a stable order", () => {
    expect(grammarsFor(["cmd/main.go", "README.md", "app/views.py", "web/App.tsx", "lib/a.go"])).toEqual(["tsx", "python", "go"]);
    expect(grammarsFor(["notes.md", "Makefile"])).toEqual([]);
  });
});
