/**
 * C# name resolution: `using` directive or type name → the FILE(S) declaring that type.
 *
 * C# finds a simple type name in this order, and so does this resolver:
 *   1. a type declared in the file (or a type parameter) — no edge;
 *   2. the file's namespace and every ENCLOSING namespace (`Acme.Data.Inner` sees `Acme.Data` and
 *      `Acme`) — no `using` is written, but it is a real dependency;
 *   3. the file's `using` directives, plus every `global using` in the project;
 *   4. `using static T` (members of T) and aliases (`using J = X.Y;`).
 * A dotted name (`Acme.Core.Models.User`, or `Models.User` inside `namespace Acme.Core`) binds its first
 * identifier from the innermost enclosing namespace outwards, as does the name in a `using` written
 * inside a namespace. Names carry their generic arity: `Policy` and `Policy<T>` are different types. A
 * `partial` type is declared in several files; a use of it depends on all of them.
 *
 * Projects: a file sees the types of its own project (the nearest `.csproj` above it) and of the projects
 * that project references, transitively — not a same-named type in an unrelated project, nor source the
 * build takes as a NuGet package or a prebuilt DLL, nor a file no project compiles. A project whose
 * references cannot be read sees all.
 * `global using` (in a .cs file, or `<Using>` in the project file) applies to its own project's files.
 *
 * A `using` for a namespace this repository declares is resolved to the types the file actually uses
 * from it (possibly none); one for a namespace it does not declare is external (the BCL, NuGet).
 */
import type { ImplicitDependency } from "./javaResolver.js";
import type { ImportResolution, ImportSpecLike, ResolvedTarget } from "./moduleResolver.js";
import { readCSharpProjects } from "./msbuild.js";

export interface CSharpFileFacts {
  namespaces?: readonly string[];
  /** Top-level types, FULLY QUALIFIED, generic ones with their arity (`Acme.Data.Repo\`1`). */
  declarations?: ReadonlyArray<{ name: string }>;
  imports?: ReadonlyArray<{ source: string; isStatic?: boolean; alias?: string; global?: boolean; scope?: string }>;
  typeRefs?: readonly string[];
  qualifiedRefs?: readonly string[];
  localTypes?: readonly string[];
  partialSelfRefs?: readonly string[];
  nestedTypes?: ReadonlyArray<{ outer: string; name: string }>;
  accessRefs?: readonly string[];
  memberNames?: readonly string[];
  inheritance?: ReadonlyArray<{ symbol: string }>;
}

export interface CSharpResolver {
  resolve(fromFile: string, spec: ImportSpecLike): ImportResolution;
  implicit(fromFile: string): ImplicitDependency[];
}

const NO_PROJECT = "\u0000";

export async function createCSharpResolver(input: {
  files: readonly string[];
  facts: ReadonlyMap<string, CSharpFileFacts>;
  read(path: string): Promise<string | null>;
}): Promise<CSharpResolver> {
  const csFiles = input.files.filter((path) => path.endsWith(".cs")).sort();
  const projects = await readCSharpProjects(input.files, input.read);
  /** FQN → every file declaring (a part of) that type. */
  const byFqn = new Map<string, string[]>();
  /** namespace → simple name → files. */
  const byNamespace = new Map<string, Map<string, string[]>>();
  /** Project directory (or NO_PROJECT) → namespaces imported by `global using` for all its files. */
  const globalNamespaces = new Map<string, Set<string>>();
  /** Outermost type FQN → nested type name → the files (parts) declaring it. */
  const nestedByOuter = new Map<string, Map<string, string[]>>();
  /** Every namespace the repository declares, with all its prefixes (`Acme.Data` ⇒ `Acme` too). */
  const namespaceSet = new Set<string>();
  const addNamespace = (namespace: string) => {
    const parts = namespace.split(".");
    for (let end = 1; end <= parts.length; end += 1) namespaceSet.add(parts.slice(0, end).join("."));
  };

  for (const path of csFiles) {
    const facts = input.facts.get(path);
    for (const { name: fqn } of facts?.declarations ?? []) {
      push(byFqn, fqn, path);
      const dot = fqn.lastIndexOf(".");
      const namespace = dot === -1 ? "" : fqn.slice(0, dot);
      const members = byNamespace.get(namespace) ?? new Map<string, string[]>();
      byNamespace.set(namespace, members);
      push(members, fqn.slice(dot + 1), path);
      if (namespace) addNamespace(namespace);
    }
    for (const namespace of facts?.namespaces ?? []) addNamespace(namespace);
    for (const { outer, name } of facts?.nestedTypes ?? []) {
      const members = nestedByOuter.get(outer) ?? new Map<string, string[]>();
      nestedByOuter.set(outer, members);
      push(members, name, path);
    }
  }

  // ── Projects: which files can a file see? ────────────────────────────────────────
  /** File → the projects compiling it: those listing it explicitly, and the nearest globbing project above. */
  const explicitOwners = new Map<string, string[]>();
  for (const [dir, project] of projects) for (const file of project.compiles) push(explicitOwners, file, dir);
  const globbingAbove = new Map<string, string | undefined>();
  const nearestGlobbing = (start: string): string | undefined => {
    if (globbingAbove.has(start)) return globbingAbove.get(start);
    let found: string | undefined;
    for (let dir: string | undefined = start; dir !== undefined; dir = dir === "" ? undefined : dirname(dir)) {
      if (projects.get(dir)?.globs) {
        found = dir;
        break;
      }
    }
    globbingAbove.set(start, found);
    return found;
  };
  const ownersCache = new Map<string, string[]>();
  const ownersOf = (file: string): string[] => {
    let owners = ownersCache.get(file);
    if (!owners) {
      owners = [...(explicitOwners.get(file) ?? [])];
      const globbing = nearestGlobbing(dirname(file));
      if (globbing !== undefined && !owners.includes(globbing)) owners.push(globbing);
      ownersCache.set(file, owners);
    }
    return owners;
  };
  const visibleCache = new Map<string, Set<string> | null>();
  /** The projects `project` can see (itself + transitive references), or null for "everything". */
  const visibleFrom = (project: string): Set<string> | null => {
    if (visibleCache.has(project)) return visibleCache.get(project)!;
    const seen = new Set<string>([project]);
    const queue = [project];
    let open = false;
    while (queue.length) {
      const info = projects.get(queue.pop()!);
      if (!info) continue;
      if (info.open) open = true;
      for (const reference of info.references) {
        if (!seen.has(reference)) {
          seen.add(reference);
          queue.push(reference);
        }
      }
    }
    const result = open ? null : seen;
    visibleCache.set(project, result);
    return result;
  };
  const globalsOf = (file: string): Set<string> => {
    const out = new Set<string>();
    const owners = ownersOf(file);
    for (const key of owners.length ? owners : [NO_PROJECT]) for (const namespace of globalNamespaces.get(key) ?? []) out.add(namespace);
    return out;
  };
  for (const path of csFiles) {
    for (const entry of input.facts.get(path)?.imports ?? []) {
      if (!entry.global || entry.isStatic || entry.alias) continue;
      const namespace = qualify(entry.source, entry.scope);
      const owners = ownersOf(path);
      for (const key of owners.length ? owners : [NO_PROJECT]) {
        const set = globalNamespaces.get(key) ?? new Set<string>();
        globalNamespaces.set(key, set);
        set.add(namespace);
      }
    }
  }
  for (const [dir, project] of projects) {
    const set = globalNamespaces.get(dir) ?? new Set<string>();
    globalNamespaces.set(dir, set);
    for (const namespace of project.usings) set.add(namespace);
  }

  /** The candidates `fromFile` can see. When some are in its own project, only those: C# prefers a type
   *  in the compilation itself over an imported one of the same name. */
  const visible = (fromFile: string, files: readonly string[] | undefined): string[] => {
    if (!files?.length) return [];
    const from = ownersOf(fromFile);
    if (!from.length) return [...files];
    const sees = new Set<string>();
    for (const project of from) {
      const set = visibleFrom(project);
      if (!set) return [...files];
      for (const entry of set) sees.add(entry);
    }
    // A file no project compiles is not part of any build: nothing in a project sees it.
    const seen = files.filter((file) => ownersOf(file).some((owner) => sees.has(owner)));
    const own = seen.filter((file) => ownersOf(file).some((owner) => from.includes(owner)));
    return own.length ? own : seen;
  };

  /** The namespaces a name written in `scope` is looked up in: `scope`, each parent, then the global one. */
  function outwards(scope: string | undefined): string[] {
    const out: string[] = [];
    const parts = scope ? scope.split(".") : [];
    for (let end = parts.length; end >= 1; end -= 1) out.push(parts.slice(0, end).join("."));
    out.push("");
    return out;
  }

  /** `using Wrappers;` written inside `namespace MediatR` names `MediatR.Wrappers` when that exists. */
  function qualify(source: string, scope: string | undefined): string {
    if (!scope) return source;
    const first = source.split(".")[0];
    for (const namespace of outwards(scope)) {
      const head = namespace ? `${namespace}.${first}` : first;
      if (namespaceSet.has(head) || byFqn.has(head)) return namespace ? `${namespace}.${source}` : source;
    }
    return source;
  }

  /** The file's namespaces and all their ancestors, innermost first, ending with the global namespace. */
  const enclosing = (facts: CSharpFileFacts): string[] => {
    const out: string[] = [];
    for (const namespace of [...(facts.namespaces ?? [])].sort((a, b) => b.length - a.length)) {
      for (const candidate of outwards(namespace)) if (candidate && !out.includes(candidate)) out.push(candidate);
    }
    out.push("");
    return out;
  };

  /** A simple type name as `file` would bind it: enclosing namespaces first, then its usings. */
  const lookupSimple = (file: string, facts: CSharpFileFacts, name: string): string[] => {
    for (const namespace of enclosing(facts)) {
      const files = visible(file, byNamespace.get(namespace)?.get(name));
      if (files.length) return files;
    }
    const usings = new Set(globalsOf(file));
    for (const entry of facts.imports ?? []) if (!entry.alias && !entry.isStatic) usings.add(qualify(entry.source, entry.scope));
    return [...usings].flatMap((namespace) => visible(file, byNamespace.get(namespace)?.get(name)));
  };

  /** What is in scope inside `file`'s types: members (fields, properties, locals…) and nested types — its
   *  own, its partial types' other parts', and its base types' (a few levels up). `Name.Member` with such a
   *  member Name is that member, not a type; a nested type of a base class is found before any namespace. */
  const scopes = new Map<string, { members: Set<string>; nested: Map<string, string[]> }>();
  const scopeOf = (file: string) => {
    const cached = scopes.get(file);
    if (cached) return cached;
    const members = new Set<string>();
    const nested = new Map<string, string[]>();
    const seen = new Set<string>();
    const visitType = (fqn: string, depth: number) => {
      if (seen.has(fqn) || depth > 4) return;
      seen.add(fqn);
      for (const [name, files] of nestedByOuter.get(fqn) ?? []) for (const nestedFile of files) push(nested, name, nestedFile);
      for (const part of byFqn.get(fqn) ?? []) {
        const facts = input.facts.get(part);
        if (!facts) continue;
        for (const member of facts.memberNames ?? []) members.add(member);
        for (const { symbol } of facts.inheritance ?? []) {
          for (const base of baseTypes(part, facts, symbol)) visitType(base, depth + 1);
        }
      }
    };
    const own = input.facts.get(file);
    for (const member of own?.memberNames ?? []) members.add(member);
    for (const { name } of own?.declarations ?? []) visitType(name, 0);
    const scope = { members, nested };
    scopes.set(file, scope);
    return scope;
  };
  const memberScope = (file: string) => scopeOf(file).members;

  /** The fully qualified types a base-list name in `file` denotes. */
  const baseTypes = (file: string, facts: CSharpFileFacts, symbol: string): string[] => {
    const last = symbol.split(".").pop()!;
    const files = symbol.includes(".")
      ? (qualifiedType(file, facts, symbol)?.files ?? [])
      : [0, 1, 2, 3].flatMap((arity) => lookupSimple(file, facts, arity ? `${symbol}\`${arity}` : symbol));
    const out = new Set<string>();
    for (const target of files) {
      for (const { name } of input.facts.get(target)?.declarations ?? []) {
        if (plain(name.slice(name.lastIndexOf(".") + 1)) === last) out.add(name);
      }
    }
    return [...out];
  };

  /** The type names `file` uses: type positions, plus `Name.Member` roots that are not members in scope. */
  const refsCache = new Map<string, string[]>();
  const refsOf = (file: string, facts: CSharpFileFacts): string[] => {
    let refs = refsCache.get(file);
    if (!refs) {
      const access = facts.accessRefs ?? [];
      const { members, nested } = scopeOf(file);
      // A nested type in scope is found before any namespace (and is linked by the nested-type rule).
      refs = [...(facts.typeRefs ?? []), ...access.filter((name) => !members.has(name))].filter((name) => !nested.has(name));
      refsCache.set(file, refs);
    }
    return refs;
  };

  /** Names this file resolves by itself or through its enclosing namespaces (they outrank every `using`). */
  const resolvedByEnclosing = (fromFile: string, facts: CSharpFileFacts): Map<string, { namespace: string; files: string[] }> => {
    const found = new Map<string, { namespace: string; files: string[] }>();
    const local = new Set(facts.localTypes ?? []);
    for (const name of refsOf(fromFile, facts)) {
      if (local.has(name)) continue;
      for (const namespace of enclosing(facts)) {
        const files = visible(fromFile, byNamespace.get(namespace)?.get(name));
        if (files.length) {
          found.set(name, { namespace, files });
          break;
        }
        // A NAMESPACE of that name found first (`TestAssembly.MockTestFixture` inside `NUnit.Tests`): the
        // name is that namespace, and no `using` is consulted for it.
        if (namespaceSet.has(namespace ? `${namespace}.${name}` : name)) {
          found.set(name, { namespace, files: [] });
          break;
        }
      }
    }
    return found;
  };

  /** An alias or `using static` target: the outermost type along the dotted name. */
  const typeFiles = (fromFile: string, dotted: string): string[] => {
    const segments = dotted.split(".");
    for (let end = 1; end <= segments.length; end += 1) {
      const files = visible(fromFile, byFqn.get(segments.slice(0, end).join(".")));
      if (files.length) return files;
    }
    return [];
  };

  /** A dotted name in code: its first identifier binds in the innermost enclosing namespace that has it
   *  (no backtracking once found); the dependency is the type it names — the deepest nested type found
   *  along the rest (`Outer.Inner` lives in one part of a partial `Outer`), else the outer type. */
  const qualifiedType = (fromFile: string, facts: CSharpFileFacts, dotted: string): { fqn: string; files: string[] } | undefined => {
    const segments = dotted.split(".");
    for (const namespace of enclosing(facts)) {
      const prefix = namespace ? `${namespace}.` : "";
      if (!namespaceSet.has(prefix + segments[0]) && !byFqn.has(prefix + segments[0])) continue;
      for (let end = 1; end <= segments.length; end += 1) {
        const fqn = prefix + segments.slice(0, end).join(".");
        const files = visible(fromFile, byFqn.get(fqn));
        if (!files.length) continue;
        const nested = nestedByOuter.get(fqn);
        let found = { fqn, files };
        for (const segment of segments.slice(end)) {
          const inner = visible(fromFile, nested?.get(segment));
          if (!inner.length) break;
          found = { fqn: `${found.fqn}.${segment}`, files: inner };
        }
        return found;
      }
      return undefined;
    }
    return undefined;
  };

  const usedFrom = (fromFile: string, facts: CSharpFileFacts, namespaces: readonly string[]): ResolvedTarget[] => {
    const byEnclosing = resolvedByEnclosing(fromFile, facts);
    const local = new Set(facts.localTypes ?? []);
    const targets = new Map<string, string[]>();
    for (const name of refsOf(fromFile, facts)) {
      if (local.has(name) || byEnclosing.has(name)) continue;
      for (const namespace of namespaces) {
        for (const file of visible(fromFile, byNamespace.get(namespace)?.get(name))) {
          if (file !== fromFile) targets.set(file, [...(targets.get(file) ?? []), plain(name)]);
        }
      }
    }
    return [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([target, bindings]) => ({ target, bindings }));
  };

  return {
    resolve(fromFile, spec) {
      const facts = input.facts.get(fromFile) ?? {};
      const source = qualify(spec.source, spec.scope);
      if (spec.alias || spec.isStatic) {
        // An alias or `using static` names a TYPE (or, for an alias, possibly a namespace).
        const files = typeFiles(fromFile, source);
        if (files.length) {
          const targets = files.filter((file) => file !== fromFile).map((target) => ({ target, bindings: spec.alias ? [spec.alias] : [] }));
          return { status: "resolved", targets };
        }
        return namespaceSet.has(source) ? { status: "resolved", targets: [] } : { status: "external" };
      }
      if (!namespaceSet.has(source)) return { status: "external" };
      // A `global using` in this file applies to every file; its dependencies are recorded where used.
      return { status: "resolved", targets: spec.global ? [] : usedFrom(fromFile, facts, [source]) };
    },

    implicit(fromFile) {
      const facts = input.facts.get(fromFile);
      if (!facts) return [];
      const out = new Map<string, ImplicitDependency>();
      const add = (file: string, specifier: string, binding?: string) => {
        if (file === fromFile) return;
        const entry = out.get(file);
        if (entry) {
          if (binding && !entry.bindings.includes(binding)) entry.bindings.push(binding);
        } else out.set(file, { target: file, specifier, bindings: binding ? [binding] : [] });
      };
      // Same and enclosing namespaces: no `using` needed.
      for (const [name, { namespace, files }] of resolvedByEnclosing(fromFile, facts)) {
        for (const file of files) add(file, namespace ? `${namespace}.${plain(name)}` : plain(name), plain(name));
      }
      // `global using` directives declared anywhere in the project.
      const ownUsings = new Set(
        (facts.imports ?? []).filter((entry) => !entry.alias && !entry.isStatic).map((entry) => qualify(entry.source, entry.scope)),
      );
      const globals = [...globalsOf(fromFile)].filter((namespace) => !ownUsings.has(namespace));
      for (const { target, bindings } of usedFrom(fromFile, facts, globals)) {
        const namespace =
          globals.find((candidate) => [...(byNamespace.get(candidate)?.entries() ?? [])].some(([name, files]) => bindings.includes(plain(name)) && files.includes(target))) ?? "";
        for (const binding of bindings) add(target, namespace ? `${namespace}.${binding}` : binding, binding);
      }
      // `<Using Include="X.Y" Alias="Z" />` in the project file: Z names the type X.Y.
      const aliases = new Map(ownersOf(fromFile).flatMap((owner) => [...(projects.get(owner)?.aliases ?? [])]));
      if (aliases.size) {
        const local = new Set(facts.localTypes ?? []);
        for (const name of refsOf(fromFile, facts)) {
          const target = aliases.get(name);
          if (!target || local.has(name)) continue;
          for (const file of typeFiles(fromFile, target)) add(file, target, name);
        }
      }
      // A part of a partial type that names that type depends on its other parts; one that names a nested
      // type declared in another part depends on that part.
      const local = new Set(facts.localTypes ?? []);
      for (const { name: fqn } of facts.declarations ?? []) {
        const parts = (byFqn.get(fqn) ?? []).filter((file) => file !== fromFile);
        if (!parts.length) continue;
        const simple = fqn.slice(fqn.lastIndexOf(".") + 1);
        if ((facts.partialSelfRefs ?? []).includes(simple)) for (const file of visible(fromFile, parts)) add(file, plain(fqn), plain(simple));
      }
      // A nested type of this file's types (declared in another part) or of their base classes.
      const { nested } = scopeOf(fromFile);
      for (const name of [...(facts.typeRefs ?? []), ...(facts.accessRefs ?? [])]) {
        if (local.has(name)) continue;
        for (const file of visible(fromFile, nested.get(name))) add(file, plain(name), plain(name));
      }
      // Dotted uses.
      for (const dotted of facts.qualifiedRefs ?? []) {
        const found = qualifiedType(fromFile, facts, dotted);
        for (const file of found?.files ?? []) add(file, plain(found!.fqn));
      }
      return [...out.values()].sort((a, b) => a.target.localeCompare(b.target));
    },
  };
}

/** `Policy\`1` → `Policy`: arity is how names are matched, not how they are shown. */
function plain(name: string): string {
  return name.replace(/`\d+/g, "");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}
