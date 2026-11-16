import type { Node, Tree } from "web-tree-sitter";
import type { ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { scanCIncludes } from "../utils/importScan.js";
import { collectByType, endLine, field, namedChildrenOf, signatureOf, startLine } from "./ast.js";

/**
 * C and C++, from one tree-sitter pass (the C++ grammar parses both).
 *
 * A dependency is an `#include`; how it resolves depends on its form — `"x.h"` searches the
 * including file's directory first, `<x.h>` only the include path — so the form is kept. Function
 * DEFINITIONS are recorded too: C has one flat namespace for non-static functions, which is what
 * lets a call to `parse()` reach the file that defines it.
 */

export interface CInclude {
  path: string;
  /** `<x.h>` — searched only on the include path; `"x.h"` searches the including file's directory first. */
  system: boolean;
  line: number;
}

export interface CFunction {
  name: string;
  /** `Reader::read` for an out-of-class definition. */
  qualifiedName: string;
  isStatic: boolean;
  line: number;
  lineEnd: number;
  signature: string;
}

export interface CType {
  name: string;
  kind: "class" | "struct" | "union" | "enum";
  line: number;
  lineEnd: number;
}

export interface CCall {
  binding: string;
  symbol: string;
  line: number;
}

export interface CFamilyExtract {
  includes: CInclude[];
  functions: CFunction[];
  types: CType[];
  calls: CCall[];
  inheritance: Array<CCall & { kind: "extends" }>;
}

const TYPE_KINDS: Record<string, CType["kind"]> = {
  class_specifier: "class",
  struct_specifier: "struct",
  union_specifier: "union",
  enum_specifier: "enum",
};

export function extractCFamilyFacts(tree: Tree, content: string): CFamilyExtract {
  const out: CFamilyExtract = { includes: [], functions: [], types: [], calls: [], inheritance: [] };
  const root = tree.rootNode;
  const pick = collectByType(root, ["preproc_include", "function_definition", ...Object.keys(TYPE_KINDS), "call_expression"]);

  for (const node of pick("preproc_include")) {
    const path = node ? field(node, "path") : undefined;
    if (!node || !path) continue;
    if (path.type === "system_lib_string") {
      out.includes.push({ path: path.text.slice(1, -1).trim(), system: true, line: startLine(node) });
    } else if (path.type === "string_literal") {
      const content = namedChildrenOf(path).find((child) => child.type === "string_content")?.text ?? path.text.slice(1, -1);
      out.includes.push({ path: content.trim(), system: false, line: startLine(node) });
    }
    // An identifier (`#include CONFIG_HEADER`) is decided by a macro — never guessed.
  }
  // `#include` is a line-level preprocessor directive, and the C++ grammar can lose its place in a
  // preprocessor condition (`#if FMT_HAS_INCLUDE(<version>)` reads `<version>` as a template argument
  // and swallows the next includes — fmt's format-test.cc). The line scan is the backstop; a line the
  // tree places inside a comment is not an include.
  const seenLines = new Set(out.includes.map((entry) => entry.line));
  const lines = content.split(/\r\n|\r|\n/);
  for (const entry of scanCIncludes(content)) {
    if (seenLines.has(entry.line)) continue;
    const text = lines[entry.line - 1] ?? "";
    const node = root.descendantForPosition({ row: entry.line - 1, column: Math.max(0, text.indexOf("#")) });
    if (node?.type === "comment") continue;
    out.includes.push(entry);
  }
  out.includes.sort((a, b) => a.line - b.line);

  for (const node of pick("function_definition")) {
    if (!node) continue;
    const declarator = functionDeclarator(field(node, "declarator"));
    const nameNode = declarator ? field(declarator, "declarator") : undefined;
    if (!nameNode) continue;
    const qualifiedName = nameNode.text.replace(/\s+/g, "");
    const name = qualifiedName.split("::").pop() ?? qualifiedName;
    if (!/^[A-Za-z_~][\w]*$/.test(name)) continue; // operators, conversion functions
    const isStatic = namedChildrenOf(node).some((child) => child.type === "storage_class_specifier" && child.text === "static");
    out.functions.push({ name, qualifiedName, isStatic, line: startLine(node), lineEnd: endLine(node), signature: signatureOf(node) });
  }

  for (const node of pick(Object.keys(TYPE_KINDS))) {
    if (!node) continue;
    const name = field(node, "name");
    if (!name || !field(node, "body")) continue; // a declaration or forward reference, not a definition
    out.types.push({ name: name.text, kind: TYPE_KINDS[node.type], line: startLine(node), lineEnd: endLine(node) });
    const bases = namedChildrenOf(node).find((child) => child.type === "base_class_clause");
    for (const base of bases ? namedChildrenOf(bases) : []) {
      if (base.type !== "type_identifier" && base.type !== "qualified_identifier" && base.type !== "template_type") continue;
      const symbol = base.text.replace(/<.*$/s, "").replace(/\s+/g, "");
      out.inheritance.push({ binding: symbol.split("::").pop() ?? symbol, symbol, kind: "extends", line: startLine(node) });
    }
  }

  for (const call of pick("call_expression")) {
    const callee = call ? field(call, "function") : undefined;
    if (!call || !callee) continue;
    if (callee.type === "identifier") {
      out.calls.push({ binding: callee.text, symbol: callee.text, line: startLine(call) });
    } else if (callee.type === "qualified_identifier") {
      const symbol = callee.text.replace(/\s+/g, "");
      out.calls.push({ binding: symbol.split("::").pop() ?? symbol, symbol, line: startLine(call) });
    }
  }
  return out;
}

/** Walk pointer/reference declarators down to the function declarator. */
function functionDeclarator(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && current.type !== "function_declarator") {
    current = field(current, "declarator") ?? namedChildrenOf(current).find((child) => child.type.endsWith("declarator"));
  }
  return current;
}

// ── ParsedFile projection (Inventory) ──────────────────────────────────────────────

export function extractCFamily(tree: Tree, content: string): { imports: ParsedImport[]; exports: ParsedExport[]; symbols: ParsedSymbol[] } {
  return projectCFamily(extractCFamilyFacts(tree, content));
}

/** Inventory's view of one C/C++ extract. */
export function projectCFamily(facts: CFamilyExtract): { imports: ParsedImport[]; exports: ParsedExport[]; symbols: ParsedSymbol[] } {
  const imports: ParsedImport[] = facts.includes.map((entry) => ({
    source: entry.path,
    specifiers: [],
    importKind: "static",
    line: entry.line,
    confidence: 1,
  }));
  const symbols: ParsedSymbol[] = [
    ...facts.functions.map((fn) => ({
      name: fn.qualifiedName,
      kind: (fn.qualifiedName.includes("::") ? "method" : "function") as ParsedSymbol["kind"],
      lineStart: fn.line,
      lineEnd: fn.lineEnd,
      signature: fn.signature,
      exported: !fn.isStatic,
      confidence: 1,
    })),
    ...facts.types.map((type) => ({
      name: type.name,
      kind: (type.kind === "enum" ? "unknown" : "class") as ParsedSymbol["kind"],
      lineStart: type.line,
      lineEnd: type.lineEnd,
      signature: `${type.kind} ${type.name}`,
      exported: true,
      confidence: 1,
    })),
  ].sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  const exports: ParsedExport[] = facts.functions
    .filter((fn) => !fn.isStatic && !fn.qualifiedName.includes("::"))
    .map((fn) => ({ name: fn.name, kind: "function", line: fn.line, confidence: 1 }));
  return { imports, exports, symbols };
}
