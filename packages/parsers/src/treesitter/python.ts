import type { Node, Tree } from "web-tree-sitter";
import type { ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { endLine, field, namedChildrenOf, signatureOf, startLine } from "./ast.js";

export interface PythonExtract {
  imports: ParsedImport[];
  symbols: ParsedSymbol[];
}

/**
 * One tree-sitter pass over a Python file. Python has no export syntax, so (like the
 * regex parser) `exports` stays empty — the public surface is a naming convention, not a
 * fact, and Inventory must not be fed a guess.
 */
export function extractPython(tree: Tree, resolveSource: (source: string) => string | undefined): PythonExtract {
  const out: PythonExtract = { imports: [], symbols: [] };

  // Statement scope: module level, plus class bodies (for methods) and decorated wrappers.
  collectBlock(tree.rootNode, out, null);

  // Imports can be nested (inside a function, a `try:` block, a conditional) — the regex
  // parser caught those too, since it scanned every line. Walk the whole tree.
  for (const node of tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!node) continue;
    if (node.type === "import_statement") collectPlainImport(node, out);
    else collectFromImport(node, out);
  }

  for (const parsedImport of out.imports) {
    const resolved = resolveSource(parsedImport.source);
    if (resolved !== undefined) parsedImport.resolvedPath = resolved;
  }

  return out;
}

/** Walk one statement block, recording classes/functions. `className` is set inside a
 *  class body so a `def` there becomes a method — the same distinction the regex parser
 *  made with indentation tracking, but structural instead of whitespace-based. */
function collectBlock(block: Node, out: PythonExtract, className: string | null): void {
  for (const statement of namedChildrenOf(block)) {
    collectStatement(statement, out, className);
  }
}

function collectStatement(statement: Node, out: PythonExtract, className: string | null): void {
  if (statement.type === "decorated_definition") {
    const definition = field(statement, "definition");
    // Signature comes from the decorated node so the decorator line is not mistaken for it.
    if (definition) collectStatement(definition, out, className);
    return;
  }

  if (statement.type === "class_definition") {
    const name = field(statement, "name");
    if (name?.text) {
      out.symbols.push({
        name: name.text,
        kind: "class",
        lineStart: startLine(statement),
        lineEnd: endLine(statement),
        signature: signatureOf(statement),
        confidence: 1,
      });
      const body = field(statement, "body");
      if (body) collectBlock(body, out, name.text);
    }
    return;
  }

  if (statement.type === "function_definition") {
    const name = field(statement, "name");
    if (name?.text) {
      out.symbols.push({
        name: name.text,
        kind: className ? "method" : "function",
        lineStart: startLine(statement),
        lineEnd: endLine(statement),
        signature: signatureOf(statement),
        confidence: 1,
      });
    }
    // Nested defs inside a function body are not part of the module's symbol surface
    // (the regex parser recorded them; they are noise for reading order and RAG spans).
    return;
  }

  // `if TYPE_CHECKING:` / `try:` wrappers can hold real module-level definitions.
  if (statement.type === "if_statement" || statement.type === "try_statement" || statement.type === "with_statement") {
    for (const child of namedChildrenOf(statement)) {
      if (child.type === "block") collectBlock(child, out, className);
    }
  }
}

/** `import os, sys as system` → sources ["os", "sys"] (alias stripped, specifiers empty —
 *  matching the regex parser, whose `import` branch pushed no specifiers). */
function collectPlainImport(statement: Node, out: PythonExtract): void {
  const line = startLine(statement);
  for (const child of namedChildrenOf(statement)) {
    if (child.type === "dotted_name") {
      out.imports.push(makeImport(child.text, [], line));
    } else if (child.type === "aliased_import") {
      const name = field(child, "name");
      if (name?.text) out.imports.push(makeImport(name.text, [], line));
    }
  }
}

/** `from .models import User` / `from a.b import c as d` / `from . import sibling`. */
function collectFromImport(statement: Node, out: PythonExtract): void {
  const line = startLine(statement);
  const moduleName = field(statement, "module_name");
  if (!moduleName) return;
  const source = moduleName.text;

  const specifiers: string[] = [];
  let wildcard = false;
  for (const child of namedChildrenOf(statement)) {
    if (child.id === moduleName.id) continue;
    if (child.type === "wildcard_import") {
      wildcard = true;
    } else if (child.type === "dotted_name") {
      specifiers.push(child.text);
    } else if (child.type === "aliased_import") {
      // The regex parser kept the ORIGINAL name (it split on ` as ` and took [0]).
      const name = field(child, "name");
      if (name?.text) specifiers.push(name.text);
    }
  }
  if (wildcard && !specifiers.length) specifiers.push("*");
  out.imports.push(makeImport(source, specifiers, line));
}

function makeImport(source: string, specifiers: string[], line: number): ParsedImport {
  return {
    source,
    specifiers,
    importKind: "python",
    line,
    confidence: source.startsWith(".") ? 0.9 : 0.95,
  };
}
