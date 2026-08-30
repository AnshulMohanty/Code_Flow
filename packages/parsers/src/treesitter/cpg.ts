import { TREE_SITTER_MAX_BYTES } from "@codeflow/config";
import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, LanguageId } from "@codeflow/shared-types";
import { detectLanguage } from "../language.js";
import type { ParseFileInput } from "../types.js";
import { PARSER_VERSION, TREE_SITTER_PARSER_VERSION } from "../types.js";
import { calleeName, calleeTail, field, namedChildrenOf, startLine, stringValue } from "./ast.js";
import { grammarParser, hasGrammar } from "./runtime.js";

/**
 * One import/require/dynamic/re-export specifier with the LOCAL NAMES it binds. The local
 * names are what call/inheritance sites are matched against, which is how a `foo()` call
 * becomes an edge to the file `foo` was imported from.
 */
export interface CpgImport {
  source: string;
  /** Local binding names introduced by this import (default, namespace, named aliases). */
  specifiers: string[];
  kind: "import" | "require" | "dynamic" | "reexport";
  line: number;
}

/** A call site, recorded by the ROOT local binding it goes through. */
export interface CpgCall {
  /** The root local name — `renderTemplate` for `renderTemplate()`, `utils` for `utils.parse()`. */
  binding: string;
  /** The relationship as written, e.g. `renderTemplate` or `utils.parse`. */
  symbol: string;
  line: number;
}

/** An `extends` / `implements` / Python superclass reference. */
export interface CpgInheritance {
  binding: string;
  symbol: string;
  kind: "extends" | "implements";
  line: number;
}

export interface CpgRoute {
  method: HttpRouteMethod;
  path: string;
  line: number;
  framework: "express" | "flask" | "fastapi" | "unknown";
}

/**
 * Everything the Connect stage needs from ONE tree-sitter pass over a file. Resolution of
 * `source` / `binding` to a repo fileId is deliberately NOT done here: the parsers package
 * stays filesystem-free, and Connect already resolves against the DISCOVERED file set
 * (which is the only correct keyspace).
 */
export interface CpgFacts {
  imports: CpgImport[];
  calls: CpgCall[];
  inheritance: CpgInheritance[];
  routes: CpgRoute[];
  /** `treesitter-v1` ⇒ calls/inheritance/routes are real. `parser-v1` ⇒ imports only. */
  engine: string;
}

/** `export … from "x"` is reported through `imports` with kind `reexport`. */
const REEXPORT_RE = /^\s*export\b[^;]*?\bfrom\s*["']([^"']+)["']/;

/** Express-style HTTP verbs. `use` is a mount point, `all`/`route` match any verb. */
const JS_ROUTE_METHODS: Record<string, HttpRouteMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  all: "ALL",
  route: "ALL",
  use: "USE",
};

/** Objects a route is plausibly declared on. Keeping this tight is what stops
 *  `cache.get("/tmp/x")` from being reported as an HTTP route. */
const JS_ROUTE_OBJECT_RE = /^(?:app|api|server|router|route|routes)$|(?:[Rr]outer|App|api)$/;

const PY_ROUTE_METHODS: Record<string, HttpRouteMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  route: "ALL",
};

/**
 * Extract code-property-graph facts for one file. Uses tree-sitter when a grammar is
 * loaded; otherwise degrades to a REGEX pass that still finds imports + re-exports, so
 * dependency coverage never regresses — only the enrichment (calls/inheritance/routes) is
 * lost, and `engine` says so.
 */
export function extractCpgFacts(input: ParseFileInput, language?: LanguageId): CpgFacts {
  const lang = language ?? detectLanguage(input.path);
  if (hasGrammar(lang) && input.content.length <= TREE_SITTER_MAX_BYTES) {
    const parser = grammarParser(lang);
    if (parser) {
      const tree = parser.parse(input.content);
      if (tree) {
        try {
          return lang === "python" ? pythonFacts(tree) : jsLikeFacts(tree);
        } finally {
          tree.delete();
        }
      }
    }
  }
  return regexFallbackFacts(input, lang);
}

// ── JS / TS / JSX / TSX ───────────────────────────────────────────────────────────────

function jsLikeFacts(tree: Tree): CpgFacts {
  const facts: CpgFacts = { imports: [], calls: [], inheritance: [], routes: [], engine: TREE_SITTER_PARSER_VERSION };
  const root = tree.rootNode;

  for (const statement of namedChildrenOf(root)) {
    if (statement.type === "import_statement") collectJsImport(statement, facts);
    else if (statement.type === "export_statement") collectJsReexport(statement, facts);
  }

  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const callee = field(call, "function");
    if (!callee) continue;

    // `import("./x")` / `require("./x")` are dependencies, not calls into a binding.
    const args = field(call, "arguments");
    const firstArg = args ? namedChildrenOf(args)[0] : undefined;
    const literal = stringValue(firstArg);
    if (callee.type === "import") {
      if (literal !== undefined) facts.imports.push({ source: literal, specifiers: [], kind: "dynamic", line: startLine(call) });
      continue;
    }
    const name = calleeName(callee);
    if (name === "require") {
      if (literal !== undefined) {
        facts.imports.push({ source: literal, specifiers: requireBindings(call), kind: "require", line: startLine(call) });
      }
      continue;
    }
    if (!name) continue;

    if (literal !== undefined) collectJsRoute(callee, name, literal, startLine(call), facts);
    facts.calls.push({ binding: rootBinding(name), symbol: name, line: startLine(call) });
  }

  // `new Foo()` is a call into Foo.
  for (const construction of root.descendantsOfType("new_expression")) {
    if (!construction) continue;
    const name = calleeName(field(construction, "constructor"));
    if (name) facts.calls.push({ binding: rootBinding(name), symbol: name, line: startLine(construction) });
  }

  for (const type of ["class_declaration", "abstract_class_declaration"]) {
    for (const classNode of root.descendantsOfType(type)) {
      if (classNode) collectJsHeritage(classNode, facts);
    }
  }

  return facts;
}

function collectJsImport(statement: Node, facts: CpgFacts): void {
  const line = startLine(statement);

  const requireClause = statement.namedChildren.find((child) => child?.type === "import_require_clause");
  if (requireClause) {
    const source = stringValue(field(requireClause, "source"));
    if (source === undefined) return;
    const name = requireClause.namedChildren.find((child) => child?.type === "identifier")?.text;
    facts.imports.push({ source, specifiers: name ? [name] : [], kind: "require", line });
    return;
  }

  const source = stringValue(field(statement, "source"));
  if (source === undefined) return;
  const clause = statement.namedChildren.find((child) => child?.type === "import_clause");
  facts.imports.push({ source, specifiers: clause ? localBindings(clause) : [], kind: "import", line });
}

/** Local names an import clause binds — default, `* as ns`, and named aliases. */
function localBindings(clause: Node): string[] {
  const names: string[] = [];
  for (const child of namedChildrenOf(clause)) {
    if (child.type === "identifier") {
      names.push(child.text);
    } else if (child.type === "namespace_import") {
      const name = child.namedChildren.find((inner) => inner?.type === "identifier")?.text;
      if (name) names.push(name);
    } else if (child.type === "named_imports") {
      for (const specifier of namedChildrenOf(child)) {
        if (specifier.type !== "import_specifier") continue;
        const local = field(specifier, "alias") ?? field(specifier, "name");
        if (local?.text) names.push(local.text);
      }
    }
  }
  return names;
}

function collectJsReexport(statement: Node, facts: CpgFacts): void {
  const source = stringValue(field(statement, "source"));
  if (source !== undefined) {
    facts.imports.push({ source, specifiers: [], kind: "reexport", line: startLine(statement) });
  }
}

function collectJsHeritage(classNode: Node, facts: CpgFacts): void {
  const heritage = classNode.namedChildren.find((child) => child?.type === "class_heritage");
  if (!heritage) return;
  const line = startLine(classNode);

  for (const clause of namedChildrenOf(heritage)) {
    if (clause.type === "extends_clause") {
      // TS shape: `extends_clause value: (identifier)`; may also carry type arguments.
      const value = field(clause, "value") ?? namedChildrenOf(clause)[0];
      pushHeritage(value, "extends", line, facts);
      continue;
    }
    if (clause.type === "implements_clause") {
      for (const type of namedChildrenOf(clause)) pushHeritage(type, "implements", line, facts);
      continue;
    }
    // Plain JS shape: `class_heritage (identifier)` with no clause wrapper.
    pushHeritage(clause, "extends", line, facts);
  }
}

function pushHeritage(node: Node | undefined, kind: "extends" | "implements", line: number, facts: CpgFacts): void {
  if (!node) return;
  const name =
    node.type === "type_identifier" || node.type === "identifier" ? node.text : calleeName(node);
  if (!name) return;
  facts.inheritance.push({ binding: rootBinding(name), symbol: name, kind, line });
}

function collectJsRoute(callee: Node, name: string, path: string, line: number, facts: CpgFacts): void {
  if (callee.type !== "member_expression") return;
  if (!path.startsWith("/")) return; // a route path is a literal starting with "/" — nothing else
  const method = JS_ROUTE_METHODS[calleeTail(name).toLowerCase()];
  if (!method) return;
  const objectName = calleeName(field(callee, "object")) ?? "";
  const object = calleeTail(objectName);
  facts.routes.push({
    method,
    path,
    line,
    framework: JS_ROUTE_OBJECT_RE.test(object) ? "express" : "unknown",
  });
}

function requireBindings(call: Node): string[] {
  const declarator = call.parent;
  if (declarator?.type !== "variable_declarator") return [];
  const name = field(declarator, "name");
  if (name?.type === "identifier") return [name.text];
  // `const { a, b } = require("x")` binds each destructured name.
  if (name?.type === "object_pattern") {
    const names: string[] = [];
    for (const property of namedChildrenOf(name)) {
      if (property.type === "shorthand_property_identifier_pattern") names.push(property.text);
      else {
        const value = field(property, "value");
        if (value?.type === "identifier") names.push(value.text);
      }
    }
    return names;
  }
  return [];
}

// ── Python ────────────────────────────────────────────────────────────────────────────

function pythonFacts(tree: Tree): CpgFacts {
  const facts: CpgFacts = { imports: [], calls: [], inheritance: [], routes: [], engine: TREE_SITTER_PARSER_VERSION };
  const root = tree.rootNode;

  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!node) continue;
    if (node.type === "import_statement") collectPyImport(node, facts);
    else collectPyFromImport(node, facts);
  }

  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const name = calleeName(field(call, "function"));
    if (!name) continue;
    facts.calls.push({ binding: rootBinding(name), symbol: name, line: startLine(call) });
  }

  for (const classNode of root.descendantsOfType("class_definition")) {
    if (!classNode) continue;
    const superclasses = field(classNode, "superclasses");
    if (!superclasses) continue;
    const line = startLine(classNode);
    for (const base of namedChildrenOf(superclasses)) {
      if (base.type === "keyword_argument") continue; // e.g. `metaclass=ABCMeta`
      const name = base.type === "identifier" ? base.text : calleeName(base);
      if (name) facts.inheritance.push({ binding: rootBinding(name), symbol: name, kind: "extends", line });
    }
  }

  for (const decorator of root.descendantsOfType("decorator")) {
    if (decorator) collectPyRoute(decorator, facts);
  }

  return facts;
}

function collectPyImport(statement: Node, facts: CpgFacts): void {
  const line = startLine(statement);
  for (const child of namedChildrenOf(statement)) {
    if (child.type === "dotted_name") {
      // `import a.b.c` binds the root name `a`.
      facts.imports.push({ source: child.text, specifiers: [rootBinding(child.text)], kind: "import", line });
    } else if (child.type === "aliased_import") {
      const name = field(child, "name");
      const alias = field(child, "alias");
      if (name?.text) {
        facts.imports.push({
          source: name.text,
          specifiers: alias?.text ? [alias.text] : [rootBinding(name.text)],
          kind: "import",
          line,
        });
      }
    }
  }
}

function collectPyFromImport(statement: Node, facts: CpgFacts): void {
  const line = startLine(statement);
  const moduleName = field(statement, "module_name");
  if (!moduleName) return;

  const specifiers: string[] = [];
  for (const child of namedChildrenOf(statement)) {
    if (child.id === moduleName.id) continue;
    if (child.type === "dotted_name") specifiers.push(child.text);
    else if (child.type === "aliased_import") {
      // The LOCAL binding is the alias when present — that is what call sites use.
      const alias = field(child, "alias") ?? field(child, "name");
      if (alias?.text) specifiers.push(alias.text);
    }
  }
  facts.imports.push({ source: moduleName.text, specifiers, kind: "import", line });
}

/** Flask `@app.route("/x", methods=[…])` and FastAPI `@router.get("/x")`. */
function collectPyRoute(decorator: Node, facts: CpgFacts): void {
  const call = namedChildrenOf(decorator).find((child) => child.type === "call");
  if (!call) return;
  const callee = field(call, "function");
  if (callee?.type !== "attribute") return;
  const attribute = field(callee, "attribute")?.text?.toLowerCase();
  if (!attribute) return;
  const method = PY_ROUTE_METHODS[attribute];
  if (!method) return;

  const args = field(call, "arguments");
  if (!args) return;
  const children = namedChildrenOf(args);
  const path = stringValue(children[0]);
  if (path === undefined || !path.startsWith("/")) return;

  const line = startLine(decorator);
  const framework = attribute === "route" ? "flask" : "fastapi";

  // Flask lists the verbs in `methods=[...]` — emit one route per declared verb.
  const methods = declaredPyMethods(children);
  if (methods.length) {
    for (const declared of methods) facts.routes.push({ method: declared, path, line, framework });
    return;
  }
  // Flask's default when `methods` is absent is GET; FastAPI's verb is the attribute.
  facts.routes.push({ method: framework === "flask" ? "GET" : method, path, line, framework });
}

function declaredPyMethods(args: Node[]): HttpRouteMethod[] {
  const methods: HttpRouteMethod[] = [];
  for (const arg of args) {
    if (arg.type !== "keyword_argument") continue;
    if (field(arg, "name")?.text !== "methods") continue;
    const value = field(arg, "value");
    if (!value) continue;
    for (const item of namedChildrenOf(value)) {
      const verb = stringValue(item)?.toUpperCase();
      if (verb && verb in PY_ROUTE_METHODS_BY_LABEL) methods.push(PY_ROUTE_METHODS_BY_LABEL[verb]);
    }
  }
  return methods;
}

const PY_ROUTE_METHODS_BY_LABEL: Record<string, HttpRouteMethod> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  OPTIONS: "OPTIONS",
  HEAD: "HEAD",
};

// ── Regex fallback (imports + re-exports only) ────────────────────────────────────────

/**
 * When no grammar is loaded, dependency coverage must not regress — so imports and
 * re-exports are still extracted, line by line, exactly as before Phase 1. Calls,
 * inheritance and routes are simply absent (they cannot be found reliably without a
 * syntax tree), and `engine: "parser-v1"` records that this file was NOT enriched.
 */
function regexFallbackFacts(input: ParseFileInput, language: LanguageId): CpgFacts {
  const facts: CpgFacts = { imports: [], calls: [], inheritance: [], routes: [], engine: PARSER_VERSION };
  const isPython = language === "python";
  const lines = input.content.split(/\r\n|\r|\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (isPython) {
      const plain = line.trim().match(/^import\s+(.+)$/);
      if (plain) {
        for (const part of plain[1].split(",")) {
          const source = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (source) facts.imports.push({ source, specifiers: [], kind: "import", line: lineNumber });
        }
      }
      const from = line.trim().match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
      if (from) {
        facts.imports.push({
          source: from[1],
          specifiers: from[2].split(",").map((value) => value.trim().split(/\s+as\s+/)[0] ?? value.trim()),
          kind: "import",
          line: lineNumber,
        });
      }
      return;
    }

    const staticImport = line.match(/^\s*import\s+(?:type\s+)?(?:.*?\s+from\s+)?["']([^"']+)["']/);
    if (staticImport) facts.imports.push({ source: staticImport[1], specifiers: [], kind: "import", line: lineNumber });

    const requireImport = line.match(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*["']([^"']+)["']\s*\)/);
    if (requireImport) facts.imports.push({ source: requireImport[1], specifiers: [], kind: "require", line: lineNumber });

    const dynamicImport = line.match(/\bimport\(\s*["']([^"']+)["']\s*\)/);
    if (dynamicImport) facts.imports.push({ source: dynamicImport[1], specifiers: [], kind: "dynamic", line: lineNumber });

    const reexport = line.match(REEXPORT_RE);
    if (reexport) facts.imports.push({ source: reexport[1], specifiers: [], kind: "reexport", line: lineNumber });
  });

  return facts;
}

/** The root of a dotted name — `utils.parse` → `utils`, `foo` → `foo`. */
function rootBinding(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}
