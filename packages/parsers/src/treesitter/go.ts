import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { endLine, field, namedChildrenOf, signatureOf, startLine } from "./ast.js";

/**
 * Go, from one tree-sitter pass.
 *
 * Go imports name a PACKAGE (a directory), not a file, and a package's files see each other's
 * declarations without importing them. So besides the imports themselves, the resolver needs:
 *   - the file's `package` name (the default binding an importer gets),
 *   - its top-level declarations (so `store.Open` can be pointed at the file that declares `Open`),
 *   - every `x.Y` reference whose root may be an import binding (calls, types, values).
 */

export interface GoImport {
  /** The import path, e.g. `github.com/acme/app/store`. */
  source: string;
  /** Explicit name: an alias, `.` (dot import) or `_` (blank import). Absent = the package's own name. */
  name?: string;
  line: number;
}

export interface GoReference {
  /** The root identifier — `store` in `store.Open`. */
  binding: string;
  /** As written: `store.Open`. */
  symbol: string;
  line: number;
}

export interface GoDeclaration {
  name: string;
  kind: "function" | "type" | "variable" | "constant";
  line: number;
  lineEnd: number;
  signature: string;
}

export interface GoMethod {
  receiver: string;
  name: string;
  line: number;
  lineEnd: number;
  signature: string;
}

export interface GoRoute {
  method: HttpRouteMethod;
  path: string;
  line: number;
}

export interface GoExtract {
  packageName?: string;
  imports: GoImport[];
  declarations: GoDeclaration[];
  methods: GoMethod[];
  references: GoReference[];
  /** Call sites: `binding` is the callee root (`fmt` in `fmt.Println`, `helper` in `helper()`). */
  calls: GoReference[];
  /** Struct/interface embedding of another type (`store.Store` inside a struct). */
  embeds: GoReference[];
  routes: GoRoute[];
}

/** net/http registers handlers for every verb; routers (gin, echo, chi, gorilla) name the verb. */
const GO_ROUTE_METHODS: Record<string, HttpRouteMethod> = {
  handlefunc: "ALL",
  handle: "ALL",
  any: "ALL",
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
};

export function extractGoFacts(tree: Tree): GoExtract {
  const out: GoExtract = {
    imports: [],
    declarations: [],
    methods: [],
    references: [],
    calls: [],
    embeds: [],
    routes: [],
  };
  const root = tree.rootNode;

  for (const node of namedChildrenOf(root)) {
    switch (node.type) {
      case "package_clause": {
        const name = namedChildrenOf(node).find((child) => child.type === "package_identifier");
        if (name) out.packageName = name.text;
        break;
      }
      case "import_declaration":
        for (const spec of node.descendantsOfType("import_spec")) if (spec) collectImport(spec, out);
        break;
      case "function_declaration": {
        const name = field(node, "name");
        if (name) out.declarations.push(declaration(name.text, "function", node));
        break;
      }
      case "method_declaration": {
        const name = field(node, "name");
        const receiver = receiverType(node);
        if (name) {
          out.methods.push({
            receiver: receiver ?? "",
            name: name.text,
            line: startLine(node),
            lineEnd: endLine(node),
            signature: signatureOf(node),
          });
        }
        break;
      }
      case "type_declaration":
        for (const spec of namedChildrenOf(node)) {
          if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
          const name = field(spec, "name");
          if (name) out.declarations.push(declaration(name.text, "type", spec));
        }
        break;
      case "var_declaration":
      case "const_declaration":
        for (const spec of node.descendantsOfType(["var_spec", "const_spec"])) {
          if (!spec) continue;
          for (const name of spec.childrenForFieldName("name")) {
            if (name) out.declarations.push(declaration(name.text, node.type === "var_declaration" ? "variable" : "constant", spec));
          }
        }
        break;
      default:
        break;
    }
  }

  // ONE walk for everything below (each `descendantsOfType` is a full tree walk in wasm, and this
  // used to take four). References keep one entry per distinct name: resolution needs which names
  // a file uses, not how often — Kubernetes files reference fields thousands of times.
  const seenRefs = new Set<string>();
  const fieldEmbeds: GoReference[] = [];
  const elemEmbeds: GoReference[] = [];
  for (const node of root.descendantsOfType(["selector_expression", "qualified_type", "call_expression", "field_declaration", "type_elem"])) {
    if (!node) continue;
    switch (node.type) {
      case "selector_expression":
      case "qualified_type": {
        const ref = qualifiedReference(node);
        if (ref && !seenRefs.has(ref.symbol)) {
          seenRefs.add(ref.symbol);
          out.references.push(ref);
        }
        break;
      }
      case "call_expression": {
        const callee = field(node, "function");
        if (!callee) break;
        if (callee.type === "identifier") {
          out.calls.push({ binding: callee.text, symbol: callee.text, line: startLine(node) });
          break;
        }
        const ref = callee.type === "selector_expression" ? qualifiedReference(callee) : undefined;
        if (!ref) break;
        out.calls.push({ ...ref, line: startLine(node) });
        collectRoute(callee, node, out);
        break;
      }
      case "field_declaration": {
        // Embedding: a struct field that is only a type.
        if (field(node, "name")) break;
        const embedded = embeddedType(field(node, "type"));
        if (embedded) fieldEmbeds.push({ ...embedded, line: startLine(node) });
        break;
      }
      case "type_elem":
        for (const type of namedChildrenOf(node)) {
          const embedded = embeddedType(type);
          if (embedded) elemEmbeds.push({ ...embedded, line: startLine(node) });
        }
        break;
      default:
        break;
    }
  }
  out.embeds.push(...fieldEmbeds, ...elemEmbeds);

  return out;
}

function collectImport(spec: Node, out: GoExtract): void {
  const path = goStringValue(field(spec, "path"));
  if (path === undefined) return;
  const name = field(spec, "name");
  out.imports.push({ source: path, ...(name ? { name: name.text } : {}), line: startLine(spec) });
}

function declaration(name: string, kind: GoDeclaration["kind"], node: Node): GoDeclaration {
  return { name, kind, line: startLine(node), lineEnd: endLine(node), signature: signatureOf(node) };
}

/** `func (s *Server) Run()` → "Server". */
function receiverType(method: Node): string | undefined {
  const receiver = field(method, "receiver");
  const param = receiver ? namedChildrenOf(receiver).find((child) => child.type === "parameter_declaration") : undefined;
  let type = param ? field(param, "type") : undefined;
  while (type && (type.type === "pointer_type" || type.type === "generic_type")) {
    type = type.type === "pointer_type" ? namedChildrenOf(type)[0] : field(type, "type");
  }
  return type?.type === "type_identifier" ? type.text : undefined;
}

/** `pkg.Name` where `pkg` is a bare identifier — the only shape an import binding can take. */
function qualifiedReference(node: Node): GoReference | undefined {
  if (node.type === "qualified_type") {
    const pkg = field(node, "package");
    const name = field(node, "name");
    if (!pkg || !name) return undefined;
    return { binding: pkg.text, symbol: `${pkg.text}.${name.text}`, line: startLine(node) };
  }
  const operand = field(node, "operand");
  const member = field(node, "field");
  if (operand?.type !== "identifier" || !member) return undefined;
  return { binding: operand.text, symbol: `${operand.text}.${member.text}`, line: startLine(node) };
}

function embeddedType(type: Node | undefined): Omit<GoReference, "line"> | undefined {
  let node = type;
  while (node?.type === "pointer_type") node = namedChildrenOf(node)[0];
  if (!node) return undefined;
  if (node.type === "type_identifier") return { binding: node.text, symbol: node.text };
  if (node.type === "qualified_type") {
    const ref = qualifiedReference(node);
    return ref ? { binding: ref.binding, symbol: ref.symbol } : undefined;
  }
  return undefined;
}

function collectRoute(callee: Node, call: Node, out: GoExtract): void {
  const member = field(callee, "field")?.text.toLowerCase();
  const method = member ? GO_ROUTE_METHODS[member] : undefined;
  if (!method) return;
  const args = field(call, "arguments");
  const path = args ? goStringValue(namedChildrenOf(args)[0]) : undefined;
  if (path === undefined || !path.startsWith("/")) return;
  out.routes.push({ method, path, line: startLine(call) });
}

/** A Go string literal's value: "interpreted" or `raw`. Undefined for anything else. */
export function goStringValue(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "raw_string_literal") return node.text.slice(1, -1);
  if (node.type !== "interpreted_string_literal") return undefined;
  const parts: string[] = [];
  for (const child of namedChildrenOf(node)) {
    if (child.type === "interpreted_string_literal_content") parts.push(child.text);
    else return undefined; // an escape sequence — not a plain path
  }
  return parts.join("");
}

// ── ParsedFile projection (Inventory) ──────────────────────────────────────────────

export interface GoParsedExtract {
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
}

/** Exported = starts with an upper-case letter. That is the language rule, not a convention. */
export function isGoExported(name: string): boolean {
  const first = name.codePointAt(0);
  if (first === undefined) return false;
  const char = String.fromCodePoint(first);
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

export function extractGo(tree: Tree): GoParsedExtract {
  return projectGo(extractGoFacts(tree));
}

/** Inventory's view of one Go extract (the same extract Connect's graph facts come from). */
export function projectGo(facts: GoExtract): GoParsedExtract {
  const imports: ParsedImport[] = facts.imports.map((entry) => ({
    source: entry.source,
    specifiers: entry.name ? [entry.name] : [],
    importKind: "static",
    line: entry.line,
    confidence: 1,
  }));

  const symbols: ParsedSymbol[] = [];
  const exports: ParsedExport[] = [];
  for (const decl of facts.declarations) {
    if (decl.name === "_" || decl.name === "init") continue;
    const exported = isGoExported(decl.name);
    const kind: ParsedSymbol["kind"] =
      decl.kind === "function" ? "function" : decl.kind === "type" ? (/\bstruct\b/.test(decl.signature) ? "class" : "unknown") : "variable";
    symbols.push({
      name: decl.name,
      kind,
      lineStart: decl.line,
      lineEnd: decl.lineEnd,
      signature: decl.kind === "type" ? `type ${decl.signature}` : decl.signature,
      exported,
      confidence: 1,
    });
    if (exported) {
      exports.push({
        name: decl.name,
        kind: decl.kind === "function" ? "function" : decl.kind === "type" ? "type" : "variable",
        line: decl.line,
        confidence: 1,
      });
    }
  }
  for (const method of facts.methods) {
    symbols.push({
      name: method.receiver ? `${method.receiver}.${method.name}` : method.name,
      kind: "method",
      lineStart: method.line,
      lineEnd: method.lineEnd,
      signature: method.signature,
      exported: isGoExported(method.name),
      confidence: 1,
    });
  }
  symbols.sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  return { imports, exports, symbols };
}
