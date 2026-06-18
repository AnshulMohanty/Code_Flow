import { describe, expect, it } from "vitest";
import { isSupportedSourceFile, shouldExcludePath } from "../filesystem/fileFilters.js";

describe("fileFilters", () => {
  it("excludes generated, dependency, binary, and lockfile paths", () => {
    expect(shouldExcludePath(".git/config")).toBe(true);
    expect(shouldExcludePath("node_modules/pkg/index.js")).toBe(true);
    expect(shouldExcludePath("dist/app.js")).toBe(true);
    expect(shouldExcludePath("assets/logo.png")).toBe(true);
    expect(shouldExcludePath("pnpm-lock.yaml")).toBe(true);
  });

  it("accepts supported source files", () => {
    expect(isSupportedSourceFile("src/index.ts")).toBe(true);
    expect(isSupportedSourceFile("src/App.tsx")).toBe(true);
    expect(isSupportedSourceFile("pkg/service.py")).toBe(true);
    expect(isSupportedSourceFile("README.md")).toBe(true);
    expect(isSupportedSourceFile("node_modules/pkg/index.ts")).toBe(false);
  });
});
