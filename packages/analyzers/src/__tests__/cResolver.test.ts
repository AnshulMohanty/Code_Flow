import { describe, expect, it } from "vitest";
import { createCResolver } from "../stages/cResolver.js";
import type { ImportResolution } from "../stages/moduleResolver.js";

const FILES = [
  "include/uv.h",
  "include/uv/errno.h",
  "include/uv/unix.h",
  "src/uv-common.h",
  "src/unix/internal.h",
  "src/unix/core.c",
  "src/win/core.c",
  "third_party/json/single_include/nlohmann/json.hpp",
  "app/main.cc",
];

function resolver(definitions: Record<string, string[]> = {}) {
  const facts = new Map(Object.entries(definitions).map(([path, names]) => [path, { declarations: names.map((name) => ({ name })) }]));
  return createCResolver({ files: FILES, facts });
}
const to = (resolution: ImportResolution) => (resolution.status === "resolved" ? resolution.targets[0]?.target : resolution.status);
const quote = (source: string) => ({ source, specifiers: [] });
const angle = (source: string) => ({ source, specifiers: [], system: true });

describe("C/C++ include resolution — the compiler's search order", () => {
  it('"x.h" looks beside the including file first', () => {
    expect(to(resolver().resolve("src/unix/core.c", quote("internal.h")))).toBe("src/unix/internal.h");
  });

  it("then ancestors (-I. / -Isrc) and include directories (-Iinclude)", () => {
    expect(to(resolver().resolve("src/unix/core.c", quote("uv-common.h")))).toBe("src/uv-common.h");
    expect(to(resolver().resolve("src/unix/core.c", quote("uv.h")))).toBe("include/uv.h");
    expect(to(resolver().resolve("include/uv.h", angle("uv/unix.h")))).toBe("include/uv/unix.h");
  });

  it("a path is matched by suffix when no search path reaches it", () => {
    expect(to(resolver().resolve("app/main.cc", angle("nlohmann/json.hpp")))).toBe("third_party/json/single_include/nlohmann/json.hpp");
  });

  it("a bare <errno.h> is the SYSTEM header, never a repo file with that basename (libuv)", () => {
    expect(resolver().resolve("src/unix/core.c", angle("errno.h")).status).toBe("external");
  });

  it('a missing "config.h" is a header the build generates — external, not broken', () => {
    expect(resolver().resolve("src/unix/core.c", quote("config.h")).status).toBe("external");
  });

  it("a call reaches the file DEFINING the function — the nearest when platforms each define it", () => {
    const r = resolver({ "src/unix/core.c": ["uv_run"], "src/win/core.c": ["uv_run"], "src/uv-common.h": [] });
    expect(r.definitionOf("src/unix/internal.h", "uv_run")).toBe("src/unix/core.c");
    expect(r.definitionOf("src/unix/core.c", "uv_run")).toBe("src/win/core.c"); // its own definition is not a dependency
    expect(r.definitionOf("app/main.cc", "missing")).toBeUndefined();
  });
});
