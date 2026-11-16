/**
 * C# name resolution: `using` directive or type name → the FILE(S) declaring that type.
 *
 * C# finds a simple type name in this order, and so does this resolver:
 *   1. a type declared in the file (or a type parameter) — no edge;
 *   2. the file's namespace and every ENCLOSING namespace (`Acme.Data.Inner` sees `Acme.Data` and
 *      `Acme`) — no `using` is written, but it is a real dependency;
 *   3. the file's `using` directives, plus every `global using` in the project;
 *   4. `using static T` (members of T) and aliases (`using J = X.Y;`).
 * Fully qualified uses (`Acme.Core.Models.User`) resolve directly. A `partial` type is declared in
 * several files; a use of it depends on all of them.
 *
 * A `using` for a namespace this repository declares is resolved to the types the file actually uses
 * from it (possibly none); one for a namespace it does not declare is external (the BCL, NuGet).
 */
import type { ImplicitDependency } from "./javaResolver.js";
import type { ImportResolution, ImportSpecLike, ResolvedTarget } from "./moduleResolver.js";

export interface CSharpFileFacts {
  namespaces?: readonly string[];
  /** Top-level types, FULLY QUALIFIED (`Acme.Data.Repo`). */
  declarations?: ReadonlyArray<{ name: string }>;
  imports?: ReadonlyArray<{ source: string; isStatic?: boolean; alias?: string; global?: boolean }>;
  typeRefs?: readonly string[];
  qualifiedRefs?: readonly string[];
  localTypes?: readonly string[];
}

export interface CSharpResolver {
  resolve(fromFile: string, spec: ImportSpecLike & { isStatic?: boolean; alias?: string; global?: boolean }): ImportResolution;
  implicit(fromFile: string): ImplicitDependency[];
}

export function createCSharpResolver(input: { files: readonly string[]; facts: ReadonlyMap<string, CSharpFileFacts> }): CSharpResolver {
  const csFiles = input.files.filter((path) => path.endsWith(".cs")).sort();
  /** FQN → every file declaring (a part of) that type. */
  const byFqn = new Map<string, string[]>();
  /** namespace → simple name → files. */
  const byNamespace = new Map<string, Map<string, string[]>>();
  const globalNamespaces = new Set<string>();

  for (const path of csFiles) {
    const facts = input.facts.get(path);
    for (const { name: fqn } of facts?.declarations ?? []) {
      push(byFqn, fqn, path);
      const dot = fqn.lastIndexOf(".");
      const namespace = dot === -1 ? "" : fqn.slice(0, dot);
      const members = byNamespace.get(namespace) ?? new Map<string, string[]>();
      byNamespace.set(namespace, members);
      push(members, fqn.slice(dot + 1), path);
    }
    for (const entry of facts?.imports ?? []) {
      if (entry.global && !entry.isStatic && !entry.alias) globalNamespaces.add(entry.source);
    }
  }

  /** The file's namespaces and all their ancestors, innermost first, ending with the global namespace. */
  const enclosing = (facts: CSharpFileFacts): string[] => {
    const out: string[] = [];
    for (const namespace of [...(facts.namespaces ?? [])].sort((a, b) => b.length - a.length)) {
      const parts = namespace.split(".");
      for (let end = parts.length; end >= 1; end -= 1) {
        const candidate = parts.slice(0, end).join(".");
        if (!out.includes(candidate)) out.push(candidate);
      }
    }
    out.push("");
    return out;
  };

  /** Names this file resolves by itself or through its enclosing namespaces (they outrank every `using`). */
  const resolvedByEnclosing = (fromFile: string, facts: CSharpFileFacts): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    const local = new Set(facts.localTypes ?? []);
    for (const name of facts.typeRefs ?? []) {
      if (local.has(name)) continue;
      for (const namespace of enclosing(facts)) {
        const files = byNamespace.get(namespace)?.get(name);
        if (files?.length) {
          found.set(name, files);
          break;
        }
      }
    }
    return found;
  };

  const typeFiles = (dotted: string): string[] | undefined => {
    const segments = dotted.split(".");
    for (let end = segments.length; end >= 1; end -= 1) {
      const files = byFqn.get(segments.slice(0, end).join("."));
      if (files?.length) return files;
    }
    return undefined;
  };

  const usedFrom = (fromFile: string, facts: CSharpFileFacts, namespaces: readonly string[]): ResolvedTarget[] => {
    const byEnclosing = resolvedByEnclosing(fromFile, facts);
    const local = new Set(facts.localTypes ?? []);
    const targets = new Map<string, string[]>();
    for (const name of facts.typeRefs ?? []) {
      if (local.has(name) || byEnclosing.has(name)) continue;
      for (const namespace of namespaces) {
        for (const file of byNamespace.get(namespace)?.get(name) ?? []) {
          if (file !== fromFile) targets.set(file, [...(targets.get(file) ?? []), name]);
        }
      }
    }
    return [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([target, bindings]) => ({ target, bindings }));
  };

  return {
    resolve(fromFile, spec) {
      const facts = input.facts.get(fromFile) ?? {};
      const source = spec.source;
      if (spec.alias || spec.isStatic) {
        // An alias or `using static` names a TYPE (or, for an alias, possibly a namespace).
        const files = typeFiles(source);
        if (files) {
          const targets = files.filter((file) => file !== fromFile).map((target) => ({ target, bindings: spec.alias ? [spec.alias] : [] }));
          return { status: "resolved", targets };
        }
        return byNamespace.has(source) ? { status: "resolved", targets: [] } : { status: "external" };
      }
      if (!byNamespace.has(source)) return { status: "external" };
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
      for (const [name, files] of resolvedByEnclosing(fromFile, facts)) {
        for (const file of files) {
          const namespace = enclosing(facts).find((candidate) => byNamespace.get(candidate)?.get(name)?.includes(file)) ?? "";
          add(file, namespace ? `${namespace}.${name}` : name, name);
        }
      }
      // `global using` directives declared anywhere in the project.
      const ownUsings = new Set((facts.imports ?? []).filter((entry) => !entry.alias && !entry.isStatic).map((entry) => entry.source));
      const globals = [...globalNamespaces].filter((namespace) => !ownUsings.has(namespace));
      for (const { target, bindings } of usedFrom(fromFile, facts, globals)) {
        const namespace = globals.find((candidate) => bindings.some((name) => byNamespace.get(candidate)?.get(name)?.includes(target))) ?? "";
        for (const binding of bindings) add(target, namespace ? `${namespace}.${binding}` : binding, binding);
      }
      // Fully qualified uses.
      for (const dotted of facts.qualifiedRefs ?? []) {
        const files = typeFiles(dotted);
        if (!files) continue;
        const segments = dotted.split(".");
        let specifier = dotted;
        for (let end = 1; end <= segments.length; end += 1) {
          if (byFqn.has(segments.slice(0, end).join("."))) {
            specifier = segments.slice(0, end).join(".");
            break;
          }
        }
        for (const file of files) add(file, specifier);
      }
      return [...out.values()].sort((a, b) => a.target.localeCompare(b.target));
    },
  };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}
