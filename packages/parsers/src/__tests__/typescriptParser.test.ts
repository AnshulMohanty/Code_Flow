import { describe, expect, it } from "vitest";
import { tsxParser, typescriptParser } from "../parsers/typescriptParser.js";

describe("typescriptParser", () => {
  it("extracts TypeScript imports, exports, functions, classes, interfaces, and types", () => {
    const parsed = typescriptParser.parseFile({
      path: "src/domain/user.ts",
      content: `
import type { UserId } from "./ids";
export interface User { id: UserId }
export type UserName = string;
export async function loadUser() { return null; }
export class UserService {}
`,
    });

    expect(parsed.language).toBe("typescript");
    expect(parsed.imports[0]).toEqual(expect.objectContaining({ source: "./ids", specifiers: ["UserId"] }));
    expect(parsed.exports.map((item) => item.name)).toEqual(
      expect.arrayContaining(["User", "UserName", "loadUser", "UserService"]),
    );
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "User", kind: "unknown", exported: true }),
        expect.objectContaining({ name: "UserName", kind: "unknown", exported: true }),
        expect.objectContaining({ name: "loadUser", kind: "function", exported: true }),
        expect.objectContaining({ name: "UserService", kind: "class", exported: true }),
      ]),
    );
  });

  it("detects TSX components and hooks", () => {
    const parsed = tsxParser.parseFile({
      path: "src/components/Profile.tsx",
      content: `
import React from "react";
export const ProfileCard = () => <section />;
const useProfile = () => ({});
`,
    });

    expect(parsed.language).toBe("tsx");
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ProfileCard", kind: "component", exported: true }),
        expect.objectContaining({ name: "useProfile", kind: "hook" }),
      ]),
    );
  });
});
