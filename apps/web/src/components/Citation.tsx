import type { RepositoryRef } from "@codeflow/shared-types";
import { citationLabel, citationUrl, type CitationTarget } from "../lib/citation";

/**
 * A CITATION CHIP — `⌗ auth/session/verify.ts:48`, and it goes somewhere.
 *
 * The product's claim is "if it can't cite a real file:line, it doesn't say it". A chip that looked
 * like a citation but did not resolve would undermine that more than showing no chip at all, so:
 *
 *   - When a URL can be built (GitHub ref, owner/name, pinned SHA) the chip is an `<a>` to those
 *     exact lines at the analysed commit — not at HEAD, which is a different file.
 *   - When it cannot, the chip renders as plain text. Same information, no false affordance.
 */

export interface CitationChipProps extends CitationTarget {
  repository: RepositoryRef;
  commitSha?: string | null;
}

export function CitationChip({ repository, commitSha, ...target }: CitationChipProps) {
  const href = citationUrl(target, { repository, commitSha });
  const label = citationLabel(target);
  const line = target.startLine === undefined ? null : label.slice(target.fileId.length);
  const body = (
    <>
      {target.fileId}
      {line ? <span className="cite-chip-line">{line}</span> : null}
    </>
  );

  if (!href) {
    return (
      <span
        className="cite-chip"
        title="No addressable source for this reference (the analysis recorded no commit, or the repository is not a GitHub ref)."
      >
        {body}
      </span>
    );
  }

  return (
    <a
      className="cite-chip"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${label} at the analysed commit`}
    >
      {body}
    </a>
  );
}
