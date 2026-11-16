import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FactsStore } from "@codeflow/parsers";

/**
 * The CLI's incremental cache: one small JSON file per parsed file, under `<dir>/<2 hex>/<hash>.json`.
 * A re-run reads these instead of parsing every file again; only changed files are parsed. Entries are
 * keyed by content (and analyzer version), so a stale entry is never served — it is just never read.
 * Writes go to a temp name and are renamed, so an interrupted run cannot leave a half-written entry.
 * Any read or write failure degrades to "not cached", never to a failed analysis.
 */
export function createDirectoryFactsStore(dir: string): FactsStore {
  const fileFor = (key: string) => {
    const hash = createHash("sha1").update(key).digest("hex");
    return path.join(dir, hash.slice(0, 2), `${hash.slice(2)}.json`);
  };
  return {
    get(key) {
      try {
        return JSON.parse(readFileSync(fileFor(key), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      const file = fileFor(key);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(value));
        renameSync(temp, file);
      } catch {
        // A cache that cannot be written is a slower next run, not a failed one.
      }
    },
  };
}
