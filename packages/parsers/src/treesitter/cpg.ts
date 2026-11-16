import { TREE_SITTER_MAX_BYTES } from "@codeflow/config";
import type { Node, Tree } from "web-tree-sitter";
import type { HttpRouteMethod, LanguageId } from "@codeflow/shared-types";
import { detectLanguage } from "../language.js";
import {
  PY_FROM_IMPORT_LINE,
  PY_IMPORT_LINE,
  parseStaticImportLine,
  scanGoImports,
  scanJavaImports,
  scanCIncludes,
  scanCSharpUsings,
  splitAliasSegments,
} from "../utils/importScan.js";
import type { ParseFileInput } from "../types.js";
import { PARSER_VERSION, TREE_SITTER_PARSER_VERSION } from "../types.js";
import { calleeName, calleeTail, field, namedChildrenOf, parseableSource, startLine, stringValue } from "./ast.js";
import { throughFactsStore } from "../factsStore.js";
import { extractKey, takeExtract } from "./extractCache.js";
import { extractGoFacts, type GoExtract } from "./go.js";
import { extractCFamilyFacts, type CFamilyExtract } from "./cfamily.js";
import { extractCSharp, type CSharpExtract } from "./csharp.js";
import { extractJavaFacts, type JavaExtract } from "./java.js";
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
  /**
   * Python `from X import a, b as c` only: the IMPORTED names (`a`, `b`), index-aligned with
   * `specifiers` (`a`, `c`). The resolver needs the original name to tell a submodule import
   * (`from . import sessions`) from a symbol import.
   */
  names?: string[];
  kind: "import" | "require" | "dynamic" | "reexport";
  line: number;
  /** Erased at runtime: TS `import type` / `export type … from`, or a Python `if TYPE_CHECKING:` import. */
  typeOnly?: boolean;
  /**
   * Cannot fail at load time: a `require`/`import` inside a function body, or a Java import (the
   * JVM loads a class on first use, so a class cycle is legal and never an import-order failure).
   */
  lazy?: boolean;
  /** Java `import static`. */
  isStatic?: boolean;
  /** C/C++ `#include <x>`: searched only on the include path, never the including file's directory. */
  system?: boolean;
  /** C# `using J = X.Y;` → "J". */
  alias?: string;
  /** C# `global using` — applies to every file of the project. */
  global?: boolean;
  /** C#: the namespace a `using` is written in — its name is looked up from there outwards. */
  scope?: string;
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

/** A top-level declaration (Go): what an importer's `pkg.Name` can point at. */
export interface CpgDeclaration {
  name: string;
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
  /**
   * Go only. A Go import names a package (a directory), so resolving it to the FILES it really
   * depends on needs the package name, the top-level declarations, and every `x.Y` reference
   * (calls, types, values) — not just call sites.
   */
  packageName?: string;
  declarations?: CpgDeclaration[];
  references?: CpgCall[];
  /**
   * Java. A simple type name resolves through the file's own types, single-type imports, the
   * SAME package (no import needed) and on-demand imports — so the resolver needs every type
   * name the file mentions, the names that shadow (its own types, type parameters), and dotted
   * fully-qualified uses (`com.acme.Thing`).
   */
  typeRefs?: string[];
  localTypes?: string[];
  qualifiedRefs?: string[];
  /** Java: names in the extends/implements clauses of top-level types (nested types do not shadow them). */
  headerRefs?: string[];
  /** C#: the namespaces this file declares (types here see their own and every enclosing namespace). */
  namespaces?: string[];
  /** C#: names seen only as `Name.Member`, and the PascalCase members/locals declared in the file. */
  accessRefs?: string[];
  memberNames?: string[];
  /** C#: own top-level partial types the file names — it depends on their other parts. */
  partialSelfRefs?: string[];
  /** C#: nested types, by the fully qualified outermost type that holds them. */
  nestedTypes?: Array<{ outer: string; name: string }>;
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
  return throughFactsStore("facts", lang, input.path, input.content, () => computeCpgFacts(input, lang));
}

function computeCpgFacts(input: ParseFileInput, lang: LanguageId): CpgFacts {
  if (hasGrammar(lang) && input.content.length <= TREE_SITTER_MAX_BYTES) {
    // Go / Java / C/C++: Inventory may already have parsed this exact content — take its extract.
    if (SHARED_EXTRACT.has(lang)) {
      const cached = takeExtract<unknown>(extractKey(lang, input.path, input.content));
      if (cached !== undefined) return factsFromExtract(lang, cached);
    }
    const parser = grammarParser(lang);
    if (parser) {
      const tree = parser.parse(parseableSource(input.content));
      if (tree) {
        try {
          if (lang === "python") return pythonFacts(tree);
          if (SHARED_EXTRACT.has(lang)) return factsFromExtract(lang, extractFor(lang, tree, input.content));
          return jsLikeFacts(tree);
        } finally {
          tree.delete();
        }
      }
    }
  }
  return regexFallbackFacts(input, lang);
}

/** Languages whose Inventory symbols and Connect facts come from ONE extract (so one parse). */
export const SHARED_EXTRACT = new Set<string>(["go", "java", "c", "cpp", "csharp"]);

/** The raw extract for a shared-extract language — what `parseTreeSitterFile` caches for Connect. */
export function extractFor(language: string, tree: Tree, content: string): unknown {
  if (language === "go") return extractGoFacts(tree);
  if (language === "java") return extractJavaFacts(tree);
  if (language === "csharp") return extractCSharp(tree, content);
  return extractCFamilyFacts(tree, content);
}

function factsFromExtract(language: string, extract: unknown): CpgFacts {
  if (language === "go") return goFacts(extract as GoExtract);
  if (language === "java") return javaFacts(extract as JavaExtract);
  if (language === "csharp") return csharpFacts(extract as CSharpExtract);
  return cFamilyFacts(extract as CFamilyExtract);
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
        facts.imports.push({
          source: literal,
          specifiers: requireBindings(call),
          kind: "require",
          line: startLine(call),
          ...(insideFunction(call, JS_FUNCTION_TYPES) ? { lazy: true } : {}),
        });
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
  facts.imports.push({
    source,
    specifiers: clause ? localBindings(clause) : [],
    kind: "import",
    line,
    ...(isTypeOnlyJsImport(statement, clause ?? undefined) ? { typeOnly: true } : {}),
  });
}

/** `import type { A }`, or `import { type A, type B }` where EVERY binding is a type. */
function isTypeOnlyJsImport(statement: Node, clause: Node | undefined): boolean {
  if (/^import\s+type\s/.test(statement.text)) return true;
  if (!clause) return false;
  const children = namedChildrenOf(clause);
  if (children.length !== 1 || children[0].type !== "named_imports") return false;
  const specifiers = namedChildrenOf(children[0]).filter((child) => child.type === "import_specifier");
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/.test(specifier.text));
}

const JS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
]);
const PY_FUNCTION_TYPES = new Set(["function_definition", "lambda"]);

function insideFunction(node: Node, functionTypes: ReadonlySet<string>): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (functionTypes.has(current.type)) return true;
  }
  return false;
}

/** Inside the body of `if TYPE_CHECKING:` (or `typing.TYPE_CHECKING`), not its `else`. */
function insideTypeCheckingBlock(node: Node): boolean {
  let child: Node = node;
  for (let current = node.parent; current; child = current, current = current.parent) {
    if (current.type !== "if_statement") continue;
    const condition = field(current, "condition");
    const consequence = field(current, "consequence");
    if (condition && /\bTYPE_CHECKING\b/.test(condition.text) && consequence && child.id === consequence.id) return true;
  }
  return false;
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
    facts.imports.push({
      source,
      specifiers: [],
      kind: "reexport",
      line: startLine(statement),
      ...(/^export\s+type\s/.test(statement.text) ? { typeOnly: true } : {}),
    });
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
    const before = facts.imports.length;
    if (node.type === "import_statement") collectPyImport(node, facts);
    else collectPyFromImport(node, facts);
    const typeOnly = insideTypeCheckingBlock(node);
    const lazy = insideFunction(node, PY_FUNCTION_TYPES);
    for (const spec of facts.imports.slice(before)) {
      if (typeOnly) spec.typeOnly = true;
      if (lazy) spec.lazy = true;
    }
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
  const names: string[] = [];
  for (const child of namedChildrenOf(statement)) {
    if (child.id === moduleName.id) continue;
    if (child.type === "dotted_name") {
      specifiers.push(child.text);
      names.push(child.text);
    } else if (child.type === "aliased_import") {
      // The LOCAL binding is the alias when present — that is what call sites use.
      const name = field(child, "name");
      const alias = field(child, "alias") ?? name;
      if (alias?.text) {
        specifiers.push(alias.text);
        names.push(name?.text ?? alias.text);
      }
    }
  }
  facts.imports.push({ source: moduleName.text, specifiers, names, kind: "import", line });
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

// ── Go ────────────────────────────────────────────────────────────────────────────────

function goFacts(extract: GoExtract): CpgFacts {
  return {
    // `specifiers` carries the explicit name only (alias, `.` or `_`); the default binding is
    // the TARGET package's name, which only the resolver knows.
    imports: extract.imports.map((entry) => ({
      source: entry.source,
      specifiers: entry.name ? [entry.name] : [],
      kind: "import" as const,
      line: entry.line,
    })),
    calls: extract.calls,
    inheritance: extract.embeds.map((embed) => ({ ...embed, kind: "extends" as const })),
    routes: extract.routes.map((route) => ({ ...route, framework: "unknown" as const })),
    engine: TREE_SITTER_PARSER_VERSION,
    ...(extract.packageName ? { packageName: extract.packageName } : {}),
    declarations: extract.declarations.map((decl) => ({ name: decl.name, line: decl.line })),
    references: extract.references,
  };
}

// ── Java ──────────────────────────────────────────────────────────────────────────────

function javaFacts(extract: JavaExtract): CpgFacts {
  return {
    imports: extract.imports.map((entry) => ({
      source: entry.source,
      // The local name a single-type or static import introduces; on-demand imports bind per use.
      specifiers: entry.source.endsWith(".*") ? [] : [entry.source.split(".").pop() ?? entry.source],
      kind: "import" as const,
      line: entry.line,
      lazy: true,
      ...(entry.isStatic ? { isStatic: true } : {}),
    })),
    calls: extract.calls,
    inheritance: extract.inheritance,
    routes: extract.routes.map((route) => ({ ...route, framework: "unknown" as const })),
    engine: TREE_SITTER_PARSER_VERSION,
    ...(extract.packageName ? { packageName: extract.packageName } : {}),
    declarations: extract.types.filter((type) => !type.outer).map((type) => ({ name: type.name, line: type.line })),
    typeRefs: extract.typeRefs,
    localTypes: extract.localTypes,
    qualifiedRefs: extract.qualifiedRefs,
    headerRefs: extract.headerRefs,
  };
}

// ── C# ────────────────────────────────────────────────────────────────────────────────

function csharpFacts(extract: CSharpExtract): CpgFacts {
  return {
    imports: extract.usings.map((entry) => ({
      source: entry.target,
      specifiers: entry.alias ? [entry.alias] : [],
      kind: "import" as const,
      line: entry.line,
      // The CLR loads a type on first use: a type cycle is legal, never a load-time failure.
      lazy: true,
      ...(entry.kind === "static" ? { isStatic: true } : {}),
      ...(entry.alias ? { alias: entry.alias } : {}),
      ...(entry.global ? { global: true } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
    })),
    calls: extract.calls,
    inheritance: extract.inheritance,
    routes: extract.routes.map((route) => ({ ...route, framework: "unknown" as const })),
    engine: TREE_SITTER_PARSER_VERSION,
    namespaces: extract.namespaces,
    // Top-level types, fully qualified: what other files can reach by namespace.
    declarations: extract.types
      .filter((type) => !type.outer)
      .map((type) => {
        const name = type.arity > 0 ? `${type.name}\`${type.arity}` : type.name;
        return { name: type.namespace ? `${type.namespace}.${name}` : name, line: type.line };
      }),
    typeRefs: extract.typeRefs,
    localTypes: extract.localTypes,
    qualifiedRefs: extract.qualifiedRefs,
    partialSelfRefs: extract.partialSelfRefs,
    accessRefs: extract.accessRefs,
    memberNames: extract.memberNames,
    nestedTypes: extract.types
      .filter((type) => type.outermost)
      .map((type) => ({
        outer: type.namespace ? `${type.namespace}.${type.outermost}` : type.outermost!,
        name: type.arity > 0 ? `${type.name}\`${type.arity}` : type.name,
      })),
  };
}

// ── C / C++ ───────────────────────────────────────────────────────────────────────────

function cFamilyFacts(extract: CFamilyExtract): CpgFacts {
  return {
    imports: extract.includes.map((entry) => ({
      source: entry.path,
      specifiers: [],
      kind: "import" as const,
      line: entry.line,
      ...(entry.system ? { system: true } : {}),
    })),
    calls: extract.calls,
    inheritance: extract.inheritance,
    routes: [],
    engine: TREE_SITTER_PARSER_VERSION,
    // Non-static function DEFINITIONS: C's one flat namespace, what a call by name can reach.
    declarations: extract.functions
      .filter((fn) => !fn.isStatic && !fn.qualifiedName.includes("::"))
      .map((fn) => ({ name: fn.name, line: fn.line })),
  };
}

// ── Regex fallback (imports + re-exports only) ────────────────────────────────────────

/**
 * When no grammar is loaded, dependency coverage must not regress — so imports and
 * re-exports are still extracted, line by line, exactly as before Phase 1. Calls,
 * inheritance and routes are simply absent (they cannot be found reliably without a
 * syntax tree), and `engine: "parser-v1"` records that this file was NOT enriched.
 */
function regexFallbackFacts(input: ParseFileInput, language: LanguageId): CpgFacts {
  const facts: CpgFacts = { imports: [], calls: [], inheritance: [], routes: [], engine: PARSER_VERSION };
  if (language === "csharp") {
    for (const entry of scanCSharpUsings(input.content)) {
      facts.imports.push({
        source: entry.target,
        specifiers: entry.alias ? [entry.alias] : [],
        kind: "import",
        line: entry.line,
        lazy: true,
        ...(entry.kind === "static" ? { isStatic: true } : {}),
        ...(entry.alias ? { alias: entry.alias } : {}),
        ...(entry.global ? { global: true } : {}),
      });
    }
    const namespace = /^\s*namespace\s+([\w.]+)/m.exec(input.content)?.[1];
    if (namespace) facts.namespaces = [namespace];
    return facts;
  }
  if (language === "c" || language === "cpp") {
    for (const entry of scanCIncludes(input.content)) {
      facts.imports.push({ source: entry.path, specifiers: [], kind: "import", line: entry.line, ...(entry.system ? { system: true } : {}) });
    }
    return facts;
  }
  if (language === "java") {
    for (const entry of scanJavaImports(input.content)) {
      facts.imports.push({
        source: entry.source,
        specifiers: entry.source.endsWith(".*") ? [] : [entry.source.split(".").pop() ?? entry.source],
        kind: "import",
        line: entry.line,
        lazy: true,
        ...(entry.isStatic ? { isStatic: true } : {}),
      });
    }
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(input.content);
    if (pkg) facts.packageName = pkg[1];
    // A public top-level type must be named after its file — the one declaration knowable without a parse.
    const stem = input.path.slice(input.path.lastIndexOf("/") + 1).replace(/\.java$/, "");
    facts.declarations = [{ name: stem, line: 1 }];
    return facts;
  }
  if (language === "go") {
    for (const entry of scanGoImports(input.content)) {
      facts.imports.push({ source: entry.source, specifiers: entry.name ? [entry.name] : [], kind: "import", line: entry.line });
    }
    return facts;
  }
  const isPython = language === "python";
  const lines = input.content.split(/\r\n|\r|\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (isPython) {
      const plain = PY_IMPORT_LINE.exec(line.trim());
      if (plain) {
        for (const part of plain[1].split(",")) {
          const source = splitAliasSegments(part)[0]?.trim();
          if (source) facts.imports.push({ source, specifiers: [], kind: "import", line: lineNumber });
        }
      }
      const from = PY_FROM_IMPORT_LINE.exec(line.trim());
      if (from) {
        const names = from[2]
          .split(",")
          .map((value) => (splitAliasSegments(value)[0] ?? value).replace(/[()]/g, "").trim())
          .filter(Boolean);
        facts.imports.push({ source: from[1], specifiers: names, names, kind: "import", line: lineNumber });
      }
      return;
    }

    const staticImport = parseStaticImportLine(line);
    if (staticImport) facts.imports.push({ source: staticImport.source, specifiers: [], kind: "import", line: lineNumber });

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
