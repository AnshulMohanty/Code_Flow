import { readFile } from "node:fs/promises";
import type { ParsedFile } from "@codeflow/shared-types";
import { discoverSourceFiles } from "./filesystem/fileDiscovery.js";
import { genericParser } from "./parsers/genericParser.js";
import { javascriptParser } from "./parsers/javascriptParser.js";
import { jsxParser, tsxParser, typescriptParser } from "./parsers/typescriptParser.js";
import { pythonParser } from "./parsers/pythonParser.js";
import { createTreeSitterParser } from "./treesitter/parseTreeSitter.js";
import { initTreeSitter, type InitTreeSitterOptions, type TreeSitterStatus } from "./treesitter/runtime.js";
import type { ParseFileInput, ParseRepositoryOptions, ParserAdapter } from "./types.js";
import { extensionOf } from "./utils/pathUtils.js";

/**
 * The default parser set. Every language that HAS a tree-sitter grammar is wrapped so
 * tree-sitter runs when its grammar is loaded and the regex parser runs otherwise — one
 * `ParserAdapter` either way, so coverage never regresses and the contract is unchanged.
 * `genericParser` (LOC + TODO warnings only) stays the catch-all for everything else.
 */
const DEFAULT_PARSERS = [
  createTreeSitterParser(javascriptParser),
  createTreeSitterParser(jsxParser),
  createTreeSitterParser(typescriptParser),
  createTreeSitterParser(tsxParser),
  createTreeSitterParser(pythonParser),
  genericParser,
];

export class ParserRegistry {
  private readonly parsers: ParserAdapter[];

  constructor(parsers: ParserAdapter[] = DEFAULT_PARSERS) {
    this.parsers = parsers;
  }

  /**
   * Load the tree-sitter grammars, once, before parsing. Safe to call repeatedly and
   * from several stages — the underlying load is shared and idempotent. Skipping it is
   * not an error: every parser falls back to its regex engine.
   */
  async ready(options?: InitTreeSitterOptions): Promise<TreeSitterStatus> {
    return initTreeSitter(options);
  }

  getParserForPath(filePath: string) {
    const extension = extensionOf(filePath);
    return this.parsers.find((parser) => parser.extensions.includes(extension)) ?? genericParser;
  }

  parseFile(input: ParseFileInput) {
    return this.getParserForPath(input.path).parseFile(input);
  }

  async parseRepository(repoRoot: string, options: ParseRepositoryOptions = {}): Promise<ParsedFile[]> {
    await this.ready();
    const files = await discoverSourceFiles(repoRoot, options);
    const parsedFiles: ParsedFile[] = [];

    for (const file of files) {
      const content = await readFile(file.absolutePath, "utf8").catch(() => "");
      parsedFiles.push(
        this.parseFile({
          path: file.path,
          absolutePath: file.absolutePath,
          content,
          repoRoot,
        }),
      );
    }

    return parsedFiles;
  }
}

export function createParserRegistry(parsers?: ParserAdapter[]) {
  return new ParserRegistry(parsers);
}

export async function parseRepository(repoRoot: string, options: ParseRepositoryOptions = {}) {
  return createParserRegistry().parseRepository(repoRoot, options);
}
