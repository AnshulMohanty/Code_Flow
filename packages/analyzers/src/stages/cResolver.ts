/**
 * C/C++ `#include` resolution, in the compiler's search order:
 *
 *   1. `"x.h"` only: the directory of the including file.
 *   2. The include path. A build's `-I` flags are not in the repository, so they are approximated by
 *      what projects actually pass: the including file's ancestor directories (`-I.`, `-Isrc`) and
 *      directories named `include` / `inc` / `includes` (`-Iinclude`).
 *   3. A path suffix: a unique file ending in `/<spec>`, or the nearest one to the includer — never
 *      for a bare `<name.h>`, which past the include path is a system header.
 *
 * Not found ⇒ external. A missing `"x.h"` is usually a header the BUILD generates (`config.h`), not
 * a broken one, so it is not reported as broken.
 *
 * Calls: C has one flat namespace for non-static functions, so a call to `parse()` reaches the file
 * that DEFINES `parse` — the nearest one when platform variants define it more than once.
 */
import type { ImportResolution, ImportSpecLike } from "./moduleResolver.js";

export const C_FAMILY_EXTENSIONS = new Set([
  ".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".inl", ".tcc",
]);

export interface CFileFacts {
  declarations?: ReadonlyArray<{ name: string }>;
}

export interface CResolver {
  resolve(fromFile: string, spec: ImportSpecLike & { system?: boolean }): ImportResolution;
  definitionOf(fromFile: string, name: string): string | undefined;
}

export function createCResolver(input: { files: readonly string[]; facts: ReadonlyMap<string, CFileFacts> }): CResolver {
  const fileSet = new Set(input.files);
  const byBasename = new Map<string, string[]>();
  for (const path of input.files) push(byBasename, basename(path), path);

  const includeRoots = [...new Set(input.files.map(dirname))]
    .filter((dir) => /(^|\/)(include|includes|inc)$/.test(dir))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  const definitions = new Map<string, string[]>();
  for (const path of input.files) {
    if (!C_FAMILY_EXTENSIONS.has(extname(path))) continue;
    for (const { name } of input.facts.get(path)?.declarations ?? []) push(definitions, name, path);
  }

  const nearest = (fromFile: string, candidates: string[]): string | undefined => {
    if (candidates.length <= 1) return candidates[0];
    return [...candidates].sort(
      (a, b) => commonPrefixLength(b, fromFile) - commonPrefixLength(a, fromFile) || a.length - b.length || a.localeCompare(b),
    )[0];
  };

  return {
    resolve(fromFile, spec) {
      const target = locate(fromFile, spec.source, spec.system === true);
      if (!target) return { status: "external" };
      return target === fromFile ? { status: "resolved", targets: [] } : { status: "resolved", targets: [{ target, bindings: [] }] };
    },
    definitionOf(fromFile, name) {
      const candidates = definitions.get(name)?.filter((path) => path !== fromFile);
      return candidates?.length ? nearest(fromFile, candidates) : undefined;
    },
  };

  function locate(fromFile: string, spec: string, system: boolean): string | undefined {
    const clean = spec.replace(/\\/g, "/");
    if (!system) {
      const sibling = joinWithin(dirname(fromFile), clean);
      if (sibling !== undefined && fileSet.has(sibling)) return sibling;
    }
    // Ancestors, nearest first, then the include directories.
    for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
      if (dir !== dirname(fromFile) || system) {
        const candidate = joinWithin(dir, clean);
        if (candidate !== undefined && fileSet.has(candidate)) return candidate;
      }
      if (dir === "") break;
    }
    for (const root of includeRoots) {
      const candidate = joinWithin(root, clean);
      if (candidate !== undefined && fileSet.has(candidate)) return candidate;
    }
    // The suffix step stands in for `-I` flags we cannot see, so it needs a path to match on. A bare
    // `<errno.h>` that is not on the approximated include path is a SYSTEM header — libuv ships
    // `include/uv/errno.h`, and matching it by suffix was wrong 40 times out of 40.
    if (clean.includes("..") || (system && !clean.includes("/"))) return undefined;
    const suffixed = (byBasename.get(basename(clean)) ?? []).filter((path) => path === clean || path.endsWith(`/${clean}`));
    return nearest(fromFile, suffixed);
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function joinWithin(dir: string, rel: string): string | undefined {
  const segments = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a[i] === b[i]) i += 1;
  return i;
}
