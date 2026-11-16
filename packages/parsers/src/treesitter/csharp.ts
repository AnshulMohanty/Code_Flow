import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { collectByType, endLine, field, namedChildrenOf, startLine } from "./ast.js";

/**
 * C#, from one tree-sitter pass.
 *
 * A C# file names NAMESPACES, not files: `using Acme.Core;` makes every type of that namespace
 * visible, and a type is also visible from its own namespace and every enclosing one — with no
 * `using` at all. Types can be split across files (`partial`). So the resolver needs each file's
 * namespaces, its declared types, its `using` directives (plain, `static`, aliases, `global`), and
 * every type name the file mentions. The grammar has no separate type-identifier node, so a type
 * use is an identifier in a TYPE POSITION (a declaration's type, a base list, a generic argument, a
 * cast/`is`/`typeof`, an attribute, or `Type.Member`).
 */

export interface CSharpUsing {
  /** `Acme.Core`, or for `using static` / an alias the type or namespace named. */
  target: string;
  kind: "namespace" | "static" | "alias";
  /** `using J = Newtonsoft.Json;` → "J". */
  alias?: string;
  /** `global using` applies to every file of the project. */
  global: boolean;
  line: number;
}

export interface CSharpType {
  name: string;
  kind: "class" | "struct" | "interface" | "enum" | "record" | "delegate";
  namespace: string;
  /** Enclosing type for a nested type. */
  outer?: string;
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
  /** Simple type names used (root of a dotted use whose root is a type). */
  typeRefs: string[];
  /** Dotted names used in type positions — `Acme.Core.Models.User` — resolved as fully qualified. */
  qualifiedRefs: string[];
  /** Names that shadow other types inside this file: its own types and type parameters. */
  localTypes: string[];
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

export function extractCSharpFacts(tree: Tree): CSharpExtract {
  const out: CSharpExtract = {
    usings: [],
    namespaces: [],
    types: [],
    methods: [],
    typeRefs: [],
    qualifiedRefs: [],
    localTypes: [],
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
    "attribute",
  ]);
  const refs = new Set<string>();
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
      target: dotted(target),
      kind: alias ? "alias" : /\busing\s+static\b/.test(text) ? "static" : "namespace",
      ...(alias ? { alias: alias.text } : {}),
      global: /^\s*global\s+using\b/.test(text),
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
    out.types.push({
      name: name.text,
      kind: TYPE_DECLARATIONS[node.type],
      namespace: namespaceOf(node),
      ...(outer ? { outer } : {}),
      isPublic: hasModifier(node, "public"),
      partial: hasModifier(node, "partial"),
      line: startLine(node),
      lineEnd: endLine(node),
    });
    locals.add(name.text);
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
    const text = dotted(node);
    const rootName = text.split(".")[0];
    if (/^[a-z]/.test(rootName) || rootName === "global") qualified.add(text.replace(/^global::/, ""));
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
      if (field(parent, "expression")?.id === node.id && /^[A-Z]/.test(node.text)) refs.add(node.text);
      continue;
    }
    if (parent.type === "generic_name") {
      if (inTypePosition(parent) || parent.parent?.type === "member_access_expression") refs.add(node.text);
      continue;
    }
    if (inTypePosition(node)) refs.add(node.text);
  }
  for (const node of pick("attribute")) {
    const name = field(node, "name");
    if (!name) continue;
    const text = dotted(name);
    refs.add(text.split(".")[0]);
    collectRoute(node, text.split(".").pop() ?? text, out);
  }

  // Calls: `Helper.Do()` through a type name, `Do()` bare, `new Thing()`.
  for (const call of pick("invocation_expression")) {
    const callee = field(call, "function");
    if (!callee) continue;
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

  for (const name of locals) refs.delete(name);
  out.namespaces = [...namespaces].sort();
  out.typeRefs = [...refs].filter((name) => name !== "var" && name !== "dynamic" && name !== "nameof").sort();
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
  // A file-scoped namespace is a SIBLING of the types after it, not their parent.
  const fileScoped = root(node).namedChildren.find((child) => child?.type === "file_scoped_namespace_declaration");
  if (fileScoped && !parts.length) {
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
  return false;
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
