import { describe, expect, it } from "vitest";
import { contentHash, createMemoryFactsStore, factsStoreStats, setFactsStore } from "../factsStore.js";
import { createParserRegistry } from "../registry.js";
import { extractCpgFacts } from "../treesitter/cpg.js";
import { initTreeSitter } from "../treesitter/runtime.js";

await initTreeSitter({ languages: ["go"] });

describe("facts store — incremental analysis", () => {
  it("parses a file once; an unchanged file is served from the store, a changed one is parsed again", () => {
    const store = createMemoryFactsStore();
    setFactsStore(store);
    try {
      const registry = createParserRegistry();
      const input = { path: "pkg/a.go", content: "package a\n\nfunc A() {}\n" };
      const first = registry.parseFile(input);
      const facts = extractCpgFacts(input);
      expect(factsStoreStats()).toEqual({ hits: 0, misses: 2 });

      expect(registry.parseFile(input)).toEqual(first);
      expect(extractCpgFacts(input)).toEqual(facts);
      expect(factsStoreStats()).toEqual({ hits: 2, misses: 2 });

      registry.parseFile({ ...input, content: `${input.content}func B() {}\n` });
      expect(factsStoreStats()).toEqual({ hits: 2, misses: 3 });
    } finally {
      setFactsStore(null);
    }
  });

  it("the content hash separates near-identical contents of the same length", () => {
    expect(contentHash("func A() {}")).not.toBe(contentHash("func B() {}"));
    expect(contentHash("ab")).not.toBe(contentHash("ba"));
    expect(contentHash("same")).toBe(contentHash("same"));
  });
});
