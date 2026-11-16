import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * Citation verification for ANY text — an agent's answer, a PR description, a review comment.
 *
 * Extracts every code reference (`src/a.ts:42`, `a.py#L10-L20`, a GitHub blob URL, "`foo` in
 * src/a.ts", "src/a.ts line 12") and checks it against the analysed repository:
 *   - the file exists (exactly, or as a unique path suffix),
 *   - the cited lines are inside the file,
 *   - a symbol named next to the reference is declared in that file — at the cited lines when given.
 *
 * Deterministic and model-free. It proves a reference POINTS AT SOMETHING REAL; it does not judge
 * whether the prose around it is a correct description of that code.
 */

export interface CodeReference {
  /** The matched text, as written. */
  raw: string;
  /** Offset of the match in the input. */
  index: number;
  /** Normalised repo-relative path as written (prefixes like `./`, `a/`, blob URLs stripped). */
  path: string;
  startLine?: number;
  endLine?: number;
  /** A backticked identifier written right next to the reference, e.g. "`createRagStage` in …". */
  symbol?: string;
  /**
   * A bare filename in prose (no slash, no line, no backticks) — "Node.js", "config.json". Only
   * treated as a reference when the repository actually has such a file; otherwise it is prose.
   */
  loose?: boolean;
}

export type ReferenceStatus = "pass" | "warn" | "fail";

export type ReferenceVerdict =
  | "ok"
  | "ok-resolved"
  | "missing-file"
  | "ambiguous-file"
  | "line-out-of-range"
  | "symbol-not-in-file"
  | "symbol-not-at-lines"
  | "symbol-unverifiable"
  | "lines-unverifiable";

export interface VerifiedReference extends CodeReference {
  status: ReferenceStatus;
  verdict: ReferenceVerdict;
  /** The repo file the reference resolved to, when it resolved. */
  resolvedPath?: string;
  /** For an ambiguous suffix: the matching files (capped). */
  candidates?: string[];
  detail: string;
}

export interface VerificationReport {
  references: VerifiedReference[];
  pass: number;
  warn: number;
  fail: number;
}

export interface ReferenceIndexSymbol {
  name: string;
  line: number;
  endLine?: number;
}

/** What verification needs to know about the repository. */
export interface ReferenceIndex {
  paths: readonly string[];
  /** Line count of a repo file, when known. */
  lineCount(path: string): Promise<number | undefined> | number | undefined;
  /** Declared symbols of a file; `undefined` when the file was not parsed (cannot be checked). */
  symbolsIn(path: string): readonly ReferenceIndexSymbol[] | undefined;
}

const EXTENSIONS = [
  "tsx", "ts", "mts", "cts", "jsx", "js", "mjs", "cjs", "py", "pyi", "go", "rs", "java", "kt", "kts", "rb", "php",
  "cs", "cpp", "cc", "c", "hpp", "h", "swift", "scala", "vue", "svelte", "mdx", "md", "json", "yaml", "yml", "toml",
  "css", "scss", "html", "sql", "sh", "proto", "graphql", "gql", "lock", "txt",
];

/** Line-anchored suffixes: `:42`, `:42-50`, `:L42`, `#L42`, `#L42-L50`, `:42:7` (column ignored). */
const PATH_RE = new RegExp(
  String.raw`(?:https?://github\.com/[\w.-]+/[\w.-]+/(?:blob|tree)/[\w.\-/]+?/)?` +
    String.raw`((?:\.{0,2}/)?(?:(?:\([\w.\-]+\)|[\w@.\-\[\]+]+)/)*[\w@.\-\[\]+]+\.(?:${EXTENSIONS.join("|")}))` +
    String.raw`(?:(?::L?|#L)(\d+)(?:(?::\d+)?(?:-|–|:)L?(\d+))?(?::\d+)?)?` +
    String.raw`(?![\w/])`,
  "g",
);
/** "line 42", "lines 10-20", "(L42)" written AFTER a path without an anchor. */
const TRAILING_LINES_RE = /^[\s,`*]*(?:\(|—|-)?\s*(?:on\s+|at\s+)?(?:lines?|L)\s*(\d+)(?:\s*(?:-|–|to|through)\s*L?(\d+))?/i;
/** Non-global twin of PATH_RE for "is there a path in this span" tests (no shared lastIndex). */
const PATH_PRESENT_RE = new RegExp(PATH_RE.source);
const BACKTICK_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
/** How close (chars) a backticked identifier must sit to a path to be read as "the symbol cited". */
const SYMBOL_WINDOW_BEFORE = 60;
const SYMBOL_WINDOW_AFTER = 40;
/** Tolerance when checking that a cited line range lands on the symbol's declaration. */
const LINE_SLACK = 3;

export function extractCodeReferences(text: string): CodeReference[] {
  const references: CodeReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    // A bare dotted word like `config.json` with no slash is still a path; a URL host is not.
    if (/^https?:\/\//.test(text.slice(Math.max(0, index - 8), index + 8)) && !raw.includes("github.com")) continue;
    if (text[index - 1] === "@") continue; // npm scope / email
    const path = normalisePath(match[1]);
    if (!path || /^\d+(\.\d+)+/.test(path)) continue; // version numbers like 1.2.3.js
    let startLine = match[2] ? Number(match[2]) : undefined;
    let endLine = match[3] ? Number(match[3]) : undefined;
    if (startLine === undefined) {
      const trailing = TRAILING_LINES_RE.exec(text.slice(index + raw.length, index + raw.length + 40));
      if (trailing) {
        startLine = Number(trailing[1]);
        endLine = trailing[2] ? Number(trailing[2]) : undefined;
      }
    }
    if (endLine !== undefined && startLine !== undefined && endLine < startLine) [startLine, endLine] = [endLine, startLine];
    const symbol = nearbySymbol(text, index, index + raw.length, path);
    // Inside a `code span` when an odd number of backticks precede it on the same line.
    const lineBefore = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
    const backticked = (lineBefore.match(/`/g)?.length ?? 0) % 2 === 1;
    const loose = !path.includes("/") && startLine === undefined && !backticked;
    const key = `${path}:${startLine ?? ""}-${endLine ?? ""}:${symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      raw,
      index,
      path,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(symbol ? { symbol } : {}),
      ...(loose ? { loose: true } : {}),
    });
  }
  return references;
}

export async function verifyReferences(text: string, index: ReferenceIndex): Promise<VerificationReport> {
  const pathSet = new Set(index.paths);
  const references: VerifiedReference[] = [];
  for (const reference of extractCodeReferences(text)) {
    const verified = await verifyOne(reference, index, pathSet);
    // "Node.js" in a sentence is prose, not a citation of a missing file.
    if (reference.loose && (verified.verdict === "missing-file" || verified.verdict === "ambiguous-file")) continue;
    references.push(verified);
  }
  return {
    references,
    pass: references.filter((r) => r.status === "pass").length,
    warn: references.filter((r) => r.status === "warn").length,
    fail: references.filter((r) => r.status === "fail").length,
  };
}

async function verifyOne(reference: CodeReference, index: ReferenceIndex, pathSet: Set<string>): Promise<VerifiedReference> {
  const resolution = resolvePath(reference.path, index.paths, pathSet);
  if (resolution.kind === "missing") {
    return { ...reference, status: "fail", verdict: "missing-file", detail: `no file "${reference.path}" in this repository` };
  }
  if (resolution.kind === "ambiguous") {
    return {
      ...reference,
      status: "warn",
      verdict: "ambiguous-file",
      candidates: resolution.candidates.slice(0, 5),
      detail: `"${reference.path}" matches ${resolution.candidates.length} files — cite the full path`,
    };
  }
  const resolvedPath = resolution.path;
  const resolvedNote = resolvedPath === reference.path ? "" : ` (matched ${resolvedPath})`;

  if (reference.startLine !== undefined) {
    const total = await index.lineCount(resolvedPath);
    const last = reference.endLine ?? reference.startLine;
    if (total !== undefined && (reference.startLine < 1 || last > total)) {
      return {
        ...reference,
        resolvedPath,
        status: "fail",
        verdict: "line-out-of-range",
        detail: `line ${last > total ? last : reference.startLine} is outside the file (${total} lines)${resolvedNote}`,
      };
    }
    if (total === undefined && !reference.symbol) {
      return {
        ...reference,
        resolvedPath,
        status: "warn",
        verdict: "lines-unverifiable",
        detail: `file exists${resolvedNote}; its length is unknown, so the line range was not checked`,
      };
    }
  }

  if (reference.symbol) {
    const symbols = index.symbolsIn(resolvedPath);
    const wanted = symbolNames(reference.symbol);
    if (!symbols || symbols.length === 0) {
      return {
        ...reference,
        resolvedPath,
        status: "warn",
        verdict: "symbol-unverifiable",
        detail: `file exists${resolvedNote}; \`${reference.symbol}\` could not be checked (no parsed symbols for this file)`,
      };
    }
    const declared = symbols.filter((symbol) => wanted.has(symbol.name));
    if (declared.length === 0) {
      return {
        ...reference,
        resolvedPath,
        status: "fail",
        verdict: "symbol-not-in-file",
        detail: `\`${reference.symbol}\` is not declared in ${resolvedPath}`,
      };
    }
    if (reference.startLine !== undefined) {
      const from = reference.startLine - LINE_SLACK;
      const to = (reference.endLine ?? reference.startLine) + LINE_SLACK;
      const overlapping = declared.find((symbol) => symbol.line <= to && (symbol.endLine ?? symbol.line) >= from);
      if (!overlapping) {
        const where = declared.map((s) => (s.endLine && s.endLine !== s.line ? `${s.line}-${s.endLine}` : `${s.line}`)).join(", ");
        return {
          ...reference,
          resolvedPath,
          status: "fail",
          verdict: "symbol-not-at-lines",
          detail: `\`${reference.symbol}\` is declared at line ${where}, not at the cited line${reference.endLine ? "s" : ""}`,
        };
      }
    }
    const at = declared[0];
    return {
      ...reference,
      resolvedPath,
      status: "pass",
      verdict: resolvedPath === reference.path ? "ok" : "ok-resolved",
      detail: `\`${reference.symbol}\` declared at line ${at.line}${at.endLine && at.endLine !== at.line ? `-${at.endLine}` : ""}${resolvedNote}`,
    };
  }

  return {
    ...reference,
    resolvedPath,
    status: "pass",
    verdict: resolvedPath === reference.path ? "ok" : "ok-resolved",
    detail: reference.startLine !== undefined ? `file and lines exist${resolvedNote}` : `file exists${resolvedNote}`,
  };
}

type PathResolution = { kind: "exact" | "suffix"; path: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "missing" };

function resolvePath(path: string, paths: readonly string[], pathSet: Set<string>): PathResolution {
  if (pathSet.has(path)) return { kind: "exact", path };
  const suffix = `/${path}`;
  const candidates = paths.filter((candidate) => candidate.endsWith(suffix)).sort();
  if (candidates.length === 1) return { kind: "suffix", path: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "missing" };
}

function normalisePath(path: string): string {
  let out = path.replace(/\\/g, "/");
  out = out.replace(/^(?:\.{1,2}\/)+/, "").replace(/^\/+/, "");
  out = out.replace(/^(?:a|b)\/(?=.+\/)/, ""); // git diff prefixes
  return out;
}

/** `Foo.bar()` may be declared as `bar` (method) or under its owner `Foo`. */
function symbolNames(symbol: string): Set<string> {
  const parts = symbol.split(".");
  return new Set([symbol, parts[parts.length - 1], parts[0]]);
}

function nearbySymbol(text: string, start: number, end: number, path: string): string | undefined {
  const fileStem = path.split("/").pop()?.replace(/\.[^.]+$/, "");
  const candidates: Array<{ name: string; distance: number }> = [];
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const lineEndRaw = text.indexOf("\n", end);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const before = text.slice(Math.max(lineStart, start - SYMBOL_WINDOW_BEFORE), start);
  const beforeOffset = Math.max(lineStart, start - SYMBOL_WINDOW_BEFORE);
  for (const match of before.matchAll(BACKTICK_RE)) {
    const matchEnd = beforeOffset + (match.index ?? 0) + match[0].length;
    // Another path between the symbol and this reference means the symbol belongs to that one.
    if (PATH_PRESENT_RE.test(text.slice(matchEnd, start))) continue;
    candidates.push({ name: match[1], distance: start - matchEnd });
  }
  const after = text.slice(end, Math.min(lineEnd, end + SYMBOL_WINDOW_AFTER));
  for (const match of after.matchAll(BACKTICK_RE)) {
    candidates.push({ name: match[1], distance: (match.index ?? 0) + SYMBOL_WINDOW_BEFORE });
  }
  const best = candidates
    .filter((candidate) => candidate.name !== fileStem && !EXTENSIONS.includes(candidate.name))
    .sort((a, b) => a.distance - b.distance)[0];
  return best?.name;
}

/**
 * The index for a stored analysis: every graph node is a file; line counts are Inventory's PHYSICAL
 * counts (`inventory.lines` — never `loc`, which skips blanks and comments and would turn a valid
 * citation near the end of a file into a false "outside the file"). `readLineCount` (optional) fills
 * in any other file when the caller has the checkout on disk; otherwise its lines are not checked.
 */
export function buildReferenceIndex(
  result: AnalysisResult,
  readLineCount?: (path: string) => Promise<number | undefined>,
): ReferenceIndex {
  const paths = (result.graph?.nodes ?? result.files ?? []).map((node) => node.id);
  const pathSet = new Set(paths);
  const knownLines = new Map<string, number>(Object.entries(result.inventory?.lines ?? {}));
  const symbolsByFile = new Map<string, ReferenceIndexSymbol[]>();
  for (const symbol of result.inventory?.symbols ?? []) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    list.push({ name: symbol.name, line: symbol.line, ...(symbol.endLine ? { endLine: symbol.endLine } : {}) });
    symbolsByFile.set(symbol.filePath, list);
  }
  const parsed = new Set(Object.keys(result.inventory?.loc ?? {}));
  return {
    paths,
    async lineCount(path) {
      if (knownLines.has(path)) return knownLines.get(path);
      if (readLineCount && pathSet.has(path)) return readLineCount(path);
      return undefined;
    },
    symbolsIn(path) {
      if (symbolsByFile.has(path)) return symbolsByFile.get(path);
      return parsed.has(path) ? [] : undefined;
    },
  };
}

export function formatVerificationReport(report: VerificationReport, format: "text" | "markdown" = "text"): string {
  if (report.references.length === 0) return "No code references (path, path:line, or GitHub link) found in the text.";
  const icon = { pass: format === "markdown" ? "✅" : "✓", warn: format === "markdown" ? "⚠️" : "!", fail: format === "markdown" ? "❌" : "✗" };
  const lines = report.references.map((reference) => {
    const cite = `${reference.path}${reference.startLine ? `:${reference.startLine}${reference.endLine ? `-${reference.endLine}` : ""}` : ""}`;
    const symbol = reference.symbol ? ` \`${reference.symbol}\`` : "";
    return format === "markdown"
      ? `| ${icon[reference.status]} | \`${cite}\`${symbol} | ${reference.detail.replace(/\|/g, "\\|")} |`
      : `${icon[reference.status]} ${cite}${symbol} — ${reference.detail}`;
  });
  const summary = `${report.references.length} reference(s): ${report.pass} verified, ${report.warn} unverifiable/ambiguous, ${report.fail} wrong`;
  return format === "markdown" ? [`**${summary}**`, "", "| | Reference | Result |", "|---|---|---|", ...lines].join("\n") : [...lines, "", summary].join("\n");
}
