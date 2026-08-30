import type { Language, Parser as ParserType } from "web-tree-sitter";
import { Language as TsLanguage, Parser as TsParser } from "web-tree-sitter";

/**
 * The languages a tree-sitter grammar is loaded for. Everything else (and any grammar
 * that fails to load) keeps using the regex parsers, so COVERAGE NEVER REGRESSES.
 *
 * `jsx` deliberately maps onto the JavaScript grammar: tree-sitter-javascript parses JSX
 * natively, so there is no separate jsx grammar to ship.
 */
export type TreeSitterLanguageId = "javascript" | "jsx" | "typescript" | "tsx" | "python";

export const TREE_SITTER_LANGUAGES: TreeSitterLanguageId[] = [
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "python",
];

/** Grammar wasm filename per language (jsx shares the JavaScript grammar). */
const GRAMMAR_FILE: Record<TreeSitterLanguageId, string> = {
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
};

/**
 * Resolves a grammar wasm filename to something `Language.load` accepts: a filesystem
 * path / URL string, or the raw bytes. Injectable so the SAME code runs in the Node
 * worker (default: resolve out of node_modules) and in a browser (pass a URL builder or
 * pre-fetched bytes) — the local-first mode that lands later.
 */
export type WasmLocator = (file: string) => string | Uint8Array | Promise<string | Uint8Array>;

export interface InitTreeSitterOptions {
  /** Override where grammar `.wasm` files come from (browser / bundler builds). */
  locateWasm?: WasmLocator;
  /** Passed through to `Parser.init` (e.g. a `locateFile` for the runtime wasm). */
  moduleOptions?: Parameters<typeof TsParser.init>[0];
}

export interface TreeSitterStatus {
  /** True when at least one grammar loaded. */
  ready: boolean;
  /** Languages with a usable grammar, sorted. */
  loaded: TreeSitterLanguageId[];
  /** Languages whose grammar could not be loaded, with the reason (they fall back). */
  failed: Array<{ language: TreeSitterLanguageId; reason: string }>;
}

interface LoadedGrammar {
  language: Language;
  /** One reusable Parser per language — creating one per file is needless wasm churn. */
  parser: ParserType;
}

const grammars = new Map<TreeSitterLanguageId, LoadedGrammar>();
let initPromise: Promise<TreeSitterStatus> | null = null;
let status: TreeSitterStatus = { ready: false, loaded: [], failed: [] };

/**
 * Load the tree-sitter runtime + the grammar wasms. Idempotent: concurrent and repeat
 * calls share one load. NEVER throws for a missing/incompatible grammar — it records the
 * failure and that language keeps using its regex parser.
 *
 * Loading is async (wasm), but `parseFile` stays SYNCHRONOUS afterwards, which is what
 * keeps the `ParserAdapter` contract unchanged.
 */
export function initTreeSitter(options: InitTreeSitterOptions = {}): Promise<TreeSitterStatus> {
  initPromise ??= loadAll(options).catch((error: unknown) => {
    // A runtime-level failure (no wasm at all) is still not fatal: every language falls
    // back to regex. Record it and let callers see `ready: false`.
    status = {
      ready: false,
      loaded: [],
      failed: TREE_SITTER_LANGUAGES.map((language) => ({ language, reason: messageOf(error) })),
    };
    return status;
  });
  return initPromise;
}

async function loadAll(options: InitTreeSitterOptions): Promise<TreeSitterStatus> {
  await TsParser.init(options.moduleOptions);
  const locate = options.locateWasm ?? defaultLocator;

  const loaded: TreeSitterLanguageId[] = [];
  const failed: TreeSitterStatus["failed"] = [];
  // One Language per distinct wasm file (jsx reuses javascript's), but one Parser per
  // LanguageId so callers never share parser state across languages.
  const byFile = new Map<string, Language>();

  // Deterministic load order (also the order `loaded` is reported in).
  for (const language of TREE_SITTER_LANGUAGES) {
    const file = GRAMMAR_FILE[language];
    try {
      let grammar = byFile.get(file);
      if (!grammar) {
        grammar = await TsLanguage.load(await locate(file));
        byFile.set(file, grammar);
      }
      const parser = new TsParser();
      parser.setLanguage(grammar);
      grammars.set(language, { language: grammar, parser });
      loaded.push(language);
    } catch (error: unknown) {
      failed.push({ language, reason: messageOf(error) });
    }
  }

  status = { ready: loaded.length > 0, loaded, failed };
  return status;
}

/** Default (Node) locator: resolve the wasm out of the installed grammar package.
 *  `node:module` is imported lazily so this file stays importable in a browser bundle. */
const defaultLocator: WasmLocator = async (file) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  return require.resolve(`@vscode/tree-sitter-wasm/wasm/${file}`);
};

/** Current load status without triggering a load. */
export function treeSitterStatus(): TreeSitterStatus {
  return { ready: status.ready, loaded: [...status.loaded], failed: [...status.failed] };
}

/** True when `language` has a usable grammar right now. */
export function hasGrammar(language: string): language is TreeSitterLanguageId {
  return grammars.has(language as TreeSitterLanguageId);
}

/** The reusable parser for `language`, or undefined when it must fall back. */
export function grammarParser(language: string): ParserType | undefined {
  return grammars.get(language as TreeSitterLanguageId)?.parser;
}

/** Test seam: forget every loaded grammar so the fallback path can be exercised. */
export function resetTreeSitterForTests(): void {
  for (const entry of grammars.values()) entry.parser.delete();
  grammars.clear();
  initPromise = null;
  status = { ready: false, loaded: [], failed: [] };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "");
  return text || "grammar failed to load";
}
