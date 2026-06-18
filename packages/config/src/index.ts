// Re-export barrel (matches @codeflow/graph, @codeflow/parsers): the public surface is a
// re-export from a sibling module, never value declarations in this file. This keeps the
// emitted index.d.ts a re-export (`export * from "./constants.js"`) rather than a set of
// `export declare const`s — so when a TS-aware loader (tsx) resolves the package through the
// `exports` "types" condition and loads index.d.ts at runtime, it follows the re-export to the
// real constants.js and the named exports resolve (otherwise the declarations erase to nothing).
export * from "./constants.js";
