import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { endLine, field, namedChildrenOf, startLine } from "./ast.js";

/**
 * Java, from one tree-sitter pass.
 *
 * Java resolves a simple type name in this order: types declared in the file, single-type
 * imports, types of the SAME package (no import needed), then on-demand (`.*`) imports. So the
 * resolver needs more than the import list: the package, the top-level types (what other files
 * can reach), the names declared here (they shadow), and every type name the file mentions.
 */

export interface JavaImport {
  /** `a.b.C`, `a.b.*`, or for a static import `a.b.C.member` / `a.b.C.*`. */
  source: string;
  isStatic: boolean;
  line: number;
}

export interface JavaReference {
  /** Root simple name: `Util` in `Util.call()`, `Strings` in `Strings.Helper`. */
  binding: string;
  symbol: string;
  line: number;
}

export interface JavaType {
  name: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  line: number;
  lineEnd: number;
  isPublic: boolean;
  /** Enclosing type for a nested type, e.g. `Outer` for `Outer.Inner`. */
  outer?: string;
}

export interface JavaMethod {
  owner: string;
  name: string;
  line: number;
  lineEnd: number;
  isPublic: boolean;
  isMain: boolean;
}

export interface JavaRoute {
  method: HttpRouteMethod;
  path: string;
  line: number;
}

export interface JavaExtract {
  packageName?: string;
  imports: JavaImport[];
  /** Every declared type, top-level and nested. */
  types: JavaType[];
  methods: JavaMethod[];
  /** Simple type names this file mentions (types, `new X`, `X.member`, annotations). */
  typeRefs: string[];
  /** Dotted names whose root is lower-case — a fully qualified type such as `com.acme.Thing`. */
  qualifiedRefs: string[];
  /** Names that shadow other types inside this file: its own types and type parameters. */
  localTypes: string[];
  /**
   * Type names in the `extends`/`implements` clauses of TOP-LEVEL types. A nested type is in
   * scope only inside its class BODY, so it cannot shadow these (commons-lang's `CompareToBuilder
   * implements Builder<Integer>` while declaring a nested `Builder`).
   */
  headerRefs: string[];
  calls: JavaReference[];
  inheritance: Array<JavaReference & { kind: "extends" | "implements" }>;
  routes: JavaRoute[];
}

const TYPE_DECLARATIONS: Record<string, JavaType["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

/** Spring's mapping annotations. `RequestMapping` without an explicit method matches any verb. */
const SPRING_ROUTES: Record<string, HttpRouteMethod> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: "ALL",
};

export function extractJavaFacts(tree: Tree): JavaExtract {
  const out: JavaExtract = {
    imports: [],
    types: [],
    methods: [],
    typeRefs: [],
    qualifiedRefs: [],
    localTypes: [],
    headerRefs: [],
    calls: [],
    inheritance: [],
    routes: [],
  };
  const root = tree.rootNode;
  const refs = new Set<string>();
  const qualified = new Set<string>();
  const locals = new Set<string>();
  const headers = new Set<string>();

  for (const node of namedChildrenOf(root)) {
    if (node.type === "package_declaration") {
      const name = namedChildrenOf(node).find((child) => child.type === "scoped_identifier" || child.type === "identifier");
      if (name) out.packageName = name.text;
    } else if (node.type === "import_declaration") {
      const name = namedChildrenOf(node).find((child) => child.type === "scoped_identifier" || child.type === "identifier");
      if (!name) continue;
      const wildcard = namedChildrenOf(node).some((child) => child.type === "asterisk");
      out.imports.push({
        source: wildcard ? `${name.text}.*` : name.text,
        isStatic: /^import\s+static\b/.test(node.text),
        line: startLine(node),
      });
    }
  }

  // Declared types, with their nesting, and the methods inside them.
  for (const node of root.descendantsOfType(Object.keys(TYPE_DECLARATIONS))) {
    if (!node) continue;
    const name = field(node, "name");
    if (!name) continue;
    const outer = enclosingTypeName(node);
    out.types.push({
      name: name.text,
      kind: TYPE_DECLARATIONS[node.type],
      line: startLine(node),
      lineEnd: endLine(node),
      isPublic: hasModifier(node, "public"),
      ...(outer ? { outer } : {}),
    });
    locals.add(name.text);
  }
  for (const node of root.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    if (!node) continue;
    const name = field(node, "name");
    const owner = enclosingTypeName(node);
    if (!name || !owner) continue;
    const isMain =
      node.type === "method_declaration" &&
      name.text === "main" &&
      hasModifier(node, "static") &&
      /\(\s*(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)/.test(node.text.slice(0, 200));
    out.methods.push({
      owner,
      name: name.text,
      line: startLine(node),
      lineEnd: endLine(node),
      isPublic: hasModifier(node, "public"),
      isMain,
    });
  }
  for (const param of root.descendantsOfType("type_parameter")) {
    const name = param ? namedChildrenOf(param).find((child) => child.type === "type_identifier" || child.type === "identifier") : undefined;
    if (name) locals.add(name.text);
  }

  // Type names mentioned anywhere: plain and scoped type identifiers.
  for (const node of root.descendantsOfType(["type_identifier", "scoped_type_identifier"])) {
    if (!node || node.parent?.type === "scoped_type_identifier") continue; // the outermost scoped name covers it
    if (node.type === "type_identifier") {
      if (node.parent?.type !== "type_parameter") refs.add(node.text);
      continue;
    }
    const dotted = node.text.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
    const rootName = dotted.split(".")[0];
    if (/^[a-z]/.test(rootName)) qualified.add(dotted);
    else refs.add(rootName);
  }

  // `Util.call()`, `Foo.BAR`, `new Foo()` (covered by type_identifier), annotations.
  for (const call of root.descendantsOfType("method_invocation")) {
    if (!call) continue;
    const name = field(call, "name");
    const object = field(call, "object");
    if (!name) continue;
    if (!object) {
      out.calls.push({ binding: name.text, symbol: name.text, line: startLine(call) });
      continue;
    }
    if (object.type === "identifier") {
      if (/^[A-Z]/.test(object.text)) refs.add(object.text);
      out.calls.push({ binding: object.text, symbol: `${object.text}.${name.text}`, line: startLine(call) });
    } else if (object.type === "field_access" && /^[a-z]/.test(object.text)) {
      qualified.add(object.text);
    }
  }
  // `CookieRoute::handle` — a method reference through a type name.
  for (const reference of root.descendantsOfType("method_reference")) {
    const target = reference ? namedChildrenOf(reference)[0] : undefined;
    if (target?.type === "identifier" && /^[A-Z]/.test(target.text)) refs.add(target.text);
  }
  for (const access of root.descendantsOfType("field_access")) {
    const object = access ? field(access, "object") : undefined;
    if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) refs.add(object.text);
  }
  for (const creation of root.descendantsOfType("object_creation_expression")) {
    const type = creation ? field(creation, "type") : undefined;
    const name = type ? simpleTypeName(type) : undefined;
    if (creation && name) out.calls.push({ binding: name.split(".")[0], symbol: name, line: startLine(creation) });
  }
  for (const annotation of root.descendantsOfType(["marker_annotation", "annotation"])) {
    if (!annotation) continue;
    const name = field(annotation, "name");
    if (!name) continue;
    if (name.type === "identifier") refs.add(name.text);
    else if (/^[a-z]/.test(name.text)) qualified.add(name.text);
    else refs.add(name.text.split(".")[0]);
    collectRoute(annotation, name.text, out);
  }

  // extends / implements.
  for (const node of root.descendantsOfType(["superclass", "super_interfaces", "extends_interfaces"])) {
    if (!node) continue;
    const kind = node.type === "super_interfaces" ? "implements" : "extends";
    for (const type of node.descendantsOfType(["type_identifier", "scoped_type_identifier"])) {
      if (!type || type.parent?.type === "scoped_type_identifier" || type.parent?.type === "type_arguments") continue;
      const name = simpleTypeName(type);
      if (!name) continue;
      out.inheritance.push({ binding: name.split(".")[0], symbol: name, kind, line: startLine(node) });
      // Header of a top-level type: resolved outside the class body (see `headerRefs`).
      // A dotted name with a lower-case root is fully qualified (`com.acme.Api`), not a simple name.
      const rootName = name.split(".")[0];
      if (node.parent?.parent?.type === "program" && (!name.includes(".") || /^[A-Z]/.test(rootName))) headers.add(rootName);
    }
  }

  out.typeRefs = [...refs].sort();
  out.qualifiedRefs = [...qualified].sort();
  out.localTypes = [...locals].sort();
  out.headerRefs = [...headers].sort();
  return out;
}

function enclosingTypeName(node: Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type in TYPE_DECLARATIONS) return field(current, "name")?.text;
  }
  return undefined;
}

function hasModifier(node: Node, modifier: string): boolean {
  const modifiers = namedChildrenOf(node).find((child) => child.type === "modifiers");
  return modifiers ? new RegExp(`\\b${modifier}\\b`).test(modifiers.text) : false;
}

function simpleTypeName(node: Node): string | undefined {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier") return node.text.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  if (node.type === "generic_type") {
    const inner = namedChildrenOf(node)[0];
    return inner ? simpleTypeName(inner) : undefined;
  }
  return undefined;
}

function collectRoute(annotation: Node, name: string, out: JavaExtract): void {
  const method = SPRING_ROUTES[name.split(".").pop() ?? ""];
  if (!method) return;
  const args = namedChildrenOf(annotation).find((child) => child.type === "annotation_argument_list");
  if (!args) return;
  // `@GetMapping("/x")` or `@GetMapping(value = "/x")` / `path = "/x"`.
  for (const literal of args.descendantsOfType("string_literal")) {
    if (!literal) continue;
    const parent = literal.parent;
    if (parent?.type === "element_value_pair") {
      const key = field(parent, "key")?.text;
      if (key !== "value" && key !== "path") continue;
    }
    const path = literal.text.replace(/^"|"$/g, "");
    if (path.startsWith("/")) {
      out.routes.push({ method, path, line: startLine(annotation) });
      return;
    }
  }
}

// ── ParsedFile projection (Inventory) ──────────────────────────────────────────────

export interface JavaParsedExtract {
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
}

export function extractJava(tree: Tree): JavaParsedExtract {
  const facts = extractJavaFacts(tree);
  const imports: ParsedImport[] = facts.imports.map((entry) => ({
    source: entry.source,
    specifiers: [entry.source.split(".").pop() ?? entry.source],
    importKind: "static",
    line: entry.line,
    confidence: 1,
  }));
  const symbols: ParsedSymbol[] = [];
  const exports: ParsedExport[] = [];
  for (const type of facts.types) {
    const qualifiedName = type.outer ? `${type.outer}.${type.name}` : type.name;
    symbols.push({
      name: qualifiedName,
      kind: type.kind === "class" || type.kind === "record" ? "class" : "unknown",
      lineStart: type.line,
      lineEnd: type.lineEnd,
      // Inventory recovers interface / enum kinds from a signature that starts with the keyword.
      signature: `${type.kind === "annotation" ? "@interface" : type.kind} ${type.name}`,
      exported: type.isPublic,
      confidence: 1,
    });
    if (type.isPublic && !type.outer) {
      exports.push({ name: type.name, kind: type.kind === "interface" ? "interface" : type.kind === "class" || type.kind === "record" ? "class" : "type", line: type.line, confidence: 1 });
    }
  }
  for (const method of facts.methods) {
    symbols.push({
      name: `${method.owner}.${method.name}`,
      kind: "method",
      lineStart: method.line,
      lineEnd: method.lineEnd,
      exported: method.isPublic,
      confidence: 1,
    });
  }
  symbols.sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  return { imports, exports, symbols };
}
