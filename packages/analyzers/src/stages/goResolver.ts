/**
 * Go import resolution: import path → package directory → the FILES the importer depends on.
 *
 * A Go import names a package (a directory). Pointing the edge at the directory, or at every file
 * in it, would make "what breaks if this file changes" answer at package granularity. So the edge
 * goes to the files that DECLARE the names this file uses through the import (`store.Open` →
 * the file declaring `Open`). When nothing used can be matched, one representative file stands in
 * for the package, so the dependency itself is never dropped.
 *
 * Import path → directory, in order:
 *   1. Module roots: every `go.mod` `module` line, plus local `replace` targets (go.mod and
 *      go.work). Longest prefix wins. Inside a module root but no package there ⇒ unresolved
 *      (a broken import), never external.
 *   2. GOPATH-era repos (no go.mod above the file): the import prefix the repo was checked out
 *      under is INFERRED from the imports themselves — the prefix that most often turns an
 *      import path into a real package directory of this repo. A checked-in `src/<import path>`
 *      layout is matched directly.
 *   3. Anything else is external (standard library or a third-party module).
 *
 * `_test.go` files are never import targets. Directories the go tool skips for `./...`
 * (`testdata`, `_x`) still hold packages an EXPLICIT import reaches, so they are indexed too.
 */
import type { ImportResolution, ImportSpecLike } from "./moduleResolver.js";

export interface GoFileFacts {
  packageName?: string;
  declarations?: ReadonlyArray<{ name: string }>;
  imports?: ReadonlyArray<{ source: string }>;
}

/** A use of a name through a possible binding — `{ binding: "store", symbol: "store.Open" }`. */
export interface GoUse {
  binding: string;
  symbol: string;
}

export interface GoResolver {
  resolve(fromFile: string, spec: ImportSpecLike, uses: readonly GoUse[]): ImportResolution;
  /** The file in `fromFile`'s own package that declares `name` (Go needs no import for that). */
  samePackage(fromFile: string, name: string): string | undefined;
}

export interface GoResolverInput {
  files: readonly string[];
  read(path: string): Promise<string | null>;
  facts: ReadonlyMap<string, GoFileFacts>;
}

interface GoPackage {
  dir: string;
  /** Non-test files, sorted — the only importable ones. */
  sources: string[];
  name?: string;
  /** Top-level name → declaring (non-test) file. */
  declarations: Map<string, string>;
  /** Files with an `init` function — what a blank (`_`) import actually depends on. */
  initFiles: string[];
}

interface ImportRoot {
  prefix: string;
  dir: string;
}

export async function createGoResolver(input: GoResolverInput): Promise<GoResolver> {
  const goFiles = input.files.filter((path) => path.endsWith(".go")).sort();

  // ── Packages ──────────────────────────────────────────────────────────────────────
  const packages = new Map<string, GoPackage>();
  /** `${dir}\0${packageName}` → name → file, over EVERY file (tests included) — same-package lookups. */
  const packageScopes = new Map<string, Map<string, string>>();
  const nameVotes = new Map<string, Map<string, number>>();

  for (const path of goFiles) {
    const dir = dirname(path);
    const facts = input.facts.get(path);
    const isTest = path.endsWith("_test.go");
    if (!isTest) {
      let pkg = packages.get(dir);
      if (!pkg) {
        pkg = { dir, sources: [], declarations: new Map(), initFiles: [] };
        packages.set(dir, pkg);
      }
      pkg.sources.push(path);
      if (facts?.packageName) {
        const votes = nameVotes.get(dir) ?? new Map<string, number>();
        votes.set(facts.packageName, (votes.get(facts.packageName) ?? 0) + 1);
        nameVotes.set(dir, votes);
      }
      for (const decl of facts?.declarations ?? []) {
        if (decl.name === "init") {
          if (!pkg.initFiles.includes(path)) pkg.initFiles.push(path);
        } else if (decl.name !== "_" && !pkg.declarations.has(decl.name)) {
          pkg.declarations.set(decl.name, path);
        }
      }
    }
    if (facts?.packageName) {
      const key = `${dir}\u0000${facts.packageName}`;
      const scope = packageScopes.get(key) ?? new Map<string, string>();
      for (const decl of facts.declarations ?? []) {
        if (decl.name !== "init" && decl.name !== "_" && !scope.has(decl.name)) scope.set(decl.name, path);
      }
      packageScopes.set(key, scope);
    }
  }
  for (const [dir, votes] of nameVotes) {
    // The package clause most files agree on (a stray `//go:build ignore` generator can differ).
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    packages.get(dir)!.name = ranked[0][0];
  }

  // ── Module roots: go.mod `module` + local `replace`, go.work `replace` ────────────
  const roots: ImportRoot[] = [];
  const moduleDirs: string[] = [];
  const manifests = input.files.filter((path) => basename(path) === "go.mod" || basename(path) === "go.work").sort();
  const texts = await Promise.all(manifests.map((path) => input.read(path)));
  manifests.forEach((path, index) => {
    const text = texts[index];
    if (text === null) return;
    const dir = dirname(path);
    const parsed = parseGoManifest(text);
    if (basename(path) === "go.mod") {
      moduleDirs.push(dir);
      if (parsed.module) roots.push({ prefix: parsed.module, dir });
    }
    for (const replace of parsed.replaces) {
      const target = joinWithin(dir, replace.path);
      if (target !== undefined) roots.push({ prefix: replace.module, dir: target });
    }
  });

  // ── GOPATH-era repos: infer the checkout prefix from the imports ──────────────────
  const underModule = (path: string) => moduleDirs.some((dir) => dir === "" || path.startsWith(`${dir}/`));
  const legacyFiles = goFiles.filter((path) => !underModule(path));
  if (legacyFiles.length > 0) {
    const votes = new Map<string, number>();
    for (const path of legacyFiles) {
      for (const entry of input.facts.get(path)?.imports ?? []) {
        const segments = entry.source.split("/");
        for (let k = 1; k < segments.length; k += 1) {
          if (!packages.has(segments.slice(k).join("/"))) continue;
          const prefix = segments.slice(0, k).join("/");
          votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
        }
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]));
    // A checkout has ONE import prefix. Only the clear winner is taken: a runner-up is a
    // coincidence (`…/etcdserver/auth` meeting the top-level `auth/`), and as a longer prefix it
    // would shadow the real one. One vote can itself be a coincidence, so it takes two.
    const [top] = ranked;
    if (top && top[1] >= 2) roots.push({ prefix: top[0], dir: "" });
  }

  // Longest prefix first; ties keep manifest order (deterministic: manifests are sorted).
  roots.sort((a, b) => b.prefix.length - a.prefix.length);

  /**
   * Longest matching root that HAS the package wins; when none has it, the import is still
   * in-repo by declaration (a broken import), reported against the longest root. That is how
   * the go tool picks between nested modules sharing a prefix.
   */
  const directoryFor = (importPath: string): { dir: string } | undefined => {
    let declared: string | undefined;
    for (const root of roots) {
      if (importPath !== root.prefix && !importPath.startsWith(`${root.prefix}/`)) continue;
      const rest = importPath.slice(root.prefix.length + 1);
      const dir = rest ? joinPath(root.dir, rest) : root.dir;
      if (packages.has(dir)) return { dir };
      declared ??= dir;
    }
    if (packages.has(`src/${importPath}`)) return { dir: `src/${importPath}` };
    return declared === undefined ? undefined : { dir: declared };
  };

  const representative = (pkg: GoPackage): string => {
    for (const name of [pkg.name && `${pkg.name}.go`, "doc.go", `${basename(pkg.dir)}.go`]) {
      if (!name) continue;
      const candidate = joinPath(pkg.dir, name);
      if (pkg.sources.includes(candidate)) return candidate;
    }
    return pkg.sources[0];
  };

  return {
    resolve(fromFile, spec, uses) {
      const located = directoryFor(spec.source);
      if (!located) return { status: "external" };
      const pkg = packages.get(located.dir);
      if (!pkg || pkg.sources.length === 0) return { status: "unresolved" };

      const explicit = spec.specifiers[0];
      const binding = explicit && explicit !== "." && explicit !== "_" ? explicit : (pkg.name ?? defaultPackageName(spec.source));
      const targets = new Map<string, { bindings: Set<string>; symbols: Set<string> }>();
      const add = (target: string, bindingName: string | undefined, symbol?: string) => {
        const entry = targets.get(target) ?? { bindings: new Set<string>(), symbols: new Set<string>() };
        if (bindingName) entry.bindings.add(bindingName);
        if (symbol) entry.symbols.add(symbol);
        targets.set(target, entry);
      };

      if (explicit === "_") {
        for (const file of pkg.initFiles.length ? pkg.initFiles : [representative(pkg)]) add(file, undefined);
      } else if (explicit === ".") {
        for (const use of uses) {
          if (use.symbol.includes(".")) continue;
          const file = pkg.declarations.get(use.symbol);
          if (file) add(file, undefined, use.symbol);
        }
      } else {
        const prefix = `${binding}.`;
        for (const use of uses) {
          if (use.binding !== binding || !use.symbol.startsWith(prefix)) continue;
          const name = use.symbol.slice(prefix.length).split(".")[0];
          const file = pkg.declarations.get(name);
          if (file) add(file, binding, `${binding}.${name}`);
        }
      }
      if (targets.size === 0) add(representative(pkg), explicit === "." || explicit === "_" ? undefined : binding);
      targets.delete(fromFile);

      return {
        status: "resolved",
        targets: [...targets.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([target, entry]) => ({
            target,
            bindings: [...entry.bindings],
            ...(entry.symbols.size ? { symbols: [...entry.symbols].sort() } : {}),
          })),
      };
    },

    samePackage(fromFile, name) {
      const packageName = input.facts.get(fromFile)?.packageName;
      if (!packageName) return undefined;
      const dir = dirname(fromFile);
      // A non-test file cannot see declarations that live in _test.go files.
      const scope = fromFile.endsWith("_test.go")
        ? packageScopes.get(`${dir}\u0000${packageName}`)
        : packages.get(dir)?.name === packageName
          ? packages.get(dir)!.declarations
          : undefined;
      const file = scope?.get(name);
      return file && file !== fromFile ? file : undefined;
    },
  };
}

// ── go.mod / go.work ─────────────────────────────────────────────────────────────────

export interface GoManifest {
  module?: string;
  /** Local replacements only (`=> ./x`, `=> ../x`); a replacement by another module path is external. */
  replaces: Array<{ module: string; path: string }>;
}

export function parseGoManifest(text: string): GoManifest {
  const manifest: GoManifest = { replaces: [] };
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (block) {
      if (line === ")") {
        block = null;
        continue;
      }
      if (block === "replace") addReplace(line, manifest);
      continue;
    }
    const opener = /^(\w+)\s*\($/.exec(line);
    if (opener) {
      block = opener[1];
      continue;
    }
    const moduleLine = /^module\s+"?([^"\s]+)"?/.exec(line);
    if (moduleLine) {
      manifest.module = moduleLine[1];
      continue;
    }
    if (line.startsWith("replace ")) addReplace(line.slice("replace ".length), manifest);
  }
  return manifest;
}

function addReplace(spec: string, manifest: GoManifest): void {
  const match = /^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/.exec(spec.trim());
  if (!match) return;
  const [, module, target] = match;
  if (target.startsWith("./") || target.startsWith("../") || target === "." || target === "..") {
    manifest.replaces.push({ module, path: target });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

/** The name an unaliased import binds when the target package is unknown: last segment, minus a `/vN` suffix and `go-` prefix. */
function defaultPackageName(importPath: string): string {
  const segments = importPath.split("/");
  let last = segments[segments.length - 1];
  if (/^v\d+$/.test(last) && segments.length > 1) last = segments[segments.length - 2];
  return last.replace(/^go-/, "").replace(/[.-].*$/, "");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function joinPath(dir: string, rel: string): string {
  return joinWithin(dir, rel) ?? rel;
}

/** Join, resolving `.`/`..`. Undefined when the result would leave the repository. */
function joinWithin(dir: string, rel: string): string | undefined {
  const segments = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}
