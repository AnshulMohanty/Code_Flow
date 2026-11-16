import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntrypoint } from "./index.js";

describe("worker entrypoint guard", () => {
  it("starts from the Docker layout (/app/dist/index.js — no `worker/` segment)", () => {
    // The regression: a path-shape regex was false here, so the container exited 0 forever.
    expect(isEntrypoint(pathToFileURL("/app/dist/index.js").href, "/app/dist/index.js")).toBe(true);
  });

  it("starts from the monorepo layout and from a relative argv", () => {
    const file = path.resolve("apps/worker/dist/index.js");
    expect(isEntrypoint(pathToFileURL(file).href, file)).toBe(true);
    expect(isEntrypoint(pathToFileURL(path.resolve("dist/index.js")).href, "dist/index.js")).toBe(true);
  });

  it("does NOT start when the API imports the module for embedded mode", () => {
    expect(isEntrypoint(pathToFileURL("/app/node_modules/@codeflow/worker/dist/index.js").href, "/app/dist/index.js")).toBe(
      false,
    );
    expect(isEntrypoint(pathToFileURL("/app/dist/index.js").href, undefined)).toBe(false);
  });

  it("follows symlinks (npm/pnpm bin shims)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codeflow-entry-"));
    const real = path.join(dir, "index.js");
    const link = path.join(dir, "worker-bin.js");
    writeFileSync(real, "");
    symlinkSync(real, link);
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });
});
