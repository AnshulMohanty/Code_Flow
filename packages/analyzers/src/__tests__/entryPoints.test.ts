import { describe, expect, it } from "vitest";
import type { AnalysisResultSlices } from "@codeflow/shared-types";
import { deriveEntryPoints } from "../pipeline/orchestrator.js";

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
