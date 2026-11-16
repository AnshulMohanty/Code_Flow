import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { collectByType, endLine, field, namedChildrenOf, startLine } from "./ast.js";
import { grammarParser } from "./runtime.js";

/**
 * C#, from one tree-sitter pass.
 *
 * A C# file names NAMESPACES, not files: `using Acme.Core;` makes every type of that namespace
 * visible, and a type is also visible from its own namespace and every enclosing one — with no
 * `using` at all. Types can be split across files (`partial`). So the resolver needs each file's
 * namespaces, its declared types, its `using` directives (plain, `static`, aliases, `global`), and
 * every type name the file mentions. The grammar has no separate type-identifier node, so a type
 * use is an identifier in a TYPE POSITION (a declaration's type, a base list, a generic argument, a
 * cast/`is`/`typeof`, an attribute, `nameof`, or `Type.Member`).
 *
 * Names carry their generic ARITY (`Policy` vs `Policy`1`): to C# these are different types. An
 * attribute `[Test]` names the class `TestAttribute`.
 */

export interface CSharpUsing {
  /** `Acme.Core`, or for `using static` / an alias the type or namespace named. */
  target: string;
  kind: "namespace" | "static" | "alias";
  /** `using J = Newtonsoft.Json;` → "J". */
  alias?: string;
  /** `global using` applies to every file of the project. */
  global: boolean;
  /** The namespace the directive is written in ("" at the top): `using Wrappers;` inside `namespace
   *  MediatR` names `MediatR.Wrappers`. */
  scope: string;
  line: number;
}

export interface CSharpType {
  name: string;
  kind: "class" | "struct" | "interface" | "enum" | "record" | "delegate";
  /** Number of type parameters (`Policy<TResult>` → 1). */
  arity: number;
  namespace: string;
  /** Enclosing type for a nested type. */
  outer?: string;
  /** Outermost enclosing type (with arity) for a nested type. */
  outermost?: string;
  isPublic: boolean;
  partial: boolean;
  line: number;
  lineEnd: number;
}

export interface CSharpRef {
  binding: string;
  symbol: string;
  line: number;
}

export interface CSharpExtract {
  usings: CSharpUsing[];
  namespaces: string[];
  types: CSharpType[];
  methods: Array<{ owner: string; name: string; line: number; lineEnd: number; isPublic: boolean }>;
  /** Simple type names used in TYPE positions (and the root of a dotted name). */
  typeRefs: string[];
  /** Names seen only as `Name.Member`: a type — unless the file's type has a field/property/local of that
   *  name (`AsyncPolicy<int> AsyncPolicy` … `AsyncPolicy.ExecuteAsync()`), which the resolver checks. */
  accessRefs: string[];
  /** PascalCase fields, properties, events, locals and parameters declared in this file — except a member
   *  typed by its own name ("Color Color"), which does not hide that type. */
  memberNames: string[];
  /** Dotted names used in type positions — `Acme.Core.Models.User` — resolved as fully qualified. */
  qualifiedRefs: string[];
  /** Names that shadow other types inside this file: its own types and type parameters. */
  localTypes: string[];
  /** This file's own top-level PARTIAL types that it also names: it depends on their other parts. */
  partialSelfRefs: string[];
  calls: CSharpRef[];
  inheritance: Array<CSharpRef & { kind: "extends" }>;
  routes: Array<{ method: HttpRouteMethod; path: string; line: number }>;
}

const TYPE_DECLARATIONS: Record<string, CSharpType["kind"]> = {
  class_declaration: "class",
  struct_declaration: "struct",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  record_struct_declaration: "record",
  delegate_declaration: "delegate",
};

/** Parents whose identifier children are types. */
const TYPE_LIST_PARENTS = new Set(["base_list", "type_argument_list", "array_type", "nullable_type", "pointer_type", "ref_type", "type_parameter_constraint"]);

/** ASP.NET Core routing attributes. `Route` maps every verb. */
const ASPNET_ROUTES: Record<string, HttpRouteMethod> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpPatch: "PATCH",
  HttpDelete: "DELETE",
  Route: "ALL",
};

/**
 * The facts of one file. An `#if` that splits a construct in two (Serilog's `ILogger`: a method whose
 * body exists only `#if FEATURE_DEFAULT_INTERFACE`) breaks the parse of the whole file; then the file is
 * parsed once per branch position — the first branch of every condition, then the second (`#elif`/`#else`),
 * and so on — with the other lines blanked so line numbers hold, and the facts are merged: code in any
 * branch is real.
 */
export function extractCSharp(tree: Tree, content: string): CSharpExtract {
  if (!tree.rootNode.hasError || !/^[ \t]*#[ \t]*if\b/m.test(content)) return extractCSharpFacts(tree);
  const parser = grammarParser("csharp");
  if (!parser) return extractCSharpFacts(tree);
  const sides: CSharpExtract[] = [];
  const branches = Math.min(4, maxBranches(content));
  for (let branch = 0; branch < branches; branch += 1) {
    const side = parser.parse(selectBranches(content, branch));
    if (!side) continue;
    sides.push(extractCSharpFacts(side));
    side.delete();
  }
  return sides.length ? mergeExtracts(sides) : extractCSharpFacts(tree);
}

const DIRECTIVE = /^[ \t]*#[ \t]*(if|elif|else|endif)\b/;

/** The most branches any `#if` group has (`#if … #elif … #else` = 3). */
function maxBranches(content: string): number {
  const stack: number[] = [];
  let most = 1;
  for (const line of content.split("\n")) {
    const directive = DIRECTIVE.exec(line)?.[1];
    if (directive === "if") stack.push(1);
    else if ((directive === "elif" || directive === "else") && stack.length) most = Math.max(most, (stack[stack.length - 1] += 1));
    else if (directive === "endif") stack.pop();
  }
  return Math.max(most, 2);
}

/** Keep branch `branch` (0 = the `#if` part) of every `#if`/`#elif`/`#else` group — none where a group has
 *  fewer — blanking the rest and the directives. */
export function selectBranches(content: string, branch: number): string {
  const stack: Array<{ parentActive: boolean; index: number; active: boolean }> = [];
  const isActive = () => stack.length === 0 || stack[stack.length - 1].active;
  return content
    .split("\n")
    .map((line) => {
      const directive = DIRECTIVE.exec(line)?.[1];
      if (!directive) return isActive() ? line : "";
      const top = stack[stack.length - 1];
      if (directive === "if") {
        const parentActive = isActive();
        stack.push({ parentActive, index: 0, active: parentActive && branch === 0 });
      } else if ((directive === "elif" || directive === "else") && top) {
        top.index += 1;
        top.active = top.parentActive && top.index === branch;
      } else if (directive === "endif") stack.pop();
      return "";
    })
    .join("\n");
}

function mergeExtracts(sides: CSharpExtract[]): CSharpExtract {
  const unique = <T>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Map<string, T>();
    for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
    return [...seen.values()];
  };
  const all = <K extends keyof CSharpExtract>(key: K) => sides.flatMap((side) => side[key] as unknown[]) as CSharpExtract[K];
  const sortedSet = (key: "namespaces" | "typeRefs" | "accessRefs" | "memberNames" | "qualifiedRefs" | "localTypes") => [...new Set(all(key))].sort();
  return {
    usings: unique(all("usings"), (u) => `${u.line}|${u.kind}|${u.target}|${u.alias ?? ""}`).sort((a, b) => a.line - b.line),
    namespaces: sortedSet("namespaces"),
    types: unique(all("types"), (t) => `${t.line}|${t.name}`).sort((a, b) => a.line - b.line),
    methods: unique(all("methods"), (m) => `${m.line}|${m.owner}.${m.name}`).sort((a, b) => a.line - b.line),
    typeRefs: sortedSet("typeRefs"),
    accessRefs: sortedSet("accessRefs"),
    memberNames: sortedSet("memberNames"),
    qualifiedRefs: sortedSet("qualifiedRefs"),
    localTypes: sortedSet("localTypes"),
    partialSelfRefs: [...new Set(all("partialSelfRefs"))].sort(),
    calls: unique(all("calls"), (c) => `${c.line}|${c.symbol}`).sort((a, b) => a.line - b.line),
    inheritance: unique(all("inheritance"), (i) => `${i.line}|${i.symbol}`).sort((a, b) => a.line - b.line),
    routes: unique(all("routes"), (r) => `${r.line}|${r.method}|${r.path}`).sort((a, b) => a.line - b.line),
  };
}

export function extractCSharpFacts(tree: Tree): CSharpExtract {
  const out: CSharpExtract = {
    usings: [],
    namespaces: [],
    types: [],
    methods: [],
    typeRefs: [],
    accessRefs: [],
    memberNames: [],
    qualifiedRefs: [],
    localTypes: [],
    partialSelfRefs: [],
    calls: [],
    inheritance: [],
    routes: [],
  };
  const root = tree.rootNode;
  const pick = collectByType(root, [
    "using_directive",
    "namespace_declaration",
    "file_scoped_namespace_declaration",
    ...Object.keys(TYPE_DECLARATIONS),
    "method_declaration",
    "type_parameter",
    "identifier",
    "qualified_name",
    "invocation_expression",
    "object_creation_expression",
    "member_access_expression",
    "variable_declarator",
    "property_declaration",
    "event_declaration",
    "parameter",
    "attribute",
  ]);
  const refs = new Set<string>();
  const access = new Set<string>();
  const members = new Set<string>();
  const qualified = new Set<string>();
  const locals = new Set<string>();
  const namespaces = new Set<string>();

  for (const node of pick("using_directive")) {
    const name = namedChildrenOf(node).find((child) => child.type === "qualified_name" || child.type === "identifier" || child.type === "generic_name");
    const alias = field(node, "name");
    const target = namedChildrenOf(node).filter((child) => child.id !== alias?.id && (child.type === "qualified_name" || child.type === "identifier" || child.type === "generic_name")).pop() ?? name;
    if (!target) continue;
    const text = node.text;
    out.usings.push({
      target: typeName(target),
      kind: alias ? "alias" : /\busing\s+static\b/.test(text) ? "static" : "namespace",
      ...(alias ? { alias: alias.text } : {}),
      global: /^\s*global\s+using\b/.test(text),
      scope: namespaceOf(node),
      line: startLine(node),
    });
  }

  for (const node of pick(["namespace_declaration", "file_scoped_namespace_declaration"])) {
    const name = field(node, "name");
    if (name) namespaces.add(namespaceOf(node));
  }

  for (const node of pick(Object.keys(TYPE_DECLARATIONS))) {
    const name = field(node, "name");
    if (!name) continue;
    const outer = enclosingTypeName(node);
    const arity = arityOfDeclaration(node);
    const outermost = outermostType(node);
    out.types.push({
      name: name.text,
      kind: TYPE_DECLARATIONS[node.type],
      arity,
      namespace: namespaceOf(node),
      ...(outer ? { outer } : {}),
      ...(outermost ? { outermost } : {}),
      isPublic: hasModifier(node, "public"),
      partial: hasModifier(node, "partial"),
      line: startLine(node),
      lineEnd: endLine(node),
    });
    locals.add(withArity(name.text, arity));
    const bases = namedChildrenOf(node).find((child) => child.type === "base_list");
    for (const base of bases ? namedChildrenOf(bases) : []) {
      const symbol = dotted(base.type === "generic_name" ? namedChildrenOf(base)[0] ?? base : base);
      if (symbol) out.inheritance.push({ binding: symbol.split(".")[0], symbol, kind: "extends", line: startLine(node) });
    }
  }
  for (const node of pick("type_parameter")) {
    const name = field(node, "name") ?? namedChildrenOf(node).find((child) => child.type === "identifier");
    if (name) locals.add(name.text);
  }
  for (const node of pick("method_declaration")) {
    const name = field(node, "name");
    const owner = enclosingTypeName(node);
    if (name && owner) {
      out.methods.push({ owner, name: name.text, line: startLine(node), lineEnd: endLine(node), isPublic: hasModifier(node, "public") });
    }
  }

  // Type uses: identifiers and qualified names in a type position.
  for (const node of pick("qualified_name")) {
    if (node.parent?.type === "qualified_name") continue; // the outermost name covers it
    if (node.parent?.type === "using_directive" || isDeclarationName(node)) continue;
    if (node.parent?.type === "namespace_declaration" || node.parent?.type === "file_scoped_namespace_declaration") continue;
    if (!inTypePosition(node)) continue;
    const text = typeName(node);
    const rootName = text.split(".")[0];
    if (/^[a-z]/.test(rootName)) qualified.add(text);
    else {
      refs.add(rootName);
      qualified.add(text);
    }
  }
  for (const node of pick("identifier")) {
    const parent = node.parent;
    if (!parent || parent.type === "qualified_name") continue;
    if (parent.type === "member_access_expression") {
      // `Helper.Do()` / `Status.Active`: the left side, when it reads as a type name.
      if (field(parent, "expression")?.id === node.id && /^[A-Z]/.test(node.text)) access.add(node.text);
      continue;
    }
    if (parent.type === "generic_name") {
      // `List<T>` as a type, or `Cache<T>.Get()` — but not the method in `Mapper.Map<T>()`.
      const outer = parent.parent;
      const isAccessTarget = outer?.type === "member_access_expression" && field(outer, "expression")?.id === parent.id;
      if (inTypePosition(parent) || inPattern(parent)) refs.add(typeName(parent));
      else if (isAccessTarget) access.add(typeName(parent));
      continue;
    }
    if (inTypePosition(node) || (/^[A-Z]/.test(node.text) && inPattern(node))) refs.add(node.text);
  }
  // `Acme.Util.Helper.Run()` / `Json.Formatting.Indented`: a dotted chain written as member access names a
  // type through its namespace (the resolver finds where the namespace part ends).
  for (const node of pick("member_access_expression")) {
    const parent = node.parent;
    if (parent?.type === "member_access_expression" && field(parent, "expression")?.id === node.id) continue;
    const chain = accessChain(node);
    if (chain && chain.length >= 3 && /^[A-Z]/.test(chain[0])) qualified.add(chain.join("."));
  }
  for (const node of pick("attribute")) {
    const name = field(node, "name");
    if (!name) continue;
    const text = typeName(name);
    collectRoute(node, dotted(name).split(".").pop() ?? text, out);
    // `[Test]` is the class TestAttribute (C# appends the suffix when the name lacks it).
    const segments = text.split(".");
    const last = segments.pop()!;
    const attribute = /Attribute(`\d+)?$/.test(last) ? last : last.replace(/(`\d+)?$/, (arity) => `Attribute${arity}`);
    if (segments.length) {
      qualified.add([...segments, attribute].join("."));
      if (!/^[a-z]/.test(segments[0])) refs.add(segments[0]);
    } else refs.add(attribute);
  }

  // Calls: `Helper.Do()` through a type name, `Do()` bare, `new Thing()`.
  for (const call of pick("invocation_expression")) {
    const callee = field(call, "function");
    if (!callee) continue;
    if (callee.type === "identifier" && callee.text === "nameof") {
      // `nameof(Thing)` / `nameof(Thing.Member)` names the type Thing.
      let target: Node | null = field(call, "arguments")?.namedChildren[0]?.namedChildren[0] ?? null;
      while (target?.type === "member_access_expression") target = field(target, "expression") ?? null;
      if (target?.type === "identifier" && /^[A-Z]/.test(target.text)) refs.add(target.text);
      if (target?.type === "generic_name") refs.add(typeName(target));
      continue;
    }
    if (callee.type === "identifier") out.calls.push({ binding: callee.text, symbol: callee.text, line: startLine(call) });
    else if (callee.type === "member_access_expression") {
      const target = field(callee, "expression");
      const name = field(callee, "name");
      if (target?.type === "identifier" && name) {
        const member = name.type === "generic_name" ? namedChildrenOf(name)[0]?.text ?? name.text : name.text;
        out.calls.push({ binding: target.text, symbol: `${target.text}.${member}`, line: startLine(call) });
      }
    }
  }
  for (const creation of pick("object_creation_expression")) {
    const type = field(creation, "type");
    if (!type) continue;
    const symbol = dotted(type.type === "generic_name" ? namedChildrenOf(type)[0] ?? type : type);
    if (symbol) out.calls.push({ binding: symbol.split(".")[0], symbol, line: startLine(creation) });
  }

  for (const node of pick(["variable_declarator", "property_declaration", "event_declaration", "parameter"])) {
    const name = field(node, "name") ?? namedChildrenOf(node).find((child) => child.type === "identifier");
    if (!name || !/^[A-Z]/.test(name.text)) continue;
    // "Color Color": a member whose type has its own name leaves `Color.Red` meaning the type.
    const declared = node.type === "variable_declarator" ? field(node.parent ?? node, "type") : field(node, "type");
    const typeText = declared ? typeName(declared.type === "nullable_type" ? (namedChildrenOf(declared)[0] ?? declared) : declared) : "";
    if (typeText.split(".").pop() !== name.text) members.add(name.text);
  }
  const partialTopLevel = new Set(out.types.filter((type) => type.partial && !type.outer).map((type) => withArity(type.name, type.arity)));
  out.partialSelfRefs = [...refs].filter((name) => partialTopLevel.has(name)).sort();
  for (const name of locals) refs.delete(name);
  out.namespaces = [...namespaces].sort();
  out.typeRefs = [...refs].filter((name) => name !== "var" && name !== "dynamic" && name !== "nameof").sort();
  out.accessRefs = [...access].filter((name) => !refs.has(name) && !locals.has(name)).sort();
  out.memberNames = [...members].sort();
  out.qualifiedRefs = [...qualified].sort();
  out.localTypes = [...locals].sort();
  return out;
}

/** The namespace a node sits in: the dotted names of every enclosing namespace, outermost first. */
function namespaceOf(node: Node): string {
  const parts: string[] = [];
  for (let current: Node | null = node; current; current = current.parent) {
    if (current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration") {
      const name = field(current, "name");
      if (name) parts.unshift(dotted(name));
    }
  }
  // A file-scoped namespace is a SIBLING of what follows it, not its parent; what precedes it is global.
  const fileScoped = root(node).namedChildren.find((child) => child?.type === "file_scoped_namespace_declaration");
  if (fileScoped && !parts.length && node.startIndex > fileScoped.startIndex) {
    const name = field(fileScoped, "name");
    if (name) parts.push(dotted(name));
  }
  return parts.join(".");
}

function root(node: Node): Node {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function arityOfDeclaration(node: Node): number {
  const parameters = namedChildrenOf(node).find((child) => child.type === "type_parameter_list");
  return parameters ? namedChildrenOf(parameters).filter((child) => child.type === "type_parameter").length : 0;
}

/** The outermost type declaration around a nested one, with its arity. */
function outermostType(node: Node): string | undefined {
  let found: Node | undefined;
  for (let current = node.parent; current; current = current.parent) if (current.type in TYPE_DECLARATIONS) found = current;
  const name = found ? field(found, "name")?.text : undefined;
  return found && name ? withArity(name, arityOfDeclaration(found)) : undefined;
}

/** `A.B.C` written as nested member access → ["A", "B", "C"] (generic segments with arity); else undefined. */
function accessChain(node: Node): string[] | undefined {
  const out: string[] = [];
  let current: Node | null = node;
  while (current?.type === "member_access_expression") {
    const name = field(current, "name");
    if (!name || (name.type !== "identifier" && name.type !== "generic_name")) return undefined;
    out.unshift(typeName(name));
    current = field(current, "expression") ?? null;
  }
  if (current?.type !== "identifier" && current?.type !== "generic_name") return undefined;
  out.unshift(typeName(current));
  return out;
}

/** `x is Foo`, `x is not Foo`, `case Foo:`, `Foo => …` — the grammar reads these as CONSTANT patterns (it
 *  cannot tell a type from a constant), sometimes under a mis-associated `||` chain. */
function inPattern(node: Node): boolean {
  let current: Node = node;
  while (current.parent?.type === "binary_expression" && field(current.parent, "left")?.id === current.id) current = current.parent;
  return current.parent?.type === "constant_pattern";
}

function enclosingTypeName(node: Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type in TYPE_DECLARATIONS) return field(current, "name")?.text;
  }
  return undefined;
}

function hasModifier(node: Node, modifier: string): boolean {
  return namedChildrenOf(node).some((child) => child.type === "modifier" && child.text === modifier);
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  return Boolean(parent && field(parent, "name")?.id === node.id && (parent.type in TYPE_DECLARATIONS || parent.type.endsWith("_declaration") || parent.type === "variable_declarator" || parent.type === "parameter"));
}

/** Is this node written where a TYPE goes? */
function inTypePosition(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (TYPE_LIST_PARENTS.has(parent.type)) return true;
  if (field(parent, "type")?.id === node.id || field(parent, "returns")?.id === node.id) return true;
  // `x as Foo` / `x is Foo` (the type is the right operand).
  if ((parent.type === "as_expression" || parent.type === "is_expression") && field(parent, "right")?.id === node.id) return true;
  return false;
}

function withArity(name: string, arity: number): string {
  return arity > 0 ? `${name}\`${arity}` : name;
}

/** A type name as C# sees it: dotted, each generic segment with its arity (`Acme.Cache\`1`), `global::` dropped. */
function typeName(node: Node): string {
  if (node.type === "generic_name") {
    const name = namedChildrenOf(node).find((child) => child.type === "identifier");
    const args = namedChildrenOf(node).find((child) => child.type === "type_argument_list");
    const count = args ? namedChildrenOf(args).length || (args.text.match(/,/g)?.length ?? 0) + 1 : 0;
    return withArity(name?.text ?? node.text, count);
  }
  if (node.type === "qualified_name" || node.type === "alias_qualified_name") {
    const parts = namedChildrenOf(node).map(typeName).filter((part) => part !== "global");
    return parts.join(".");
  }
  return node.text.replace(/\s+/g, "");
}

/** Dotted text of a name node, without whitespace or type arguments. */
function dotted(node: Node): string {
  return node.text.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "").replace(/\s+/g, "");
}

function collectRoute(attribute: Node, name: string, out: CSharpExtract): void {
  const method = ASPNET_ROUTES[name.replace(/Attribute$/, "")];
  if (!method) return;
  const literal = attribute.descendantsOfType("string_literal")[0];
  if (!literal) return;
  const value = literal.text.replace(/^@?"|"$/g, "");
  if (!value) return;
  out.routes.push({ method, path: value.startsWith("/") ? value : `/${value}`, line: startLine(attribute) });
}

// ── ParsedFile projection (Inventory) ──────────────────────────────────────────────

export function projectCSharp(facts: CSharpExtract): { imports: ParsedImport[]; exports: ParsedExport[]; symbols: ParsedSymbol[] } {
  const imports: ParsedImport[] = facts.usings.map((entry) => ({
    source: entry.target,
    specifiers: entry.alias ? [entry.alias] : [],
    importKind: "static",
    line: entry.line,
    confidence: 1,
  }));
  const symbols: ParsedSymbol[] = [
    ...facts.types.map((type) => ({
      name: type.outer ? `${type.outer}.${type.name}` : type.name,
      kind: (type.kind === "class" || type.kind === "record" || type.kind === "struct" ? "class" : "unknown") as ParsedSymbol["kind"],
      lineStart: type.line,
      lineEnd: type.lineEnd,
      signature: `${type.kind === "struct" ? "class" : type.kind} ${type.name}`,
      exported: type.isPublic,
      confidence: 1,
    })),
    ...facts.methods.map((method) => ({
      name: `${method.owner}.${method.name}`,
      kind: "method" as const,
      lineStart: method.line,
      lineEnd: method.lineEnd,
      exported: method.isPublic,
      confidence: 1,
    })),
  ].sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  const exports: ParsedExport[] = facts.types
    .filter((type) => type.isPublic && !type.outer)
    .map((type) => ({ name: type.name, kind: type.kind === "interface" ? "interface" : type.kind === "class" || type.kind === "record" ? "class" : "type", line: type.line, confidence: 1 }));
  return { imports, exports, symbols };
}
