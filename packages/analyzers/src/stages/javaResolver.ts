/**
 * Java name resolution: import or simple type name → the FILE declaring that type.
 *
 * javac resolves a simple type name in this order, and so does this resolver:
 *   1. a type declared in the file itself (or a type parameter) — no edge;
 *   2. a single-type import (`import a.b.C;`);
 *   3. a type of the SAME package — no import is written, but it is a real dependency;
 *   4. an on-demand import (`import a.b.*;`).
 * Fully qualified uses (`com.acme.Thing x`) resolve directly.
 *
 * The index is built from what each file DECLARES (`package` + top-level types), never from its
 * path, so Maven/Gradle (`src/main/java`), Ant (`src/`), and flat legacy layouts all work the same.
 *
 * An import is in-repo by declaration when a prefix of it names a package this repository
 * declares; if the type is then missing, the import is broken (unresolved), never external.
 */
import type { ImportResolution, ImportSpecLike, ResolvedTarget } from "./moduleResolver.js";

export interface JavaFileFacts {
  packageName?: string;
  declarations?: ReadonlyArray<{ name: string }>;
  imports?: ReadonlyArray<{ source: string; isStatic?: boolean }>;
  typeRefs?: readonly string[];
  localTypes?: readonly string[];
  qualifiedRefs?: readonly string[];
  headerRefs?: readonly string[];
}

/** An edge the source implies without an import statement: same-package or fully qualified use. */
export interface ImplicitDependency {
  target: string;
  /** The fully qualified name used, e.g. `com.acme.app.Helper`. */
  specifier: string;
  bindings: string[];
}

export interface JavaResolver {
  resolve(fromFile: string, spec: ImportSpecLike & { isStatic?: boolean }): ImportResolution;
  implicit(fromFile: string): ImplicitDependency[];
}

export function createJavaResolver(input: { files: readonly string[]; facts: ReadonlyMap<string, JavaFileFacts> }): JavaResolver {
  const javaFiles = input.files.filter((path) => path.endsWith(".java")).sort();

  /** FQN → declaring files (more than one when modules duplicate a class; nearest wins). */
  const byFqn = new Map<string, string[]>();
  /** package → simple name → declaring files. */
  const byPackage = new Map<string, Map<string, string[]>>();
  const packages = new Set<string>();

  for (const path of javaFiles) {
    const facts = input.facts.get(path);
    if (!facts) continue;
    const pkg = facts.packageName ?? "";
    packages.add(pkg);
    const members = byPackage.get(pkg) ?? new Map<string, string[]>();
    byPackage.set(pkg, members);
    for (const { name } of facts.declarations ?? []) {
      push(byFqn, pkg ? `${pkg}.${name}` : name, path);
      push(members, name, path);
    }
  }

  const nearest = (fromFile: string, candidates: string[] | undefined): string | undefined => {
    if (!candidates?.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    return [...candidates].sort(
      (a, b) => commonPrefixLength(b, fromFile) - commonPrefixLength(a, fromFile) || a.localeCompare(b),
    )[0];
  };

  /** `a.b.Outer.Inner` → the file declaring `a.b.Outer` (nested types live in their outer type's file). */
  const typeFile = (fromFile: string, dotted: string): string | undefined => {
    const segments = dotted.split(".");
    for (let end = segments.length; end >= 1; end -= 1) {
      const file = nearest(fromFile, byFqn.get(segments.slice(0, end).join(".")));
      if (file) return file;
    }
    return undefined;
  };

  /**
   * Is `dotted` (a type name, or a package for `.*`) in a package this repository declares? The
   * package is its leading lower-case segments (`com.acme.util` of `com.acme.util.Strings.Helper`).
   * Only that exact package counts: `com.google.common.truth.Truth` is not Guava's just because
   * Guava declares `com.google.common.*` packages.
   */
  const inRepoPackage = (dotted: string): boolean => {
    const segments = dotted.split(".");
    const packageSegments: string[] = [];
    for (const segment of segments) {
      if (!/^[a-z_]/.test(segment)) break;
      packageSegments.push(segment);
    }
    return packageSegments.length > 0 && packages.has(packageSegments.join("."));
  };

  /** Names a single-type import or the file itself already accounts for. */
  const shadowed = (facts: JavaFileFacts, header = false): Set<string> => {
    // In a top-level type's header only top-level declarations are in scope, not nested types.
    const names = new Set<string>(header ? (facts.declarations ?? []).map((decl) => decl.name) : (facts.localTypes ?? []));
    for (const entry of facts.imports ?? []) {
      if (!entry.isStatic && !entry.source.endsWith(".*")) names.add(entry.source.split(".").pop()!);
    }
    return names;
  };

  /** Each simple name to resolve, with the names that shadow it. */
  const namesToResolve = (facts: JavaFileFacts): Array<{ name: string; skip: Set<string> }> => {
    const body = shadowed(facts);
    const header = shadowed(facts, true);
    const out = (facts.typeRefs ?? []).filter((name) => !body.has(name)).map((name) => ({ name, skip: body }));
    for (const name of facts.headerRefs ?? []) {
      if (body.has(name) && !header.has(name)) out.push({ name, skip: header });
    }
    return out;
  };

  return {
    resolve(fromFile, spec) {
      const facts = input.facts.get(fromFile) ?? {};
      const source = spec.source;

      if (source.endsWith(".*")) {
        const base = source.slice(0, -2);
        // `import static a.b.C.*` and `import a.b.C.*` (nested types of C) both depend on C.
        const classFile = spec.isStatic || !packages.has(base) ? typeFile(fromFile, base) : undefined;
        if (classFile) return resolved(fromFile, [{ target: classFile, bindings: [] }]);
        if (!packages.has(base)) return { status: "external" }; // not a package of ours, not a type of ours
        // On-demand: only the names this file actually uses, after everything that outranks it.
        const own = byPackage.get(facts.packageName ?? "");
        const members = byPackage.get(base)!;
        const targets = new Map<string, string[]>();
        for (const { name } of namesToResolve(facts)) {
          if (own?.has(name)) continue;
          const file = nearest(fromFile, members.get(name));
          if (file) targets.set(file, [...(targets.get(file) ?? []), name]);
        }
        return resolved(fromFile, [...targets.entries()].map(([target, bindings]) => ({ target, bindings })));
      }

      // Single-type import, or a static member import (`a.b.C.member` → C).
      const typeName = spec.isStatic ? source.slice(0, source.lastIndexOf(".")) : source;
      const file = typeFile(fromFile, typeName);
      if (file) return resolved(fromFile, [{ target: file, bindings: [...spec.specifiers] }]);
      return inRepoPackage(typeName) ? { status: "unresolved" } : { status: "external" };
    },

    implicit(fromFile) {
      const facts = input.facts.get(fromFile);
      if (!facts) return [];
      const pkg = facts.packageName ?? "";
      const own = byPackage.get(pkg);
      const out = new Map<string, ImplicitDependency>();
      for (const { name } of namesToResolve(facts)) {
        const file = nearest(fromFile, own?.get(name));
        if (!file || file === fromFile) continue;
        const entry = out.get(file);
        if (entry) entry.bindings.push(name);
        else out.set(file, { target: file, specifier: pkg ? `${pkg}.${name}` : name, bindings: [name] });
      }
      for (const dotted of facts.qualifiedRefs ?? []) {
        const file = typeFile(fromFile, dotted);
        if (!file || file === fromFile || out.has(file)) continue;
        // Report the type part only: `com.acme.Thing.CONSTANT` → `com.acme.Thing`.
        const segments = dotted.split(".");
        let specifier = dotted;
        for (let end = 1; end <= segments.length; end += 1) {
          const prefix = segments.slice(0, end).join(".");
          if (byFqn.has(prefix)) {
            specifier = prefix;
            break;
          }
        }
        out.set(file, { target: file, specifier, bindings: [] });
      }
      return [...out.values()].sort((a, b) => a.target.localeCompare(b.target));
    },
  };
}

function resolved(fromFile: string, targets: ResolvedTarget[]): ImportResolution {
  return { status: "resolved", targets: targets.filter((target) => target.target !== fromFile) };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a[i] === b[i]) i += 1;
  return i;
}
