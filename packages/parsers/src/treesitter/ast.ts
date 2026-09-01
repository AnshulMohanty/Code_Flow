import type { Node } from "web-tree-sitter";

/** 1-based start line of a node (tree-sitter rows are 0-based). */
export function startLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** 1-based end line of a node. */
export function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

/**
 * First line of a node's source text, trimmed — the `signature` shape the regex parsers
 * produce (and which Inventory's `inferKindFromSignature` reads to recover
 * interface/type/enum kinds from a `kind: "unknown"` symbol).
 */
export function signatureOf(node: Node): string {
  const text = node.text;
  const newline = text.search(/\r|\n/);
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/**
 * The value of a string literal node, without quotes. Handles both grammar shapes:
 * JS/TS `(string (string_fragment))` and Python `(string (string_start) (string_content)
 * (string_end))`. Returns undefined for a template/interpolated or non-string node, so a
 * dynamic specifier is never guessed at.
 */
export function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type !== "string") return undefined;
  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "string_fragment" || child.type === "string_content") parts.push(child.text);
    else if (child.type === "string_start" || child.type === "string_end") continue;
    else return undefined; // interpolation / escape node → not a static specifier
  }
  if (parts.length) return parts.join("");
  // A quoted empty string has no fragment child; strip the quotes ourselves.
  const raw = node.text;
  return raw.length >= 2 ? raw.slice(1, -1) : undefined;
}

/** Named children of `node`, skipping the nulls the binding can hand back. */
export function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

/** First named child with the given type, or undefined. */
export function firstChildOfType(node: Node, type: string): Node | undefined {
  for (const child of namedChildrenOf(node)) {
    if (child.type === type) return child;
  }
  return undefined;
}

/** A field child, narrowed to a real node. */
export function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

/**
 * Depth-first pre-order walk over named nodes. Deterministic (grammar child order) and
 * iterative, so a deeply-nested file cannot blow the JS stack. `descend` can prune a
 * subtree; the node itself is still visited.
 */
export function walk(root: Node, visit: (node: Node) => void, descend?: (node: Node) => boolean): void {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    if (descend && !descend(node)) continue;
    const children = namedChildrenOf(node);
    // Push in reverse so children pop in source order.
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
}

/**
 * Dotted callee text for a call — `foo` → "foo", `a.b.c` → "a.b.c". Returns undefined for
 * a computed / non-identifier callee, so nothing is invented.
 */
export function calleeName(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "identifier" || node.type === "property_identifier") return node.text;
  if (node.type === "member_expression" || node.type === "attribute") {
    const object = field(node, "object");
    const property = field(node, "property") ?? field(node, "attribute");
    const objectName = calleeName(object);
    const propertyName = property?.text;
    if (!propertyName) return undefined;
    return objectName ? `${objectName}.${propertyName}` : propertyName;
  }
  return undefined;
}

/** The last segment of a dotted callee — "router.get" → "get". */
export function calleeTail(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}
