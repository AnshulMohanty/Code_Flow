import { createHash } from "node:crypto";

/** What the content-addressed embedding cache stores per text. */
export interface CachedEmbedding {
  embedding: number[];
  model: string;
  dim: number;
}

/**
 * Content-addressed embedding-cache key. Scoped by provider + model + output dimension AND
 * **input_type** — a "query" and a "document" with identical text produce DIFFERENT vectors
 * (the provider prepends a task-specific prompt), so they must never collide on the same hash
 * and serve each other's vectors. The `v1` segment is a manual bust. Adding the input_type
 * segment (P18) changes document-side keys too ⇒ a one-time re-embed on the next real run.
 */
export function embedCacheKey(
  provider: string,
  model: string,
  dim: number,
  inputType: "document" | "query",
  text: string,
): string {
  return `embed/${provider}/${model}/${dim}/${inputType}/v1/${sha256(normalizeEmbedText(text))}`;
}

/** Normalize text for the content hash (CRLF → LF) so the same logical content addresses the
 *  same vector across platforms. Must be byte-deterministic or the cache silently misses. */
export function normalizeEmbedText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
