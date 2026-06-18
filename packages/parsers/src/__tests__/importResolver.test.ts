import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePythonImport, resolveRelativeImport } from "../resolution/importResolver.js";

describe("importResolver", () => {
  it("resolves JavaScript relative imports with extension and index fallbacks", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codeflow-parser-"));
    await mkdir(path.join(repoRoot, "src", "lib"), { recursive: true });
    await mkdir(path.join(repoRoot, "src", "feature"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "lib", "util.ts"), "export const util = 1;");
    await writeFile(path.join(repoRoot, "src", "feature", "index.tsx"), "export const Feature = () => null;");

    expect(resolveRelativeImport({ fromFile: "src/app.ts", source: "./lib/util", repoRoot })).toBe("src/lib/util.ts");
    expect(resolveRelativeImport({ fromFile: "src/app.ts", source: "./feature", repoRoot })).toBe(
      "src/feature/index.tsx",
    );
    expect(resolveRelativeImport({ fromFile: "src/app.ts", source: "react", repoRoot })).toBeUndefined();
  });

  it("resolves basic Python relative imports", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codeflow-parser-py-"));
    await mkdir(path.join(repoRoot, "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "pkg", "models.py"), "class User: pass");

    expect(resolvePythonImport({ fromFile: "pkg/service.py", source: ".models", repoRoot })).toBe("pkg/models.py");
  });
});
