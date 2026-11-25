/**
 * PARSE ONCE. Inventory (symbols) and Connect (graph facts) both need every file's syntax tree, and
 * each used to parse it — on Kubernetes that was 13.5 s of a 33 s run spent parsing twice. For the
 * languages whose two views come from one extract (Go, Java, C/C++), Inventory's extract is kept here
 * and Connect TAKES it: consume-once, so nothing outlives the run that made it.
 *
 * The key is (language, path, length, content hash). A different revision of the same path — the
 * base checkout `impact` analyses beside the head — has different content, so a different key.
 * Bounded FIFO: an entry nobody takes (a run that failed between the two stages) is evicted.
 */
const MAX_ENTRIES = 100_000;
const entries = new Map<string, unknown>();

export function extractKey(language: string, path: string, content: string): string {
  return `${language}\u0000${path}\u0000${content.length}\u0000${fnv1a(content)}`;
}

export function rememberExtract(key: string, extract: unknown): void {
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  entries.set(key, extract);
}

export function takeExtract<T>(key: string): T | undefined {
  const value = entries.get(key);
  if (value !== undefined) entries.delete(key);
  return value as T | undefined;
}

export function extractCacheSize(): number {
  return entries.size;
}

export function clearExtractCacheForTests(): void {
  entries.clear();
}

/** 32-bit FNV-1a over UTF-16 code units. With path and length in the key, a collision needs both to match too. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
