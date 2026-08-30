// CLI: `pnpm --filter @codeflow/eval run parity` — prints the parser-parity report and
// exits non-zero if tree-sitter regressed against the regex baseline on any aggregate
// metric.
//
// Unlike `pnpm eval`, this needs NO keys, NO repo clone and NO network: the corpus is
// authored source strings and the grammars are local wasm. It is safe in CI.

import { runParserParity } from "./parserParity.js";

async function main(): Promise<void> {
  const report = await runParserParity();
  const verbose = process.argv.includes("--json");
  if (verbose) console.log(JSON.stringify(report, null, 2));

  console.log(report.summary);
  console.log("\nper case:");
  for (const result of report.perCase) {
    console.log(
      `  ${result.id.padEnd(22)} ${result.engine.padEnd(11)} (${result.parserVersion})` +
        ` symbols R=${(result.symbols.recall * 100).toFixed(0)}%` +
        ` P=${(result.symbols.precision * 100).toFixed(0)}%` +
        ` imports R=${(result.imports.recall * 100).toFixed(0)}%` +
        ` P=${(result.imports.precision * 100).toFixed(0)}%` +
        (result.symbols.missed.length ? ` missed=[${result.symbols.missed.join(",")}]` : "") +
        (result.symbols.spurious.length ? ` spurious=[${result.symbols.spurious.join(",")}]` : ""),
    );
  }

  if (!report.treeSitterAtLeastAsGood) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown parity error.";
  console.error(`parity failed: ${message}`);
  process.exit(1);
});
