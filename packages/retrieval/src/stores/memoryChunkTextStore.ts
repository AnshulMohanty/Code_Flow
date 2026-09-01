import type { ChunkTextRecord, ChunkTextStore } from "../contracts.js";

/**
 * The in-memory `ChunkTextStore` — hermetic default, and the partner of
 * `createMemoryVectorStore`. Same reasoning: the query path must be exercised for real in the
 * suite, and text lookup is a keyed read, so a Map is a faithful stand-in for a primary-key
 * SELECT.
 *
 * `get` omits ids it does not hold rather than returning an empty string for them. That
 * distinction matters: an empty string would sail into a prompt as a chunk with no content,
 * and the answer would cite a file it never actually read. A missing id is a real condition
 * (an index written by an older run, a partially-failed upsert) and the caller must see it.
 */
export function createMemoryChunkTextStore(): ChunkTextStore {
  const namespaces = new Map<string, Map<string, string>>();

  return {
    id: "memory-chunk-text-store",

    async put(namespace: string, records: readonly ChunkTextRecord[]): Promise<void> {
      let bucket = namespaces.get(namespace);
      if (!bucket) {
        bucket = new Map<string, string>();
        namespaces.set(namespace, bucket);
      }
      for (const record of records) bucket.set(record.id, record.text);
    },

    async get(namespace: string, ids: readonly string[]): Promise<Map<string, string>> {
      const bucket = namespaces.get(namespace);
      const out = new Map<string, string>();
      if (!bucket) return out;
      for (const id of ids) {
        const text = bucket.get(id);
        if (text !== undefined) out.set(id, text);
      }
      return out;
    },

    async drop(namespace: string): Promise<void> {
      namespaces.delete(namespace);
    },
  };
}
