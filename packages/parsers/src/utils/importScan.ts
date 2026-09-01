/**
 * Linear scanners for the regex-fallback parsers.
 *
 * Everything here runs over UNTRUSTED repository source, one line at a time, so every pattern
 * has to be linear in the length of the line. The obvious formulations are not. `\s+as\s+` as a
 * split delimiter, `\s+(.+)$` as a tail, `/\{([^}]+)\}/` and `(?:(.*?)\s+from\s+)?` as an
 * optional clause all pair two quantifiers that can claim the same character, so a single long
 * line of spaces costs quadratic backtracking — cubic for the import clause. Measured on the
 * patterns these replace: `import ` plus 1 000 spaces took 320 ms, and 4 000 spaces took over
 * twenty seconds. A repository is allowed to contain a line like that. The parser is not
 * allowed to stall on it, and `splitLines` does not split on U+2028, so such a "line" is
 * reachable and survives the `.trim()` each caller applies.
 *
 * Two ways out are used below, in this order of preference:
 *   1. pin the boundary between adjacent quantifiers so only one split is viable —
 *      `\s+(\S.*)$`, `import\s([^"']*)`, `=[^=]*=>`;
 *   2. drop the regex for an index scan, when pinning would change what the pattern accepts.
 *
 * The shared constants exist so a fix cannot land in the line parsers and miss the tree-sitter
 * fallback, which carried its own copy of all four Python/JS import patterns.
 */

const WHITESPACE = /\s/;
const FROM_KEYWORD = "from";
const TYPE_KEYWORD = "type";
const ALIAS_KEYWORD = "as";

/** One character, so no quantifier and no backtracking. */
function endsWithWhitespace(value: string): boolean {
  return value !== "" && WHITESPACE.test(value.slice(-1));
}

function startsWithWhitespace(value: string): boolean {
  return value !== "" && WHITESPACE.test(value.slice(0, 1));
}

/**
 * `import os` / `import os as o, sys`.
 *
 * `(\S.*)` rather than `(.+)`: `\s+` and `.` both match a space, so the unpinned form retried the
 * whole tail at every length of the leading whitespace run. Requiring a non-space first character
 * leaves exactly one viable split. Same captured text for every input where the old pattern
 * matched — a trimmed line cannot start its tail with whitespace.
 */
export const PY_IMPORT_LINE = /^import\s+(\S.*)$/;

/** `from a.b import c, d as e` — the trailing specifier list is pinned the same way. */
export const PY_FROM_IMPORT_LINE = /^from\s+([.\w]+)\s+import\s+(\S.*)$/;

/**
 * `const f = (a) => a`, `export const g = async () => 1`.
 *
 * Everything the old pattern spelled out after the `=` — `\s*`, `async`, `\(`, `\)`, `\s*` — is a
 * subset of `[^=]`, so `=[^=]*=>` accepts exactly the same lines. It is also linear, because
 * `[^=]*` cannot cross the `=` of the arrow: there is one place it can stop, not one per space.
 */
export const ARROW_ASSIGNMENT_LINE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^=]*=>/;

/**
 * Split on a whitespace-delimited `as`, as `split(/\s+as\s+/)` did.
 *
 * Tokenising first is one linear pass; `\s+as\s+` started a match attempt at every position in a
 * whitespace run and backtracked its leading `\s+` to nothing on each. Two deliberate differences,
 * both only on input that is not valid source in either language:
 *   - `as` needs a token on BOTH sides, exactly as `\s+as\s+` required, so `"x as"` stays one
 *     segment rather than becoming `["x", ""]`;
 *   - the keyword is matched case-sensitively. The JavaScript call sites used `/i`, which also
 *     accepted `AS` — not the keyword in Python or in TypeScript.
 *
 * Interior whitespace within a segment collapses to one space. Every caller trims, and the
 * segments are module paths and identifiers, which contain no whitespace.
 */
export function splitAliasSegments(value: string): string[] {
  const tokens = value.trim().split(/\s+/).filter((token) => token !== "");
  const segments: string[] = [];
  let current: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === ALIAS_KEYWORD && current.length > 0 && index + 1 < tokens.length) {
      segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(token);
  }
  segments.push(current.join(" "));
  return segments;
}

/**
 * The body of the first `{...}` group, or null when there is none.
 *
 * `/\{([^}]+)\}/` is quadratic on a run of `{`: every brace starts an attempt that scans to the
 * end of the line before failing. Two `indexOf` calls answer the same question — first `{`, then
 * the first `}` after it — in one pass, and give the identical substring including on nested
 * braces, which the character-class form does not.
 */
export function namedBraceBody(text: string): string | null {
  const open = text.indexOf("{");
  if (open === -1) return null;
  const close = text.indexOf("}", open + 1);
  // `[^}]+` required at least one character between the braces.
  return close > open + 1 ? text.slice(open + 1, close) : null;
}

/**
 * A SINGLE `\s`, not `\s+`: whitespace is a subset of `[^"']`, so `\s+[^"']*` and `\s[^"']*` accept
 * exactly the same strings — and the second has no adjacent quantifiers at all, so it is linear by
 * construction rather than by a lookahead a static analyser has to model as a pin. (`\s+(?=\S)`
 * also works and measured twice as slow.) `([^"']*)` cannot cross the quote that follows it, so it
 * stops in one place instead of one per space. What the clause MEANS — the optional `type`, the
 * mandatory `from` — is then decided by index arithmetic, which is where the cubic
 * `(?:(.*?)\s+from\s+)?` used to live.
 */
const STATIC_IMPORT_LINE = /^\s*import\s([^"']*)["']([^"']+)["']/;

export interface StaticImportLine {
  /** The clause between `import` and the module string with `type` stripped: `"{ a, b }"`, `"* as ns"`, or `""`. */
  readonly specifiers: string;
  readonly source: string;
}

/**
 * `import ... "source"` — the module string and the raw specifier clause, or null when the line
 * is not a static import.
 *
 * Accepts the same lines as the pattern it replaces on every syntactically valid import, verified
 * differentially against it over a corpus of import forms. ONE difference, on input that is not
 * valid JavaScript in any dialect: `import "a" from "b"` reported `b` as the source, because the
 * lazy `(.*?)` was free to swallow a quoted string; it now reports `a`, reading the line as the
 * side-effect import its prefix spells.
 */
export function parseStaticImportLine(line: string): StaticImportLine | null {
  const match = STATIC_IMPORT_LINE.exec(line);
  if (match === null) return null;
  // `\s` consumed one whitespace character; `[^"']*` absorbed any others, so the clause can
  // arrive with leading whitespace that the lookahead form had already eaten.
  const raw = (match[1] ?? "").trimStart();
  // `(?:type\s+)?` was greedy-optional and backtracked when the rest failed: `import type from "m"`
  // parsed `type` as the specifier. Both readings, in the same order.
  const specifiers = readImportClause(afterTypeKeyword(raw)) ?? readImportClause(raw);
  return specifiers === null ? null : { specifiers, source: match[2] ?? "" };
}

/** `"type X from "` → `"X from "`; null when there is no `type` keyword to strip. */
function afterTypeKeyword(raw: string): string | null {
  if (!raw.startsWith(TYPE_KEYWORD)) return null;
  const rest = raw.slice(TYPE_KEYWORD.length);
  return startsWithWhitespace(rest) ? rest.trimStart() : null;
}

/**
 * The specifier list, or null when the clause is not one. Mirrors `(?:(.*?)\s+from\s+)?`: the
 * clause is either empty (a side-effect import) or ends in `from` with whitespace on both sides.
 */
function readImportClause(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "") return "";
  if (!endsWithWhitespace(raw)) return null; // the `\s+` after `from`
  const body = raw.trimEnd();
  if (!body.endsWith(FROM_KEYWORD)) return null;
  const specifiers = body.slice(0, -FROM_KEYWORD.length);
  if (!endsWithWhitespace(specifiers)) return null; // the `\s+` before `from`
  return specifiers.trim();
}
