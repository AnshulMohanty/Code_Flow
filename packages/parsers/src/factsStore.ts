import { ANALYZER_VERSION } from "@codeflow/config";

/**
 * INCREMENTAL ANALYSIS. Parsing is the expensive part of a run; for a file whose content did not
 * change, its parse output (Inventory's `ParsedFile`, Connect's `CpgFacts`) is the same as last time.
 * A `FactsStore` keeps those outputs by (kind, analyzer version, language, path, content hash), so
 * a re-run parses only the files that changed. The parsers package stays filesystem-free: the CLI
 * plugs in a directory, `impact` an in-memory map shared by its head and base analyses.
 *
 * `ANALYZER_VERSION` is in the key, so any change to parser output (which must bump it) can never
 * be served from an older cache.
 */
export interface FactsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

let store: FactsStore | null = null;
let hits = 0;
let misses = 0;

/** Install (or with null, remove) the store consulted by `parseFile` and `extractCpgFacts`. */
export function setFactsStore(next: FactsStore | null): void {
  store = next;
  hits = 0;
  misses = 0;
}

export function factsStoreStats(): { hits: number; misses: number } {
  return { hits, misses };
}

/** `compute` runs only on a miss; its result is stored for next time. */
export function throughFactsStore<T>(kind: "parsed" | "facts", language: string, path: string, content: string, compute: () => T): T {
  if (!store) return compute();
  const key = `${kind}\u0000${ANALYZER_VERSION}\u0000${language}\u0000${path}\u0000${content.length}\u0000${contentHash(content)}`;
  const cached = store.get(key);
  if (cached !== undefined) {
    hits += 1;
    return cached as T;
  }
  misses += 1;
  const value = compute();
  store.set(key, value);
  return value;
}

/** In-memory store: one process, several analyses (`impact` runs head and base). */
export function createMemoryFactsStore(): FactsStore {
  const entries = new Map<string, unknown>();
  return { get: (key) => entries.get(key), set: (key, value) => void entries.set(key, value) };
}

/** Two independent 32-bit FNV-1a passes → 64 bits; with path and length in the key as well. */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}
