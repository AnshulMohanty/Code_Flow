import { describe, expect, it } from "vitest";
import { createParserRegistry } from "../registry.js";

describe("ParserRegistry", () => {
  it("picks the parser by extension and falls back to generic", () => {
    const registry = createParserRegistry();

    expect(registry.getParserForPath("src/index.js").language).toBe("javascript");
    expect(registry.getParserForPath("src/App.jsx").language).toBe("jsx");
    expect(registry.getParserForPath("src/index.ts").language).toBe("typescript");
    expect(registry.getParserForPath("src/App.tsx").language).toBe("tsx");
    expect(registry.getParserForPath("pkg/service.py").language).toBe("python");
    expect(registry.getParserForPath("README.md").language).toBe("generic");
  });
});
