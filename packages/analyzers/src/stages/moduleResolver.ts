/**
 * Module resolution for the Connect stage — import specifier → repo fileId.
 *
 * Everything is matched against the DISCOVERED file set (no fs probing, deterministic). The
 * only files read are the manifests that define resolution: every `package.json` and every
 * `tsconfig*.json` / `jsconfig.json`.
 *
 * JS / TS, in order:
 *   1. relative (`./x`, `../..`)       — extension probing, `.js`→`.ts` (NodeNext/ESM TS), directory
 *                                        `package.json` entry, then `index.*`
 *   2. tsconfig/jsconfig `paths`       — nearest config up the tree, `extends` + `references` followed
 *   3. tsconfig `baseUrl`              — only accepted when it lands on a real file
 *   4. workspace packages              — a bare specifier naming a package.json `name` in this repo,
 *                                        with `exports` / `source` / `main` and a dist→src mapping
 *   anything else is external.
 *
 * Python:
 *   - relative (`from . import a`, `from ..pkg.mod import x`) — submodules named in the import list
 *     get their own edge (`from . import sessions` → `sessions.py`, not `__init__.py`)
 *   - absolute (`import pkg.mod`, `from pkg import mod`) — matched against package roots (the parent
 *     of the top-most `__init__.py` chain, plus the repo root and `src/`), then same-directory
 *     siblings, then a unique ≥2-segment suffix (namespace packages). Unmatched ⇒ external.
 *
 * Java: see `javaResolver.ts` — imports, same-package and fully qualified uses → the declaring file.
 *
 * Go: see `goResolver.ts` — import path → package directory (go.mod / replace / go.work, or an
 * inferred GOPATH prefix) → the files declaring the names the importer uses.
 */
import { createGoResolver, type GoFileFacts, type GoResolver, type GoUse } from "./goResolver.js";
import { createJavaResolver, type ImplicitDependency, type JavaFileFacts, type JavaResolver } from "./javaResolver.js";

export type { GoFileFacts, GoUse } from "./goResolver.js";
export type { ImplicitDependency, JavaFileFacts } from "./javaResolver.js";
export type ResolverLanguage = "js" | "python" | "go" | "java";
/** What a resolver may need from each file's parse (Go: declarations; Java: types used and declared). */
export type ResolverFileFacts = GoFileFacts & JavaFileFacts;

export interface ImportSpecLike {
  source: string;
  /** Local bindings, index-aligned with `names` when present. */
  specifiers: string[];
  /** Python from-imports: the imported names (pre-alias). */
  names?: string[];
  /** Java `import static`. */
  isStatic?: boolean;
}

export interface ResolvedTarget {
  target: string;
  /** The local bindings that refer to this target (call/inheritance edges resolve through them). */
  bindings: string[];
  /** Qualified names this target declares for the importer (`store.Open`) — Go only, for precise call edges. */
  symbols?: string[];
}

export type ImportResolution =
  | { status: "resolved"; targets: ResolvedTarget[] }
  | { status: "external" }
  | { status: "unresolved" };

export interface ModuleResolver {
  /** `uses` (Go only): the file's `x.Y` references and bare calls, so the edge reaches the declaring file. */
  resolve(fromFile: string, spec: ImportSpecLike, language: ResolverLanguage, uses?: readonly GoUse[]): ImportResolution;
  /** Go: the file of `fromFile`'s own package declaring `name`. Undefined for other languages. */
  samePackage(fromFile: string, name: string): string | undefined;
  /** Dependencies the source creates with no import statement (Java: same package, fully qualified). */
  implicit(fromFile: string, language: ResolverLanguage): ImplicitDependency[];
}

export interface ModuleResolverInput {
  /** Every discovered repo-relative POSIX path (all roles — manifests included). */
  files: readonly string[];
  /** Reads a repo-relative file; null when unreadable. Only manifests are requested. */
  read(path: string): Promise<string | null>;
  /** Per-file parse facts. Go needs them: a package's declarations decide which file an import reaches. */
  facts?: ReadonlyMap<string, ResolverFileFacts>;
}

// `.d.ts` last: a declaration file is a real target only when no implementation exists beside it
// (e.g. a `types/index.d.ts` imported as "types" through baseUrl).
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".d.ts"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.mts", "index.js", "index.jsx", "index.mjs", "index.cjs", "index.d.ts"];
/** ESM TypeScript writes the OUTPUT extension in the specifier: `./a.js` means `./a.ts`. */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const BUILD_DIRS = new Set(["dist", "build", "lib", "out", "esm", "cjs", "es", "types"]);
/** `exports` condition preference: source-first, because the repo holds sources, not builds. */
const CONDITION_ORDER = ["source", "development", "types", "import", "module", "default", "require", "node", "browser"];
const PY_SOURCE_ROOTS = ["", "src", "lib", "python"];

interface PackageInfo {
  name?: string;
  dir: string;
  json: Record<string, unknown>;
}

interface TsPaths {
  /** Directory `paths` targets are relative to. */
  baseDir: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

interface TsConfigInfo {
  baseUrlDir?: string;
  paths?: TsPaths;
}

export async function createModuleResolver(input: ModuleResolverInput): Promise<ModuleResolver> {
  const fileSet = new Set(input.files);
  const packagesByName = new Map<string, PackageInfo>();
  const packagesByDir = new Map<string, PackageInfo>();
  const rawConfigs = new Map<string, Record<string, unknown>>();

  // ── Manifests ────────────────────────────────────────────────────────────────────
  const manifestReads: Array<Promise<void>> = [];
  for (const path of input.files) {
    const base = basename(path);
    if (base === "package.json") {
      manifestReads.push(
        input.read(path).then((text) => {
          const json = text === null ? null : parseJsonc(text);
          if (!json) return;
          const info: PackageInfo = { dir: dirname(path), json, name: typeof json.name === "string" ? json.name : undefined };
          packagesByDir.set(info.dir, info);
          // First declaration wins deterministically (paths are visited in sorted order below).
          if (info.name && !packagesByName.has(info.name)) packagesByName.set(info.name, info);
        }),
      );
    } else if (/^(?:tsconfig.*|jsconfig)\.json$/.test(base)) {
      manifestReads.push(
        input.read(path).then((text) => {
          const json = text === null ? null : parseJsonc(text);
          if (json) rawConfigs.set(path, json);
        }),
      );
    }
  }
  await Promise.all(manifestReads);
  // Re-key packagesByName deterministically (reads complete out of order).
  packagesByName.clear();
  for (const dir of [...packagesByDir.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const info = packagesByDir.get(dir)!;
    if (info.name && !packagesByName.has(info.name)) packagesByName.set(info.name, info);
  }

  const configCache = new Map<string, TsConfigInfo>();
  const effectiveConfig = (path: string, seen = new Set<string>()): TsConfigInfo => {
    const cached = configCache.get(path);
    if (cached) return cached;
    const json = rawConfigs.get(path);
    if (!json || seen.has(path)) return {};
    seen.add(path);
    const dir = dirname(path);
    let result: TsConfigInfo = {};
    const extendsList = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
    for (const ext of extendsList) {
      if (typeof ext !== "string" || !ext.startsWith(".")) continue;
      let parentPath = joinPath(dir, ext);
      if (!rawConfigs.has(parentPath) && rawConfigs.has(`${parentPath}.json`)) parentPath = `${parentPath}.json`;
      const parent = effectiveConfig(parentPath, seen);
      result = { ...result, ...parent };
    }
    const options = (json.compilerOptions ?? {}) as Record<string, unknown>;
    if (typeof options.baseUrl === "string") result.baseUrlDir = joinPath(dir, options.baseUrl);
    if (options.paths && typeof options.paths === "object") {
      const entries = Object.entries(options.paths as Record<string, unknown>)
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
        .map(([pattern, targets]) => ({ pattern, targets: targets.filter((t) => typeof t === "string") }));
      result.paths = { baseDir: result.baseUrlDir ?? dir, paths: entries };
    } else if (result.paths && typeof options.baseUrl === "string") {
      result.paths = { ...result.paths, baseDir: result.baseUrlDir! };
    }
    // Solution-style configs (Vite's template) keep `paths` in a referenced config.
    if (!result.paths && Array.isArray(json.references)) {
      for (const ref of json.references) {
        const refPath = ref && typeof ref === "object" ? (ref as { path?: unknown }).path : undefined;
        if (typeof refPath !== "string") continue;
        let target = joinPath(dir, refPath);
        if (!rawConfigs.has(target)) target = joinPath(target, "tsconfig.json");
        const referenced = effectiveConfig(target, seen);
        if (referenced.paths) {
          result = { ...result, paths: referenced.paths, baseUrlDir: result.baseUrlDir ?? referenced.baseUrlDir };
          break;
        }
      }
    }
    configCache.set(path, result);
    return result;
  };

  const nearestConfigCache = new Map<string, TsConfigInfo | null>();
  const nearestConfig = (fromDir: string): TsConfigInfo | null => {
    if (nearestConfigCache.has(fromDir)) return nearestConfigCache.get(fromDir)!;
    let found: TsConfigInfo | null = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = joinPath(fromDir, name);
      if (rawConfigs.has(candidate)) {
        found = effectiveConfig(candidate);
        break;
      }
    }
    if (!found && fromDir !== "") found = nearestConfig(dirname(fromDir));
    nearestConfigCache.set(fromDir, found);
    return found;
  };

  // ── JS / TS ──────────────────────────────────────────────────────────────────────
  const resolveFile = (base: string): string | undefined => {
    if (base !== "" && fileSet.has(base)) return base;
    const ext = extname(base);
    const swaps = JS_TO_TS[ext];
    if (swaps) {
      const stem = base.slice(0, -ext.length);
      for (const swap of swaps) if (fileSet.has(stem + swap)) return stem + swap;
    }
    if (base !== "") {
      for (const suffix of JS_EXTENSIONS) if (fileSet.has(base + suffix)) return base + suffix;
    }
    return resolveDirectory(base);
  };

  const resolveDirectory = (dir: string): string | undefined => {
    const pkg = packagesByDir.get(dir);
    if (pkg) {
      const entry = packageEntry(pkg, ".");
      if (entry) return entry;
    }
    for (const index of INDEX_FILES) {
      const candidate = joinPath(dir, index);
      if (fileSet.has(candidate)) return candidate;
    }
    return undefined;
  };

  /** A package's entry for `subpath` ("." or "./x"), mapped back to source when it names a build. */
  const entryInProgress = new Set<string>();
  const packageEntry = (pkg: PackageInfo, subpath: string): string | undefined => {
    // A `main` of "." or "./" points back at the package directory itself.
    const key = `${pkg.dir}\u0000${subpath}`;
    if (entryInProgress.has(key)) return undefined;
    entryInProgress.add(key);
    try {
      return packageEntryUnguarded(pkg, subpath);
    } finally {
      entryInProgress.delete(key);
    }
  };

  const packageEntryUnguarded = (pkg: PackageInfo, subpath: string): string | undefined => {
    const candidates: string[] = [];
    const exportsField = pkg.json.exports;
    const exported = exportTarget(exportsField, subpath);
    if (exported) candidates.push(exported);
    if (subpath === ".") {
      for (const key of ["source", "module", "main", "types", "typings"]) {
        const value = pkg.json[key];
        if (typeof value === "string") candidates.push(value);
      }
    } else {
      candidates.push(subpath);
    }
    for (const candidate of candidates) {
      const resolved = resolveFileWithBuildMapping(joinPath(pkg.dir, candidate));
      if (resolved) return resolved;
    }
    if (subpath === ".") {
      for (const fallback of ["src/index", "index", "src/main", `src/${basename(pkg.dir)}`]) {
        const resolved = resolveFile(joinPath(pkg.dir, fallback));
        if (resolved && resolved !== pkg.dir) return resolved;
      }
    } else {
      const resolved = resolveFile(joinPath(pkg.dir, joinPath("src", subpath)));
      if (resolved) return resolved;
    }
    return undefined;
  };

  const resolveFileWithBuildMapping = (path: string): string | undefined => {
    // `dist/index.js` → `src/index.ts` is tried FIRST: a package entry naming a build file means
    // "the compiled form of this source", and a committed dist/ must not win over the source.
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i += 1) {
      if (!BUILD_DIRS.has(segments[i])) continue;
      const mapped = [...segments.slice(0, i), "src", ...segments.slice(i + 1)].join("/");
      const viaSrc = resolveFile(stripDts(mapped));
      if (viaSrc) return viaSrc;
      const dropped = [...segments.slice(0, i), ...segments.slice(i + 1)].join("/");
      const viaRoot = resolveFile(stripDts(dropped));
      if (viaRoot) return viaRoot;
    }
    return resolveFile(stripDts(path)) ?? (path.endsWith(".d.ts") && fileSet.has(path) ? path : undefined);
  };

  const resolveJs = (fromFile: string, source: string): ImportResolution => {
    const clean = source.split("?")[0];
    if (clean.startsWith(".") || clean.startsWith("/")) {
      const base = clean.startsWith("/") ? clean.slice(1) : joinPath(dirname(fromFile), clean);
      const target = resolveFile(base);
      return target ? single(target) : { status: "unresolved" };
    }

    const config = nearestConfig(dirname(fromFile));
    if (config?.paths) {
      const mapped = matchPaths(config.paths, clean);
      if (mapped.matched) {
        for (const candidate of mapped.candidates) {
          const target = resolveFileWithBuildMapping(candidate);
          if (target) return single(target);
        }
        // A `paths` hit that lands nowhere is still internal-by-declaration — unless the same
        // name is a real workspace package or an npm dependency, fall through.
      }
    }
    if (config?.baseUrlDir !== undefined) {
      const target = resolveFile(joinPath(config.baseUrlDir, clean));
      if (target) return single(target);
    }

    const pkgName = packageNameOf(clean);
    const pkg = pkgName ? packagesByName.get(pkgName) : undefined;
    if (pkg) {
      const subpath = clean.length > pkgName!.length ? `.${clean.slice(pkgName!.length)}` : ".";
      const target = packageEntry(pkg, subpath);
      return target ? single(target) : { status: "unresolved" };
    }
    return { status: "external" };
  };

  // ── Python ───────────────────────────────────────────────────────────────────────
  const pyFiles = input.files.filter((path) => path.endsWith(".py"));
  const isPackageDir = (dir: string) => fileSet.has(joinPath(dir, "__init__.py"));
  /** dotted module name (relative to a package root) → files. */
  const pyRootIndex = new Map<string, string[]>();
  /** dotted suffix (≥2 segments) of the repo-relative module path → files. */
  const pySuffixIndex = new Map<string, string[]>();
  const addTo = (index: Map<string, string[]>, key: string, path: string) => {
    const list = index.get(key);
    if (list) {
      if (!list.includes(path)) list.push(path);
    } else index.set(key, [path]);
  };
  for (const path of pyFiles) {
    const moduleSegments = path.slice(0, -3).split("/");
    if (moduleSegments[moduleSegments.length - 1] === "__init__") moduleSegments.pop();
    if (moduleSegments.length === 0) continue;
    // Package root: climb while the parent directory is a package.
    let rootDepth = moduleSegments.length - 1; // index of the first segment below the root
    while (rootDepth > 0 && isPackageDir(moduleSegments.slice(0, rootDepth).join("/"))) rootDepth -= 1;
    // A loose script (no package around it) is importable by bare name only from its own
    // directory — the sibling rule covers that, so it does not register as a top-level module.
    const inPackage = path.endsWith("__init__.py") || rootDepth < moduleSegments.length - 1;
    const roots = new Set<number>(inPackage ? [rootDepth] : []);
    for (const known of PY_SOURCE_ROOTS) {
      const depth = known === "" ? 0 : known.split("/").length;
      if (known === "" || moduleSegments.slice(0, depth).join("/") === known) roots.add(depth);
    }
    for (const depth of roots) {
      const name = moduleSegments.slice(depth).join(".");
      if (name) addTo(pyRootIndex, name, path);
    }
    for (let start = 0; start <= moduleSegments.length - 2; start += 1) {
      addTo(pySuffixIndex, moduleSegments.slice(start).join("."), path);
    }
  }

  const pyModuleAt = (dirOrBase: string): string | undefined => {
    if (dirOrBase !== "" && fileSet.has(`${dirOrBase}.py`)) return `${dirOrBase}.py`;
    const init = joinPath(dirOrBase, "__init__.py");
    return fileSet.has(init) ? init : undefined;
  };

  const pickNearest = (fromFile: string, candidates: string[] | undefined): string | undefined => {
    if (!candidates || candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    return [...candidates].sort(
      (a, b) =>
        commonPrefixLength(b, fromFile) - commonPrefixLength(a, fromFile) || a.length - b.length || a.localeCompare(b),
    )[0];
  };

  const resolvePyAbsolute = (fromFile: string, dotted: string): string | undefined => {
    const fromDir = dirname(fromFile);
    const notSelf = (list: string[] | undefined) => list?.filter((path) => path !== fromFile);
    // Implicit sibling imports only exist for script directories (Python 3 has no implicit
    // relative imports inside a package) — e.g. pytest test folders without __init__.py.
    if (!isPackageDir(fromDir)) {
      const sibling = pyModuleAt(joinPath(fromDir, dotted.replace(/\./g, "/")));
      if (sibling && sibling !== fromFile) return sibling;
    }
    const rooted = pickNearest(fromFile, notSelf(pyRootIndex.get(dotted)));
    if (rooted) return rooted;
    if (dotted.includes(".")) return pickNearest(fromFile, notSelf(pySuffixIndex.get(dotted)));
    return undefined;
  };

  const resolvePython = (fromFile: string, spec: ImportSpecLike): ImportResolution => {
    const source = spec.source;
    const dots = source.match(/^\.+/)?.[0].length ?? 0;
    const moduleName = source.slice(dots);
    const names = spec.names ?? spec.specifiers;
    const targets = new Map<string, string[]>();
    const bind = (target: string, binding: string | undefined) => {
      const list = targets.get(target) ?? [];
      if (binding && !list.includes(binding)) list.push(binding);
      targets.set(target, list);
    };

    let moduleFile: string | undefined;
    let moduleDir: string | undefined; // for submodule lookup of imported names
    if (dots > 0) {
      let dir = dirname(fromFile);
      for (let i = 1; i < dots; i += 1) dir = dirname(dir);
      const base = moduleName ? joinPath(dir, moduleName.replace(/\./g, "/")) : dir;
      moduleFile = pyModuleAt(base);
      moduleDir = base;
    } else {
      moduleFile = resolvePyAbsolute(fromFile, moduleName);
      if (moduleFile?.endsWith("__init__.py")) moduleDir = dirname(moduleFile);
    }

    if (spec.names) {
      // from-import: an imported name that is itself a module gets its own edge.
      names.forEach((name, index) => {
        const binding = spec.specifiers[index];
        const submodule = moduleDir !== undefined && name !== "*" ? pyModuleAt(joinPath(moduleDir, name)) : undefined;
        if (submodule && submodule !== fromFile) bind(submodule, binding);
        else if (moduleFile) bind(moduleFile, binding);
      });
      if (names.length === 0 && moduleFile) bind(moduleFile, undefined);
    } else if (moduleFile) {
      for (const binding of spec.specifiers) bind(moduleFile, binding);
      if (spec.specifiers.length === 0) bind(moduleFile, undefined);
    }

    targets.delete(fromFile);
    if (targets.size > 0) {
      return {
        status: "resolved",
        targets: [...targets.entries()].map(([target, bindings]) => ({ target, bindings })),
      };
    }
    if (moduleFile === fromFile) return { status: "resolved", targets: [] };
    return dots > 0 ? { status: "unresolved" } : { status: "external" };
  };

  const go: GoResolver | undefined = input.files.some((path) => path.endsWith(".go"))
    ? await createGoResolver({ files: input.files, read: input.read, facts: input.facts ?? new Map() })
    : undefined;

  const java: JavaResolver | undefined = input.files.some((path) => path.endsWith(".java"))
    ? createJavaResolver({ files: input.files, facts: input.facts ?? new Map() })
    : undefined;

  return {
    implicit(fromFile, language) {
      return language === "java" && java ? java.implicit(fromFile) : [];
    },
    samePackage(fromFile, name) {
      return fromFile.endsWith(".go") ? go?.samePackage(fromFile, name) : undefined;
    },
    resolve(fromFile, spec, language, uses) {
      if (language === "go") return go ? go.resolve(fromFile, spec, uses ?? []) : { status: "external" };
      if (language === "java") return java ? java.resolve(fromFile, spec) : { status: "external" };
      if (language === "python") return resolvePython(fromFile, spec);
      const resolution = resolveJs(fromFile, spec.source);
      if (resolution.status === "resolved") {
        resolution.targets[0].bindings = [...spec.specifiers];
        if (resolution.targets[0].target === fromFile) return { status: "resolved", targets: [] };
      }
      return resolution;
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────────

function single(target: string): ImportResolution {
  return { status: "resolved", targets: [{ target, bindings: [] }] };
}

function matchPaths(config: TsPaths, specifier: string): { matched: boolean; candidates: string[] } {
  let best: { prefixLength: number; captured: string; targets: string[] } | undefined;
  for (const { pattern, targets } of config.paths) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) return { matched: true, candidates: targets.map((t) => joinPath(config.baseDir, t)) };
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      if (!best || prefix.length > best.prefixLength) {
        best = { prefixLength: prefix.length, captured: specifier.slice(prefix.length, specifier.length - suffix.length), targets };
      }
    }
  }
  if (!best) return { matched: false, candidates: [] };
  const captured = best.captured;
  return { matched: true, candidates: best.targets.map((t) => joinPath(config.baseDir, t.replace("*", captured))) };
}

function exportTarget(exportsField: unknown, subpath: string): string | undefined {
  if (exportsField === undefined || exportsField === null) return undefined;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? conditionValue(exportsField) : undefined;
  }
  if (typeof exportsField !== "object") return undefined;
  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length > 0 && !keys.some((key) => key.startsWith("."))) {
    return subpath === "." ? conditionValue(map) : undefined; // bare condition object = "." only
  }
  if (subpath in map) return conditionValue(map[subpath]);
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const value = conditionValue(map[key]);
      if (value) return value.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
}

function conditionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = conditionValue(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const map = value as Record<string, unknown>;
    for (const condition of CONDITION_ORDER) {
      if (condition in map) {
        const resolved = conditionValue(map[condition]);
        if (resolved) return resolved;
      }
    }
    for (const nested of Object.values(map)) {
      const resolved = conditionValue(nested);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith("node:")) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0] || undefined;
}

function stripDts(path: string): string {
  return path.replace(/\.d\.(?:m|c)?ts$/, "");
}

/** Parse JSON-with-comments (tsconfig) — comments and trailing commas removed outside strings. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += ch;
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/** Join a base dir + a relative path, resolving `.`/`..`; never produces a leading slash. */
export function joinPath(dir: string, rel: string): string {
  const segments = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a[i] === b[i]) i += 1;
  return i;
}
