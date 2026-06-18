import { describe, expect, it } from "vitest";
import { genericParser } from "../parsers/genericParser.js";

describe("genericParser", () => {
  it("counts LOC and reports TODO/FIXME warnings without inventing imports", () => {
    const parsed = genericParser.parseFile({
      path: "README.md",
      content: "# Project\n\nTODO: document parser\nFIXME: tighten wording\n",
    });

    expect(parsed.language).toBe("generic");
    expect(parsed.loc).toBe(3);
    expect(parsed.imports).toEqual([]);
    expect(parsed.dependencies).toEqual([]);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ line: 3, severity: "info" }),
      expect.objectContaining({ line: 4, severity: "info" }),
    ]);
  });
});
