import type { NamespaceParts } from "./contracts.js";

/**
 * The canonical namespace string for an index.
 *
 * Four parts, and each one is load-bearing:
 *   - `repoFullName` + `commitSha` — an index is pinned to an exact tree. A namespace shared
 *     across SHAs would answer questions about code that has moved.
 *   - `embeddingModel` + `embeddingDim` — the SPACE. Two spaces in one namespace is the
 *     failure the homogeneity guard exists to prevent; making the space part of the key means
 *     re-indexing with a new model cannot corrupt the old index, it just writes a new one.
 *
 * Deterministic and filesystem/SQL-safe: lowercased, non-alphanumerics collapsed to `-`, so
 * the same inputs always produce the same namespace and it can be used as a plain text key.
 */
export function retrievalNamespace(parts: NamespaceParts): string {
  const repo = slug(parts.repoFullName);
  const sha = slug(parts.commitSha);
  const model = slug(parts.embeddingModel);
  return `${repo}@${sha}/${model}/${parts.embeddingDim}`;
}

/**
 * Lowercase and collapse anything outside a conservative safe set to `-`.
 *
 * `/` is deliberately KEPT: `owner/name` is how a repository is identified everywhere else in
 * this codebase, and collapsing the slash would make `acme/repo` and `acme-repo` share a
 * namespace — two different repositories answering each other's questions.
 */
function slug(value: string): string {
  // `repoFullName` is user-supplied, and the `-+$` half of `/^-+|-+$/g` started a match attempt
  // at every position in a run of dashes (20 ms at 4 000 characters, 221 ms at 16 000 -- and a
  // run of dashes is exactly what the collapse on the line above produces). Two pointers, one
  // pass, same result.
  return trimDashes(value.toLowerCase().replace(/[^a-z0-9._@/-]+/g, "-"));
}

/** Strip leading and trailing `-` runs -- what `.replace(/^-+|-+$/g, "")` did. */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}
