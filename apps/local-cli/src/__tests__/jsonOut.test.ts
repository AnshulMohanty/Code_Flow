import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile } from "../jsonOut.js";

describe("writeJsonFile — streamed, byte-identical to JSON.stringify(value, null, 2)", () => {
  it("matches on every JSON edge case", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codeflow-json-"));
    const value = {
      text: 'quote " backslash \\ newline \n unicode é 漢 \u0000',
      numbers: [0, -1, 1.5, 1e21, Number.NaN, Number.POSITIVE_INFINITY],
      flags: [true, false, null],
      omitted: undefined,
      fn: () => 1,
      sparse: [undefined, () => 1, { a: undefined }],
      empty: { array: [], object: {} },
      nested: { deep: [[{ x: [1, [2, [3]]] }]] },
      date: new Date(Date.UTC(2026, 10, 16)),
      big: Array.from({ length: 30_000 }, (_, i) => ({ from: `f${i}`, to: `t${i}`, kind: "import" })),
    };
    const file = path.join(dir, "out.json");
    writeJsonFile(file, value);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
  });
});
