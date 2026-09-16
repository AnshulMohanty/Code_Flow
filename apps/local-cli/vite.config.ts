import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/**
 * THE PUBLISHABLE BUNDLE.
 *
 * WHY A BUNDLE AT ALL, when `tsc` already emits a working `dist/index.js`. That output imports
 * `@codeflow/parsers`, `@codeflow/graph`, `@codeflow/analyzers` and friends — every one of which is
 * `private: true` and has never been published. `npm i -g codeflow-local` would resolve those from
 * the public registry, find nothing, and fail at install. The package is only installable if the
 * workspace graph is compiled INTO it.
 *
 * WHAT STAYS EXTERNAL, and why exactly these:
 *   - Node builtins, obviously.
 *   - `web-tree-sitter` and `@vscode/tree-sitter-wasm`. These are real, published npm packages, and
 *     the second is loaded by PATH at runtime (`require.resolve("@vscode/tree-sitter-wasm/wasm/...")`
 *     in parsers/treesitter/runtime.ts) rather than by import — a bundler cannot inline a file that
 *     is read from disk by name. They are therefore declared as the package's only two runtime
 *     dependencies, which is also an accurate statement of what it needs.
 *
 * WHAT THIS DOES NOT CHANGE: the zero-egress guarantee. Bundling cannot introduce a network client
 * that was not in the import graph, and `__tests__/zeroEgress.test.ts` asserts against the SOURCE
 * graph rather than the bundle, so the property is checked where it is decided.
 *
 * SSR TARGET, not a browser build: this is a Node CLI. That keeps `node:` imports intact and stops
 * Vite polyfilling anything.
 */
const EXTERNAL = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "web-tree-sitter",
  /^@vscode\/tree-sitter-wasm/,
];

export default defineConfig({
  build: {
    ssr: true,
    outDir: "bundle",
    emptyOutDir: true,
    target: "node20",
    // Not minified, deliberately. This is a tool whose central claim is that it sends nothing
    // anywhere, and the cheapest way for anyone to check that is to read the file they installed.
    minify: false,
    sourcemap: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
    },
    rollupOptions: {
      external: EXTERNAL,
      // The filename is set HERE rather than via `lib.fileName`, which Vite ignores for an SSR
      // library build — it emitted `index.js` and the bin entry pointed at a file that did not
      // exist. `.mjs` so Node reads it as ESM regardless of the consumer's package type.
      output: { entryFileNames: "codeflow-local.mjs" },
      // NO `output.banner` with a shebang here: Rollup already carries the one from src/index.ts
      // through to the bundle, and adding a second produces two on consecutive lines — which esbuild
      // rejects outright, since only the first line of a file may be a shebang.
    },
  },
});
