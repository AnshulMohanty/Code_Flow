import type { Node, Tree } from "web-tree-sitter";
import type { ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { isPascalCase, isReactHookName } from "../utils/symbolUtils.js";
import {
  calleeName,
  endLine,
  field,
  firstChildOfType,
  namedChildrenOf,
  signatureOf,
  startLine,
  stringValue,
} from "./ast.js";

/**
 * What one tree-sitter pass over a JS/TS/JSX/TSX file yields. `imports`/`exports`/
 * `symbols` fill the (unchanged) `ParsedFile` contract; `reexports` are kept SEPARATE
 * because `ParsedImport.importKind` has no re-export member and Connect classifies
 * re-export edges itself — folding them into `imports` would double-count edges.
 */
export interface JsLikeExtract {
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
  /** `export … from "x"` — a dependency, not an import binding. */
  reexports: Array<{ source: string; line: number }>;
}

/** Declarations that carry a `name` field and become one symbol. */
const FUNCTION_DECLARATIONS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature", // TS `declare function f(): void`
]);
const CLASS_DECLARATIONS = new Set(["class_declaration", "abstract_class_declaration"]);
const VARIABLE_DECLARATIONS = new Set(["lexical_declaration", "variable_declaration"]);
/** TS type-level declarations. Emitted as `kind: "unknown"` + a signature so Inventory's
 *  `inferKindFromSignature` recovers interface / type / enum — the same protocol the
 *  regex TypeScript parser used, so the downstream contract is unchanged. */
const TYPE_DECLARATIONS = new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]);

export function extractJsLike(tree: Tree, resolveSource: (source: string) => string | undefined): JsLikeExtract {
  const out: JsLikeExtract = { imports: [], exports: [], symbols: [], reexports: [] };
  const root = tree.rootNode;

  // ── Top-level declarations (program scope, plus anything an `export` wraps) ────────
  for (const statement of namedChildrenOf(root)) {
    collectTopLevel(statement, out, false);
  }

  // ── Imports that are EXPRESSIONS, not statements: `require(...)` and `import(...)`.
  //    These can appear at any depth, so they need a full walk (the regex parser only saw
  //    them when they sat alone on a line).
  collectExpressionImports(root, out, resolveSource);

  return out;
}

// ── Statements ────────────────────────────────────────────────────────────────────────

function collectTopLevel(statement: Node, out: JsLikeExtract, exported: boolean): void {
  switch (statement.type) {
    case "import_statement":
      collectImportStatement(statement, out);
      return;
    case "export_statement":
      collectExportStatement(statement, out);
      return;
    case "ambient_declaration": {
      // `declare function f(): void` / `declare class C {}`
      for (const child of namedChildrenOf(statement)) collectTopLevel(child, out, exported);
      return;
    }
    default:
      collectDeclaration(statement, out, exported, statement);
  }
}

function collectImportStatement(statement: Node, out: JsLikeExtract): void {
  const line = startLine(statement);

  // TS `import x = require("y")` — a require in import clothing.
  const requireClause = firstChildOfType(statement, "import_require_clause");
  if (requireClause) {
    const source = stringValue(field(requireClause, "source"));
    if (source === undefined) return;
    const name = firstChildOfType(requireClause, "identifier")?.text;
    out.imports.push(makeImport(source, name ? [name] : [], "commonjs", line));
    return;
  }

  const source = stringValue(field(statement, "source"));
  if (source === undefined) return;
  const clause = firstChildOfType(statement, "import_clause");
  out.imports.push(makeImport(source, clause ? importSpecifiers(clause) : [], "static", line));
}

/** Default first, then namespace, then named (alias wins) — the order the regex parser
 *  produced, so specifier lists stay comparable. */
function importSpecifiers(clause: Node): string[] {
  const specifiers: string[] = [];
  for (const child of namedChildrenOf(clause)) {
    if (child.type === "identifier") {
      specifiers.push(child.text); // default import
    } else if (child.type === "namespace_import") {
      const name = firstChildOfType(child, "identifier")?.text;
      if (name) specifiers.push(name);
    } else if (child.type === "named_imports") {
      for (const specifier of namedChildrenOf(child)) {
        if (specifier.type !== "import_specifier") continue;
        const local = field(specifier, "alias") ?? field(specifier, "name");
        if (local?.text) specifiers.push(local.text);
      }
    }
  }
  return specifiers;
}

function collectExportStatement(statement: Node, out: JsLikeExtract): void {
  const line = startLine(statement);
  const source = stringValue(field(statement, "source"));

  // `export … from "x"` — a re-export dependency.
  if (source !== undefined) out.reexports.push({ source, line });

  const clause = firstChildOfType(statement, "export_clause");
  if (clause) {
    for (const specifier of namedChildrenOf(clause)) {
      if (specifier.type !== "export_specifier") continue;
      const exportedName = field(specifier, "alias") ?? field(specifier, "name");
      if (exportedName?.text) {
        out.exports.push({ name: exportedName.text, kind: "unknown", line, confidence: 1 });
      }
    }
    return;
  }

  const declaration = field(statement, "declaration");
  if (declaration) {
    collectDeclaration(declaration, out, true, statement);
    for (const exportEntry of exportsForDeclaration(declaration, line)) out.exports.push(exportEntry);
  }
}

function exportsForDeclaration(declaration: Node, line: number): ParsedExport[] {
  const kind = exportKindFor(declaration.type);
  const entries: ParsedExport[] = [];
  if (VARIABLE_DECLARATIONS.has(declaration.type)) {
    for (const declarator of namedChildrenOf(declaration)) {
      if (declarator.type !== "variable_declarator") continue;
      const name = field(declarator, "name");
      if (name?.type === "identifier") entries.push({ name: name.text, kind: "variable", line, confidence: 1 });
    }
    return entries;
  }
  const name = field(declaration, "name");
  if (name?.text) entries.push({ name: name.text, kind, line, confidence: 1 });
  return entries;
}

function exportKindFor(type: string): ParsedExport["kind"] {
  if (FUNCTION_DECLARATIONS.has(type)) return "function";
  if (CLASS_DECLARATIONS.has(type)) return "class";
  if (type === "interface_declaration") return "interface";
  if (type === "type_alias_declaration") return "type";
  return "unknown"; // enum / anything else the union has no member for
}

// ── Declarations → symbols ────────────────────────────────────────────────────────────

/** `owner` is the outermost statement, so a signature includes any `export ` prefix. */
function collectDeclaration(declaration: Node, out: JsLikeExtract, exported: boolean, owner: Node): void {
  const type = declaration.type;

  if (FUNCTION_DECLARATIONS.has(type)) {
    pushNamed(declaration, out, "function", exported, owner);
    return;
  }
  if (CLASS_DECLARATIONS.has(type)) {
    pushNamed(declaration, out, "class", exported, owner);
    collectClassMembers(declaration, out);
    return;
  }
  if (TYPE_DECLARATIONS.has(type)) {
    // kind "unknown" + signature — Inventory recovers interface/type/enum from it.
    pushNamed(declaration, out, "unknown", exported, owner, false);
    return;
  }
  if (VARIABLE_DECLARATIONS.has(type)) {
    collectVariableDeclaration(declaration, out, exported, owner);
    return;
  }
}

function collectVariableDeclaration(declaration: Node, out: JsLikeExtract, exported: boolean, owner: Node): void {
  for (const declarator of namedChildrenOf(declaration)) {
    if (declarator.type !== "variable_declarator") continue;
    const name = field(declarator, "name");
    // Destructuring (`const { a } = …`) has no single symbol name — skip rather than invent.
    if (name?.type !== "identifier") continue;
    const value = field(declarator, "value");
    const isFunction = value?.type === "arrow_function" || value?.type === "function_expression";
    out.symbols.push({
      name: name.text,
      kind: isFunction ? namedKind(name.text, "function") : "variable",
      lineStart: startLine(declarator),
      lineEnd: endLine(declarator),
      signature: signatureOf(owner),
      exported,
      confidence: 1,
    });
  }
}

function collectClassMembers(classDeclaration: Node, out: JsLikeExtract): void {
  const body = field(classDeclaration, "body");
  if (!body) return;
  for (const member of namedChildrenOf(body)) {
    if (member.type !== "method_definition" && member.type !== "method_signature") continue;
    const name = field(member, "name");
    if (!name?.text) continue;
    out.symbols.push({
      name: name.text,
      kind: "method", // no hook/component renaming for members — they are not components
      lineStart: startLine(member),
      lineEnd: endLine(member),
      signature: signatureOf(member),
      exported: false,
      confidence: 1,
    });
  }
}

function pushNamed(
  declaration: Node,
  out: JsLikeExtract,
  kind: ParsedSymbol["kind"],
  exported: boolean,
  owner: Node,
  applyNaming = true,
): void {
  const name = field(declaration, "name");
  if (!name?.text) return;
  out.symbols.push({
    name: name.text,
    kind: applyNaming ? namedKind(name.text, kind) : kind,
    lineStart: startLine(declaration),
    lineEnd: endLine(declaration),
    signature: signatureOf(owner),
    exported,
    confidence: 1,
  });
}

/** React naming heuristic, mirroring the regex parser's `symbolKindForName`: a `useX`
 *  name is a hook whatever the declaration is; a PascalCase function is a component. */
function namedKind(name: string, base: ParsedSymbol["kind"]): ParsedSymbol["kind"] {
  if (isReactHookName(name)) return "hook";
  if (base === "function" && isPascalCase(name)) return "component";
  return base;
}

// ── Expression-form imports (`require(…)`, `import(…)`) ───────────────────────────────

function collectExpressionImports(
  root: Node,
  out: JsLikeExtract,
  resolveSource: (source: string) => string | undefined,
): void {
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const callee = field(call, "function");
    if (!callee) continue;
    const args = field(call, "arguments");
    const first = args ? namedChildrenOf(args)[0] : undefined;
    const source = stringValue(first);
    if (source === undefined) continue;

    if (callee.type === "import") {
      out.imports.push(makeImport(source, [], "dynamic", startLine(call)));
      continue;
    }
    if (calleeName(callee) === "require") {
      out.imports.push(makeImport(source, requireBinding(call), "commonjs", startLine(call)));
    }
  }
  // `resolveSource` is applied once, here, so every import records the same resolution.
  for (const parsedImport of out.imports) {
    const resolved = resolveSource(parsedImport.source);
    if (resolved !== undefined) parsedImport.resolvedPath = resolved;
  }
}

/** `const helper = require("x")` → ["helper"]; a bare `require("x")` → []. */
function requireBinding(call: Node): string[] {
  const declarator = call.parent;
  if (declarator?.type !== "variable_declarator") return [];
  const name = field(declarator, "name");
  return name?.type === "identifier" ? [name.text] : [];
}

function makeImport(
  source: string,
  specifiers: string[],
  importKind: ParsedImport["importKind"],
  line: number,
): ParsedImport {
  return {
    source,
    specifiers,
    importKind,
    line,
    // Tree-sitter read the real syntax tree, so a static/commonjs specifier is certain.
    // A dynamic `import()` of a bare package stays the low-confidence case it was.
    confidence: dynamicBareConfidence(source, importKind),
  };
}

/** Confidence mirrors the regex parsers' scale so downstream thresholds keep working. */
function dynamicBareConfidence(source: string, importKind: ParsedImport["importKind"]): number {
  const relative = source.startsWith(".");
  if (importKind === "dynamic") return relative ? 0.9 : 0.3;
  return relative ? 1.0 : 0.95;
}
