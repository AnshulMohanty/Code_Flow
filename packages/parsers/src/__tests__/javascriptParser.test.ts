import { describe, expect, it } from "vitest";
import { javascriptParser } from "../parsers/javascriptParser.js";

describe("javascriptParser", () => {
  it("extracts imports, exports, functions, classes, components, and hooks", () => {
    const parsed = javascriptParser.parseFile({
      path: "src/App.jsx",
      repoRoot: "D:/repo",
      content: `
import React, { useMemo as memo } from "react";
import * as utils from "./utils";
import "./styles.css";
const helper = require("../helper");
const lazy = import("./lazy");
export function useThing() { return memo(() => 1, []); }
export class Widget {}
function plain() {}
const Dashboard = () => null;
export { Dashboard };
`,
    });

    expect(parsed.language).toBe("javascript");
    expect(parsed.imports.map((item) => item.source)).toEqual([
      "react",
      "./utils",
      "./styles.css",
      "../helper",
      "./lazy",
    ]);
    expect(parsed.imports.find((item) => item.source === "react")?.specifiers).toEqual(["React", "memo"]);
    expect(parsed.imports.find((item) => item.source === "../helper")?.importKind).toBe("commonjs");
    expect(parsed.imports.find((item) => item.source === "./lazy")?.importKind).toBe("dynamic");
    expect(parsed.exports.map((item) => item.name)).toEqual(expect.arrayContaining(["useThing", "Widget", "Dashboard"]));
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "useThing", kind: "hook", exported: true }),
        expect.objectContaining({ name: "Widget", kind: "class", exported: true }),
        expect.objectContaining({ name: "plain", kind: "function" }),
        expect.objectContaining({ name: "Dashboard", kind: "component" }),
      ]),
    );
    expect(parsed.dependencies).toHaveLength(5);
  });
});
