import type { Language, Parser as ParserType } from "web-tree-sitter";
import { Language as TsLanguage, Parser as TsParser } from "web-tree-sitter";

/**
 * The languages a tree-sitter grammar is loaded for. Everything else (and any grammar
 * that fails to load) keeps using the regex parsers, so COVERAGE NEVER REGRESSES.
 *
 * `jsx` deliberately maps onto the JavaScript grammar: tree-sitter-javascript parses JSX
 * natively, so there is no separate jsx grammar to ship.
 */
export type TreeSitterLanguageId = "javascript" | "jsx" | "typescript" | "tsx" | "python" | "go" | "java";

export const TREE_SITTER_LANGUAGES: TreeSitterLanguageId[] = [
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "python",
  "go",
  "java",
];

/** Grammar wasm filename per language (jsx shares the JavaScript grammar). */
const GRAMMAR_FILE: Record<TreeSitterLanguageId, string> = {
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
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
  /**
   * Load only these grammars (the languages a repository actually contains). Omitted ⇒ every
   * supported grammar. Grammars differ by 25× in size (Go 0.2 MB, C++ 5.4 MB), so a pipeline
   * asks for what it needs; a warm server loads everything once.
   */
  languages?: readonly TreeSitterLanguageId[];
}

export interface TreeSitterStatus {
  /** True when at least one grammar loaded. */
  ready: boolean;
  /** Languages with a usable grammar, in `TREE_SITTER_LANGUAGES` order. */
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
const failures = new Map<TreeSitterLanguageId, string>();
/** One load per language, shared by concurrent callers. */
const loads = new Map<TreeSitterLanguageId, Promise<void>>();
/** One Language per distinct wasm file (jsx reuses javascript's). */
const byFile = new Map<string, Promise<Language>>();
let runtimeInit: Promise<void> | null = null;
let runtimeError: string | null = null;

/**
 * Load the tree-sitter runtime + the requested grammar wasms. Idempotent and incremental:
 * concurrent and repeat calls share each load, and a later call for a new language loads only
 * that one. NEVER throws for a missing/incompatible grammar — it records the failure and that
 * language keeps using its regex parser.
 *
 * Loading is async (wasm), but `parseFile` stays SYNCHRONOUS afterwards, which is what
 * keeps the `ParserAdapter` contract unchanged.
 */
export async function initTreeSitter(options: InitTreeSitterOptions = {}): Promise<TreeSitterStatus> {
  const wanted = options.languages ?? TREE_SITTER_LANGUAGES;
  runtimeInit ??= TsParser.init(options.moduleOptions).catch((error: unknown) => {
    // A runtime-level failure (no wasm at all) is still not fatal: every language falls back.
    runtimeError = messageOf(error);
  });
  await runtimeInit;
  if (runtimeError === null) {
    const locate = options.locateWasm ?? defaultLocator;
    await Promise.all(
      wanted.map((language) => {
        let load = loads.get(language);
        if (!load) {
          load = loadGrammar(language, locate);
          loads.set(language, load);
        }
        return load;
      }),
    );
  } else {
    for (const language of wanted) failures.set(language, runtimeError);
  }
  return treeSitterStatus();
}

async function loadGrammar(language: TreeSitterLanguageId, locate: WasmLocator): Promise<void> {
  const file = GRAMMAR_FILE[language];
  try {
    let grammar = byFile.get(file);
    if (!grammar) {
      grammar = Promise.resolve(locate(file)).then((source) => TsLanguage.load(source));
      byFile.set(file, grammar);
    }
    const parser = new TsParser();
    parser.setLanguage(await grammar);
    grammars.set(language, { language: await grammar, parser });
    failures.delete(language);
  } catch (error: unknown) {
    failures.set(language, messageOf(error));
  }
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
  const loaded = TREE_SITTER_LANGUAGES.filter((language) => grammars.has(language));
  const failed = TREE_SITTER_LANGUAGES.filter((language) => failures.has(language)).map((language) => ({
    language,
    reason: failures.get(language)!,
  }));
  return { ready: loaded.length > 0, loaded, failed };
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
  failures.clear();
  loads.clear();
  byFile.clear();
  runtimeInit = null;
  runtimeError = null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "");
  return text || "grammar failed to load";
}
