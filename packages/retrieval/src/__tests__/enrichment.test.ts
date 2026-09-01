import { describe, expect, it } from "vitest";
import { deriveEnrichment, embedTextFor, isEnriched, type SymbolSpan } from "../enrichment.js";

// Enrichment steers the VECTOR without touching what a citation resolves to. Both halves are
// asserted here: what ends up in the embedding text, and what is derived from the spine.

const CLASS_FILE = [
  "import { sign } from './jwt';", // 1
  "", // 2
  "/**", // 3
  " * Issues and refreshes bearer tokens.", // 4
  " */", // 5
  "export class AuthService {", // 6
  "  refresh(token: string): string {", // 7
  "    return sign(token);", // 8
  "  }", // 9
  "}", // 10
];

const SPANS: SymbolSpan[] = [
  { name: "AuthService", startLine: 6, endLine: 10, signature: "export class AuthService {" },
  { name: "refresh", startLine: 7, endLine: 9, signature: "refresh(token: string): string {" },
];

describe("embedTextFor — what the vector sees", () => {
  it("prepends the file path, line range and path words, then the raw text", () => {
    const text = embedTextFor({
      id: "src/auth/sessionStore.ts#1-2",
      fileId: "src/auth/sessionStore.ts",
      startLine: 1,
      endLine: 2,
      tokenCount: 4,
      text: "return 1;",
    });
    expect(text).toContain("file: src/auth/sessionStore.ts (lines 1-2)");
    // Path words: separators AND camelCase split, extension dropped. A query naming "session
    // store" should match a file nobody spelled out in the code itself.
    expect(text).toContain("path: src auth session store");
    expect(text.endsWith("return 1;")).toBe(true);
  });

  it("leaves the RAW text byte-exact and appends it last", () => {
    // The stored text is what a citation resolves to and what enters an answer prompt, so the
    // enrichment must be strictly a prefix — never a rewrite.
    const raw = "  const x = 1;\n  return x;";
    const text = embedTextFor({ id: "a.ts#1-2", fileId: "a.ts", startLine: 1, endLine: 2, tokenCount: 4, text: raw });
    expect(text.endsWith(`\n\n${raw}`)).toBe(true);
  });

  it("emits scope, symbol, signature and doc lines in a fixed identifying-first order", () => {
    const text = embedTextFor({
      id: "src/auth.ts#7-9",
      fileId: "src/auth.ts",
      startLine: 7,
      endLine: 9,
      symbolName: "refresh",
      tokenCount: 8,
      text: "return sign(token);",
      enrichment: {
        scope: ["AuthService"],
        signature: "refresh(token: string): string {",
        docstring: "Issues and refreshes bearer tokens.",
        language: "TypeScript",
      },
    });
    const lines = text.split("\n");
    const order = lines.map((line) => line.split(":")[0]);
    expect(order.slice(0, 6)).toEqual(["file", "path", "language", "scope", "symbol", "signature"]);
    expect(text).toContain("scope: AuthService");
    expect(text).toContain("signature: refresh(token: string): string {");
  });

  it("omits every header line whose data is absent (no empty labels)", () => {
    const text = embedTextFor({ id: "a.ts#1-1", fileId: "a.ts", startLine: 1, endLine: 1, tokenCount: 1, text: "x" });
    expect(text).not.toContain("scope:");
    expect(text).not.toContain("symbol:");
    expect(text).not.toContain("signature:");
    expect(text).not.toContain("doc:");
    // A single-word path adds nothing over the `file:` line, so it is skipped too.
    expect(text).not.toContain("path:");
  });

  it("de-duplicates repeated path words", () => {
    // `src/auth/auth.ts` would otherwise repeat `auth`, skewing the vector toward a term the
    // file merely happens to be nested under.
    const text = embedTextFor({ id: "src/auth/auth.ts#1-1", fileId: "src/auth/auth.ts", startLine: 1, endLine: 1, tokenCount: 1, text: "x" });
    expect(text).toContain("path: src auth");
  });

  it("is deterministic — the embedding cache key depends on it byte-for-byte", () => {
    const chunk = {
      id: "a.ts#1-1",
      fileId: "a.ts",
      startLine: 1,
      endLine: 1,
      tokenCount: 1,
      text: "x",
      enrichment: { scope: ["A", "B"], signature: "f()", docstring: "d", language: "TypeScript" },
    };
    expect(embedTextFor(chunk)).toBe(embedTextFor(chunk));
  });

  it("isEnriched reports that the embedded text differs from the stored text", () => {
    expect(isEnriched({ id: "a.ts#1-1", fileId: "a.ts", startLine: 1, endLine: 1, tokenCount: 1, text: "x" })).toBe(true);
  });
});

describe("deriveEnrichment — scope chain", () => {
  it("names the enclosing class for a method chunk, excluding the chunk's own symbol", () => {
    const enrichment = deriveEnrichment({
      startLine: 7,
      endLine: 9,
      symbolName: "refresh",
      symbols: SPANS,
      lines: CLASS_FILE,
      language: "TypeScript",
    });
    expect(enrichment?.scope).toEqual(["AuthService"]);
  });

  it("orders the chain outermost-first", () => {
    const nested: SymbolSpan[] = [
      { name: "Outer", startLine: 1, endLine: 20 },
      { name: "Inner", startLine: 5, endLine: 15 },
      { name: "leaf", startLine: 8, endLine: 10 },
    ];
    const enrichment = deriveEnrichment({ startLine: 8, endLine: 10, symbolName: "leaf", symbols: nested, lines: [] });
    expect(enrichment?.scope).toEqual(["Outer", "Inner"]);
  });

  it("treats a symbol whose span IS the chunk as the chunk, not its scope", () => {
    const enrichment = deriveEnrichment({
      startLine: 6,
      endLine: 10,
      symbolName: "AuthService",
      symbols: SPANS,
      lines: CLASS_FILE,
    });
    expect(enrichment?.scope).toBeUndefined();
  });

  it("gives a gap-sweep chunk (no symbol) no signature or docstring", () => {
    // A window chunk over a module header has no symbol; claiming one would put misleading
    // text into the vector, which is worse than putting nothing.
    const enrichment = deriveEnrichment({ startLine: 1, endLine: 2, symbols: SPANS, lines: CLASS_FILE, language: "TypeScript" });
    expect(enrichment?.signature).toBeUndefined();
    expect(enrichment?.docstring).toBeUndefined();
    expect(enrichment?.language).toBe("TypeScript");
  });

  it("returns undefined when nothing at all could be derived (absent, not hollow)", () => {
    expect(deriveEnrichment({ startLine: 1, endLine: 1, symbols: [], lines: [] })).toBeUndefined();
  });
});

describe("deriveEnrichment — signature", () => {
  it("uses the PARSER's signature, never the first line of the chunk", () => {
    const enrichment = deriveEnrichment({ startLine: 6, endLine: 10, symbolName: "AuthService", symbols: SPANS, lines: CLASS_FILE });
    expect(enrichment?.signature).toBe("export class AuthService {");
  });

  it("omits it when the symbol has none (e.g. a re-export with no declaration line)", () => {
    const enrichment = deriveEnrichment({
      startLine: 1,
      endLine: 1,
      symbolName: "reexported",
      symbols: [{ name: "reexported", startLine: 1, endLine: 1 }],
      lines: ["export { reexported } from './x';"],
    });
    expect(enrichment?.signature).toBeUndefined();
  });

  it("carries the signature into a LATER sub-chunk of a split symbol", () => {
    // This is the headline case: sub-chunk 2 of a large class is a body fragment with no name
    // in it, so without this the symbol is unfindable through the part that answers the query.
    const enrichment = deriveEnrichment({
      startLine: 8,
      endLine: 9,
      symbolName: "AuthService",
      symbols: SPANS,
      lines: CLASS_FILE,
    });
    expect(enrichment?.signature).toBe("export class AuthService {");
  });
});

describe("deriveEnrichment — docstring", () => {
  it("picks up a leading /** */ block, markers stripped and whitespace collapsed", () => {
    const enrichment = deriveEnrichment({ startLine: 6, endLine: 10, symbolName: "AuthService", symbols: SPANS, lines: CLASS_FILE });
    expect(enrichment?.docstring).toBe("Issues and refreshes bearer tokens.");
  });

  it("picks up contiguous // lines", () => {
    const lines = ["// Parses a JWT header.", "// Returns null when malformed.", "export function parseHeader() {}"];
    const enrichment = deriveEnrichment({
      startLine: 3,
      endLine: 3,
      symbolName: "parseHeader",
      symbols: [{ name: "parseHeader", startLine: 3, endLine: 3 }],
      lines,
    });
    expect(enrichment?.docstring).toBe("Parses a JWT header. Returns null when malformed.");
  });

  it("stops at a blank line, so it cannot steal the previous declaration's comment", () => {
    const lines = ["// Belongs to somethingElse.", "", "export function target() {}"];
    const enrichment = deriveEnrichment({
      startLine: 3,
      endLine: 3,
      symbolName: "target",
      symbols: [{ name: "target", startLine: 3, endLine: 3 }],
      lines,
    });
    expect(enrichment?.docstring).toBeUndefined();
  });

  it("does not treat real code above a declaration as a doc comment", () => {
    const lines = ["const x = 1;", "export function target() {}"];
    const enrichment = deriveEnrichment({
      startLine: 2,
      endLine: 2,
      symbolName: "target",
      symbols: [{ name: "target", startLine: 2, endLine: 2 }],
      lines,
    });
    expect(enrichment?.docstring).toBeUndefined();
  });

  it("reads a Python docstring from inside the span (multi-line and single-line)", () => {
    const multi = ["def get(url):", '    """Send a GET request.', "", '    Returns a Response."""', "    pass"];
    expect(
      deriveEnrichment({ startLine: 1, endLine: 5, symbolName: "get", symbols: [{ name: "get", startLine: 1, endLine: 5 }], lines: multi })
        ?.docstring,
    ).toBe("Send a GET request. Returns a Response.");

    const single = ["def head(url):", "    '''Send a HEAD request.'''", "    pass"];
    expect(
      deriveEnrichment({ startLine: 1, endLine: 3, symbolName: "head", symbols: [{ name: "head", startLine: 1, endLine: 3 }], lines: single })
        ?.docstring,
    ).toBe("Send a HEAD request.");
  });

  it("prefers a leading comment over an inner docstring when both exist", () => {
    const lines = ["# Module-level note.", "def f():", '    """Inner."""', "    pass"];
    expect(
      deriveEnrichment({ startLine: 2, endLine: 4, symbolName: "f", symbols: [{ name: "f", startLine: 2, endLine: 4 }], lines })?.docstring,
    ).toBe("Module-level note.");
  });

  it("gives a LATER sub-chunk no docstring, so split sub-chunks do not all look alike", () => {
    // Repeating one docstring across five sub-chunks makes them near-identical to the vector,
    // which is exactly the redundancy MMR then has to undo.
    const enrichment = deriveEnrichment({ startLine: 8, endLine: 9, symbolName: "AuthService", symbols: SPANS, lines: CLASS_FILE });
    expect(enrichment?.docstring).toBeUndefined();
  });

  it("truncates a very long docstring rather than letting it dominate the vector", () => {
    const long = "x".repeat(1000);
    const lines = [`// ${long}`, "export function f() {}"];
    const enrichment = deriveEnrichment({
      startLine: 2,
      endLine: 2,
      symbolName: "f",
      symbols: [{ name: "f", startLine: 2, endLine: 2 }],
      lines,
      maxDocChars: 50,
    });
    expect(enrichment?.docstring).toHaveLength(50);
    expect(enrichment?.docstring?.endsWith("…")).toBe(true);
  });
});

// V3-FINAL: `stripCommentMarkers` dropped its trailing block terminator with `/\*+\/$/`, which
// starts a match attempt at every position in a run of asterisks -- 159 ms at 16 000 characters,
// on comment text that comes from an untrusted repository. Asserted through `deriveEnrichment`
// rather than the private helper, so the assertion covers the live path.
describe("comment markers", () => {
  const enrich = (comment: string) =>
    deriveEnrichment({
      startLine: 2,
      endLine: 2,
      symbolName: "f",
      symbols: [{ name: "f", startLine: 2, endLine: 2 }],
      lines: [comment, "function f() {}"],
      maxDocChars: 500,
    })?.docstring;

  it("strips a one-line block comment from both ends", () => {
    expect(enrich("/** hello **/")).toBe("hello");
    expect(enrich("/* hello */")).toBe("hello");
    expect(enrich("// hello")).toBe("hello");
    expect(enrich("# hello")).toBe("hello");
  });

  it("does not stall on a comment that is one long run of asterisks", () => {
    const hostile = `/**${"*".repeat(200_000)} note **/`;
    const started = performance.now();
    const docstring = enrich(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(docstring).toBe("note");
  });
});
