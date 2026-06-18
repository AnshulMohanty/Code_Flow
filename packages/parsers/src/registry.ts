import { readFile } from "node:fs/promises";
import type { ParsedFile } from "@codeflow/shared-types";
import { discoverSourceFiles } from "./filesystem/fileDiscovery.js";
import { genericParser } from "./parsers/genericParser.js";
import { javascriptParser } from "./parsers/javascriptParser.js";
import { jsxParser, tsxParser, typescriptParser } from "./parsers/typescriptParser.js";
import { pythonParser } from "./parsers/pythonParser.js";
import type { ParseFileInput, ParseRepositoryOptions, ParserAdapter } from "./types.js";
import { extensionOf } from "./utils/pathUtils.js";

const DEFAULT_PARSERS = [javascriptParser, jsxParser, typescriptParser, tsxParser, pythonParser, genericParser];

export class ParserRegistry {
  private readonly parsers: ParserAdapter[];

  constructor(parsers: ParserAdapter[] = DEFAULT_PARSERS) {
    this.parsers = parsers;
  }

  getParserForPath(filePath: string) {
    const extension = extensionOf(filePath);
    return this.parsers.find((parser) => parser.extensions.includes(extension)) ?? genericParser;
  }

  parseFile(input: ParseFileInput) {
    return this.getParserForPath(input.path).parseFile(input);
  }

  async parseRepository(repoRoot: string, options: ParseRepositoryOptions = {}): Promise<ParsedFile[]> {
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
