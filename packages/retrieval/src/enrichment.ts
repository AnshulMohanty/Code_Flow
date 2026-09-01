import type { ChunkEnrichment, RagChunk } from "@codeflow/shared-types";

/**
 * AST-enriched chunk embedding text (V3-P2, task 2).
 *
 * THE PROBLEM. The deterministic chunk plan is symbol-aligned, which is already better than
 * fixed windows — but a chunk is still a range of raw bytes, and a range of raw bytes embeds
 * badly. Three concrete failures, all of which a real user hits immediately:
 *
 *   1. An oversized symbol is split into sub-chunks. Sub-chunk 1 contains the signature; every
 *      other sub-chunk is a body fragment with no name in it at all. A query for the symbol
 *      cannot match the part of it that actually answers the question.
 *   2. A method body inside a class carries no mention of the class. "How does AuthService
 *      refresh tokens" has to match text that says neither `AuthService` nor `refresh`.
 *   3. Nothing in the text says which FILE or LANGUAGE it came from, though file paths are
 *      dense with intent (`src/auth/session.ts`) and a query often names a path fragment.
 *
 * THE FIX, and its one important constraint. Prepend the identifying context to the text that
 * gets EMBEDDED — never to the text that gets STORED. `RagChunk.text` (in the text store) stays
 * byte-exact for its line range, because that is what a citation resolves to and what goes in
 * an answer prompt; the enrichment exists only to steer the vector. Keeping those two
 * separate is why this is a function over the chunk rather than a mutation of it.
 *
 * DETERMINISTIC. Every field comes from the deterministic spine (inventory symbols + file
 * bytes); no model is involved, the composition is a fixed template, and the same chunk always
 * produces the same string. That matters twice: the chunk plan must stay byte-reproducible,
 * and the embedding cache is content-addressed on exactly this string.
 *
 * CACHE CONSEQUENCE, stated plainly: because the cache key hashes the embedded text, enabling
 * enrichment invalidates every document-side embedding cache entry once. That is a one-time
 * re-embed on the next real run, and it is the correct behaviour — the old vectors describe
 * different text.
 */

/** Chunk metadata plus its raw text — what `embedTextFor` needs. */
export interface EnrichableChunk extends RagChunk {
  text: string;
}

/**
 * Compose the string to embed.
 *
 * Header lines are emitted only when their data exists, in a FIXED order, each on its own line,
 * followed by a blank line and the raw text. The ordering is deliberate: the most identifying
 * facts (path, then scope, then signature) come first, because a truncating tokenizer keeps
 * the head, and a query that names a symbol or a path should match on a line that is certain
 * to be inside the model's context window.
 */
export function embedTextFor(chunk: EnrichableChunk): string {
  const header: string[] = [];
  const enrichment = chunk.enrichment;

  // Path + line range. The path is split into words as well as kept whole: `src/auth/session.ts`
  // is one rare token to a lexical index and three useful words to an embedding model.
  header.push(`file: ${chunk.fileId} (lines ${chunk.startLine}-${chunk.endLine})`);
  const pathWords = pathAsWords(chunk.fileId);
  if (pathWords) header.push(`path: ${pathWords}`);

  if (enrichment?.language) header.push(`language: ${enrichment.language}`);

  // Scope BEFORE the symbol name, reading outermost-first, so a method chunk names its class.
  if (enrichment?.scope?.length) header.push(`scope: ${enrichment.scope.join(" > ")}`);
  if (chunk.symbolName) header.push(`symbol: ${chunk.symbolName}`);
  // The signature is where a typed language states its types, so this line is also how
  // "enriched with types" is satisfied — without inventing a field nothing could fill.
  if (enrichment?.signature) header.push(`signature: ${enrichment.signature}`);
  if (enrichment?.docstring) header.push(`doc: ${enrichment.docstring}`);

  return `${header.join("\n")}\n\n${chunk.text}`;
}

/** True when this chunk's embedding text differs from its raw text — i.e. enrichment applies.
 *  Always true today (the path header is unconditional); exposed so a caller can report it. */
export function isEnriched(chunk: EnrichableChunk): boolean {
  return embedTextFor(chunk) !== chunk.text;
}

/**
 * Turn a path into space-separated words: `src/auth/session-store.ts` → `src auth session store`.
 *
 * Splitting on separators AND camelCase, dropping the extension, and de-duplicating in order.
 * De-duplication matters more than it looks: `src/auth/auth.ts` would otherwise repeat `auth`
 * three times and skew the vector toward a term the file merely happens to be nested under.
 * Returns "" when the words add nothing beyond the path line itself.
 */
function pathAsWords(fileId: string): string {
  const withoutExt = fileId.replace(/\.[A-Za-z0-9]+$/, "");
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of withoutExt.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const word = part.toLowerCase();
      if (word.length < 2 || seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }
  }
  return words.length > 1 ? words.join(" ") : "";
}

// -- Deterministic derivation of the enrichment itself ------------------------------

/** A symbol span, as the RAG stage knows it (from `Inventory.symbols`). */
export interface SymbolSpan {
  name: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface DeriveEnrichmentInput {
  /** 1-based inclusive chunk range. */
  startLine: number;
  endLine: number;
  /** The chunk's own symbol, when it is symbol-aligned. */
  symbolName?: string;
  /** EVERY symbol in the file — not just the top-level ones the interval cover selected.
   *  The nested ones are exactly what makes a scope chain possible. */
  symbols: readonly SymbolSpan[];
  /** The file's lines (1-based access via `lines[n - 1]`). */
  lines: readonly string[];
  language?: string;
  /** Max docstring lines kept. */
  maxDocLines?: number;
  /** Max docstring characters kept. */
  maxDocChars?: number;
}

const DEFAULT_MAX_DOC_LINES = 8;
const DEFAULT_MAX_DOC_CHARS = 400;

/**
 * Derive a chunk's enrichment from the symbol table and the file bytes. Pure and deterministic.
 *
 * Returns `undefined` rather than an empty object when nothing could be derived, so "no
 * enrichment" is absent in the persisted slice instead of being a hollow field — the same rule
 * V3-P0 applied when it deleted the producerless `projectSummary`.
 */
export function deriveEnrichment(input: DeriveEnrichmentInput): ChunkEnrichment | undefined {
  const scope = scopeChainFor(input);
  const signature = signatureFor(input);
  const docstring = docstringFor(input);

  const enrichment: ChunkEnrichment = {
    ...(scope.length ? { scope } : {}),
    ...(signature ? { signature } : {}),
    ...(docstring ? { docstring } : {}),
    ...(input.language ? { language: input.language } : {}),
  };
  return Object.keys(enrichment).length > 0 ? enrichment : undefined;
}

/**
 * The enclosing symbol chain, outermost first.
 *
 * A symbol encloses the chunk when its span CONTAINS the chunk's range and it is not the
 * chunk's own symbol. Sorted by span width descending, so a class comes before a method inside
 * it — which is the order a reader (and a model) expects. Ties break on name so the chain is
 * deterministic when two symbols share a span.
 */
function scopeChainFor(input: DeriveEnrichmentInput): string[] {
  const enclosing = input.symbols.filter(
    (symbol) =>
      symbol.name !== input.symbolName &&
      symbol.startLine <= input.startLine &&
      symbol.endLine >= input.endLine &&
      // A symbol whose span is exactly the chunk is the chunk, not its scope.
      !(symbol.startLine === input.startLine && symbol.endLine === input.endLine),
  );
  enclosing.sort(
    (a, b) => b.endLine - b.startLine - (a.endLine - a.startLine) || a.startLine - b.startLine || a.name.localeCompare(b.name),
  );
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const symbol of enclosing) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    chain.push(symbol.name);
  }
  return chain;
}

/**
 * The chunk's signature: the parser's, when this chunk belongs to a named symbol.
 *
 * Only the PARSER's signature is used, never "the first line of the chunk". A body fragment's
 * first line is not a signature, and labelling it as one would put misleading text into the
 * vector — worse than putting nothing.
 */
function signatureFor(input: DeriveEnrichmentInput): string | undefined {
  if (!input.symbolName) return undefined;
  const own = input.symbols.find((symbol) => symbol.name === input.symbolName && symbol.signature);
  return own?.signature;
}

/**
 * The doc comment for the chunk's symbol. Two shapes, both derived from bytes we already have:
 *
 *   - LEADING comment block: contiguous `//`, `///`, `#` lines, or a `/** ... *\/` block,
 *     immediately above the symbol's declaration. Scanning upward stops at a blank line, so a
 *     comment belonging to the previous declaration is not stolen.
 *   - PYTHON-style docstring: a `"""`/`'''` block on the first content line INSIDE the span.
 *
 * Only emitted for a chunk that STARTS at its symbol's declaration. A later sub-chunk of a
 * split symbol gets the scope and the signature but not the doc: repeating a docstring across
 * five sub-chunks would make them all look alike to the vector, which is the redundancy MMR
 * then has to undo.
 */
function docstringFor(input: DeriveEnrichmentInput): string | undefined {
  if (!input.symbolName) return undefined;
  const own = input.symbols.find((symbol) => symbol.name === input.symbolName);
  if (!own || own.startLine !== input.startLine) return undefined;

  const maxLines = input.maxDocLines ?? DEFAULT_MAX_DOC_LINES;
  const maxChars = input.maxDocChars ?? DEFAULT_MAX_DOC_CHARS;

  const leading = leadingComment(input.lines, own.startLine, maxLines);
  if (leading) return truncate(leading, maxChars);

  const inner = pythonDocstring(input.lines, own.startLine, own.endLine, maxLines);
  return inner ? truncate(inner, maxChars) : undefined;
}

function leadingComment(lines: readonly string[], startLine: number, maxLines: number): string | undefined {
  const collected: string[] = [];
  let index = startLine - 2; // the line above the declaration, 0-based
  let sawBlockEnd = false;

  while (index >= 0 && collected.length < maxLines) {
    const line = lines[index];
    const trimmed = line?.trim() ?? "";
    if (trimmed === "") break; // a blank line ends the block — do not reach past it
    if (trimmed.endsWith("*/")) {
      sawBlockEnd = true;
      collected.unshift(stripCommentMarkers(trimmed));
      if (trimmed.startsWith("/*")) break; // a one-line /** ... */
      index -= 1;
      continue;
    }
    if (sawBlockEnd) {
      collected.unshift(stripCommentMarkers(trimmed));
      if (trimmed.startsWith("/*")) break;
      index -= 1;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
      collected.unshift(stripCommentMarkers(trimmed));
      index -= 1;
      continue;
    }
    break; // real code — not a doc comment
  }

  const text = collected
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .trim();
  return text === "" ? undefined : text;
}

function pythonDocstring(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  maxLines: number,
): string | undefined {
  // Scan forward from the declaration for the first non-blank line; a docstring must be it.
  for (let n = startLine + 1; n <= Math.min(endLine, startLine + 3); n++) {
    const trimmed = lines[n - 1]?.trim() ?? "";
    if (trimmed === "") continue;
    const quote = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
    if (!quote) return undefined;

    const first = trimmed.slice(3);
    if (first.endsWith(quote) && first.length >= 3) return first.slice(0, -3).trim() || undefined;

    const collected: string[] = first.trim() ? [first.trim()] : [];
    for (let m = n + 1; m <= endLine && collected.length < maxLines; m++) {
      const body = lines[m - 1] ?? "";
      const bodyTrimmed = body.trim();
      if (bodyTrimmed.endsWith(quote)) {
        const tail = bodyTrimmed.slice(0, -3).trim();
        if (tail) collected.push(tail);
        break;
      }
      if (bodyTrimmed) collected.push(bodyTrimmed);
    }
    const text = collected.join(" ").trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

function stripCommentMarkers(line: string): string {
  // Every pattern here is `^`-anchored, so it has one start position and cannot backtrack. The
  // trailing `*/` is the exception: `/\*+\/$/` started an attempt at every position in a run of
  // asterisks (10 ms at 4 000 characters, 159 ms at 16 000), and comment text comes from an
  // untrusted repository. `endsWith` decides in one comparison whether there is anything to do.
  return stripTrailingBlockComment(line.replace(/^\/\*+/, ""))
    .replace(/^\/\/+/, "")
    .replace(/^#+/, "")
    .replace(/^\*+/, "")
    .trim();
}

// Drop a trailing block-comment terminator and the asterisks in front of it -- what the
// `/\*+\/$/` replace did. A line comment, because the sequence it looks for would close a
// block comment.
function stripTrailingBlockComment(line: string): string {
  if (!line.endsWith("*/")) return line;
  let end = line.length - 2;
  while (end > 0 && line[end - 1] === "*") end -= 1;
  return line.slice(0, end);
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}
