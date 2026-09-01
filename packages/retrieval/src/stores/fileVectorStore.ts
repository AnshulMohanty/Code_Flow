import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChunkTextRecord,
  ChunkTextStore,
  EmbeddingSpace,
  VectorQuery,
  VectorRecord,
  VectorSearchHit,
  VectorStore,
} from "../contracts.js";
import { assertVectorDimension } from "../homogeneity.js";
import { cosineSimilarity } from "../vectorMath.js";

/**
 * THE EMBEDDED, FILE-BACKED VECTOR STORE (V3-P5 task 4) — local-first, zero egress.
 *
 * WHY THIS AND NOT LANCEDB, which V3_PLAN §5 named. Probed with the same discipline as the
 * tree-sitter grammars and the reranker, and rejected on the evidence:
 *
 *   `@lancedb/lancedb@0.37.1` installs **656 MB** of node_modules, ships a platform-specific Rust
 *   NAPI binary (`lancedb.win32-x64-msvc.node`), and drags in `onnxruntime-node` — the exact 211 MB
 *   package rejected in V3-P2 — plus `sharp`, with THREE install scripts between them. It brings
 *   back everything two earlier probes already ruled out, for a local CLI whose entire selling point
 *   is that it runs on a developer's laptop with no toolchain.
 *
 * So the swap the V3-P2 `VectorStore` interface was built for happens — just with a backend the
 * probe supports. This is a plain JSON file per namespace plus an exact cosine scan. Honest about
 * what that is: O(n) per query and wrong for a million chunks. For a local CLI over one repository
 * it is correct, dependency-free, inspectable with `cat`, and it makes the "zero code egress" claim
 * checkable rather than asserted — there is no client, no socket, and no protocol to audit.
 *
 * The interface is the same one pgvector implements, so a future LanceDB (or sqlite-vec, or a
 * WASM ANN index) adapter is a new file and nothing else. That is the payoff for having built the
 * interface first.
 *
 * DETERMINISTIC: same total order as every other store (cosine descending, ties by id), so a local
 * run and a hosted run rank identically given the same vectors.
 */

export interface FileVectorStoreOptions {
  /** Directory the namespace files live in. Created on first write. */
  directory: string;
  space: EmbeddingSpace;
}

/** What a namespace file holds. Versioned, so a format change is detectable rather than a crash. */
interface VectorFile {
  fileFormat: 1;
  embeddingModel: string;
  embeddingDim: number;
  records: VectorRecord[];
}

/** Namespaces contain `/` and `@`; a filename cannot. Encoded rather than hashed, so a human can
 *  still tell which file belongs to which repository by looking at the directory. */
function namespaceFile(directory: string, namespace: string): string {
  return path.join(directory, `${namespace.replace(/[^a-zA-Z0-9._@-]+/g, "_")}.vectors.json`);
}

export function createFileVectorStore(options: FileVectorStoreOptions): VectorStore {
  const { directory, space } = options;

  const load = async (namespace: string): Promise<VectorRecord[]> => {
    try {
      const raw = await readFile(namespaceFile(directory, namespace), "utf8");
      const parsed = JSON.parse(raw) as VectorFile;
      // A file from a DIFFERENT embedding space is not usable, and silently scanning it would
      // produce a confident meaningless ranking — the exact failure the homogeneity guard exists
      // for. Treated as absent, with the reason discoverable from the file itself.
      if (parsed.fileFormat !== 1) return [];
      if (parsed.embeddingModel !== space.embeddingModel || parsed.embeddingDim !== space.embeddingDim) return [];
      return parsed.records;
    } catch {
      // Missing or unreadable ⇒ an empty namespace. A local CLI must not fail because an index has
      // not been built yet; that is the normal first-run state.
      return [];
    }
  };

  const save = async (namespace: string, records: VectorRecord[]): Promise<void> => {
    await mkdir(directory, { recursive: true });
    const payload: VectorFile = {
      fileFormat: 1,
      embeddingModel: space.embeddingModel,
      embeddingDim: space.embeddingDim,
      // Sorted on disk, so two runs over the same repository produce byte-identical files and a
      // diff of the index is readable.
      records: [...records].sort((a, b) => a.id.localeCompare(b.id)),
    };
    await writeFile(namespaceFile(directory, namespace), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
  };

  return {
    id: "file-vector-store",
    space,

    async upsert(namespace, records) {
      for (const record of records) {
        assertVectorDimension(record.vector, space, `file-vector-store upsert of chunk ${record.id}`);
      }
      const existing = await load(namespace);
      const byId = new Map(existing.map((record) => [record.id, record]));
      for (const record of records) byId.set(record.id, { ...record, vector: [...record.vector] });
      await save(namespace, [...byId.values()]);
    },

    async search(namespace, query: VectorQuery): Promise<VectorSearchHit[]> {
      assertVectorDimension(query.vector, space, "file-vector-store search");
      if (query.k <= 0) return [];
      const records = await load(namespace);
      // An explicitly EMPTY filter means nothing is allowed, not "no filter" — same rule as every
      // other store, so a scoped search behaves identically wherever it runs.
      const allowed = query.filter?.fileIds ? new Set(query.filter.fileIds) : null;
      if (allowed && allowed.size === 0) return [];

      const hits: VectorSearchHit[] = [];
      for (const record of records) {
        if (allowed && !allowed.has(record.fileId)) continue;
        hits.push({
          id: record.id,
          score: cosineSimilarity(query.vector, record.vector),
          fileId: record.fileId,
          startLine: record.startLine,
          endLine: record.endLine,
          ...(record.symbolName ? { symbolName: record.symbolName } : {}),
        });
      }
      hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return hits.slice(0, query.k);
    },

    async count(namespace) {
      return (await load(namespace)).length;
    },

    async drop(namespace) {
      // Written as an EMPTY namespace rather than unlinked: the file's presence records that this
      // repository was indexed here, and a `cat` of it still explains the embedding space.
      await save(namespace, []);
    },
  };
}

/** The chunk-text half, same file-per-namespace shape. */
interface TextFile {
  fileFormat: 1;
  texts: Record<string, string>;
}

export function createFileChunkTextStore(options: { directory: string }): ChunkTextStore {
  const file = (namespace: string) =>
    path.join(options.directory, `${namespace.replace(/[^a-zA-Z0-9._@-]+/g, "_")}.text.json`);

  const load = async (namespace: string): Promise<Record<string, string>> => {
    try {
      const parsed = JSON.parse(await readFile(file(namespace), "utf8")) as TextFile;
      return parsed.fileFormat === 1 ? parsed.texts : {};
    } catch {
      return {};
    }
  };

  return {
    id: "file-chunk-text-store",

    async put(namespace, records: readonly ChunkTextRecord[]) {
      await mkdir(options.directory, { recursive: true });
      const texts = await load(namespace);
      for (const record of records) texts[record.id] = record.text;
      // Keys sorted, so the file is stable across runs and diffable.
      const sorted: Record<string, string> = {};
      for (const key of Object.keys(texts).sort()) sorted[key] = texts[key];
      await writeFile(file(namespace), `${JSON.stringify({ fileFormat: 1, texts: sorted } satisfies TextFile, null, 1)}\n`, "utf8");
    },

    async get(namespace, ids) {
      const texts = await load(namespace);
      const out = new Map<string, string>();
      for (const id of ids) {
        const text = texts[id];
        // Omitted when absent, never defaulted to "" — an empty chunk in a prompt lets a model cite
        // code it never read. Same rule as every other text store.
        if (text !== undefined) out.set(id, text);
      }
      return out;
    },

    async drop(namespace) {
      await mkdir(options.directory, { recursive: true });
      await writeFile(file(namespace), `${JSON.stringify({ fileFormat: 1, texts: {} } satisfies TextFile, null, 1)}\n`, "utf8");
    },
  };
}
