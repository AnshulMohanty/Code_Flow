import type { RepositoryRef } from "@codeflow/shared-types";

/**
 * CITATION → CODE (V3-FINAL).
 *
 * Every file:line the UI shows is a LINK to those exact lines. That is not polish — it is the
 * product's central claim made checkable: "if it can't cite a real file:line, it doesn't say it"
 * only means something if a reader can follow the citation and see the code.
 *
 * WHY GITHUB AND NOT A LOCAL VIEWER. The server clones a public repository, analyses it, and DELETES
 * the working tree; the analysis result keeps paths and line ranges, never file contents (that was a
 * deliberate V3-P2 decision — chunk text lives in the retrieval store, keyed by chunk id, not in the
 * document). So there is no local source of truth to render from, and building one would mean either
 * shipping code bytes into the analysis document or re-cloning on a click. The commit SHA is pinned
 * in the URL, so the lines a reader lands on are the lines that were analysed — not whatever HEAD
 * says today, which is the mistake a branch-based link would make.
 *
 * A link is only built when every part of it is REAL: a provider we know how to address, an
 * owner/name, and a pinned SHA. Missing any of those returns null and the chip renders as plain
 * text — a dead link on a citation would be worse than no link, because it looks verifiable.
 */

export interface CitationTarget {
  fileId: string;
  startLine?: number;
  endLine?: number;
}

export interface CitationContext {
  repository: RepositoryRef;
  commitSha?: string | null;
}

export function citationUrl(target: CitationTarget, context: CitationContext): string | null {
  const { repository, commitSha } = context;
  // Only GitHub. `local` and `zip` refs have no addressable web view, and guessing a URL scheme for
  // them would produce a link that 404s while looking authoritative.
  if (repository.provider !== "github") return null;
  if (!repository.owner || !repository.name) return null;
  if (!commitSha) return null;

  const path = target.fileId.split("/").map(encodeURIComponent).join("/");
  const base = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/blob/${commitSha}/${path}`;
  if (target.startLine === undefined) return base;
  const end = target.endLine !== undefined && target.endLine !== target.startLine ? `-L${target.endLine}` : "";
  return `${base}#L${target.startLine}${end}`;
}

/** `path/to/file.ts:48` or `path/to/file.ts:48-61`. The form the design shows on a chip. */
export function citationLabel(target: CitationTarget): string {
  if (target.startLine === undefined) return target.fileId;
  const range =
    target.endLine !== undefined && target.endLine !== target.startLine
      ? `${target.startLine}-${target.endLine}`
      : `${target.startLine}`;
  return `${target.fileId}:${range}`;
}

/** The module name a diagram shows: the directory-and-file, without the extension. */
export function moduleLabel(fileId: string): string {
  const withoutExtension = fileId.replace(/\.[^./]+$/, "");
  const parts = withoutExtension.split("/");
  return parts.length <= 2 ? withoutExtension : parts.slice(-2).join("/");
}
