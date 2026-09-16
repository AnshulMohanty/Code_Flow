import { useCallback, useState } from "react";
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
 *
 * HOVERING IT OPENS A PEEK. See `CodePeek` below for what that peek can honestly contain.
 */

export interface CitationChipProps extends CitationTarget {
  repository: RepositoryRef;
  commitSha?: string | null;
}

export function CitationChip({ repository, commitSha, ...target }: CitationChipProps) {
  const href = citationUrl(target, { repository, commitSha });
  const label = citationLabel(target);
  const line = target.startLine === undefined ? null : label.slice(target.fileId.length);
  const [peekAt, setPeekAt] = useState<{ x: number; y: number } | null>(null);

  const open = useCallback((event: { currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPeekAt(peekPosition(rect));
  }, []);
  const close = useCallback(() => setPeekAt(null), []);

  // The same handlers on pointer and on keyboard focus: a citation is exactly the kind of detail a
  // keyboard reader wants the extra line-range context for, and hover-only would withhold it.
  const peekHandlers = {
    onMouseEnter: open,
    onMouseLeave: close,
    onFocus: open,
    onBlur: close,
  };

  const body = (
    <>
      {target.fileId}
      {line ? <span className="cite-chip-line">{line}</span> : null}
    </>
  );

  const peek = peekAt ? <CodePeek target={target} commitSha={commitSha} at={peekAt} /> : null;

  if (!href) {
    return (
      <>
        <span
          className="cite-chip"
          tabIndex={0}
          title="No addressable source for this reference (the analysis recorded no commit, or the repository is not a GitHub ref)."
          {...peekHandlers}
        >
          {body}
        </span>
        {peek}
      </>
    );
  }

  return (
    <>
      <a
        className="cite-chip"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={`Open ${label} at the analysed commit`}
        {...peekHandlers}
      >
        {body}
      </a>
      {peek}
    </>
  );
}

/**
 * THE PEEK — what this product can honestly show without the file in front of it.
 *
 * The design's peek shows source lines. THIS ONE DOES NOT, and the reason is a deliberate decision
 * further down the stack: the server clones a repository, analyses it and deletes the working tree,
 * and V3-P2 removed chunk `text` from the analysis document (a 1024-dim vector plus its text per
 * chunk pushed mid-sized repos past Mongo's 16MB BSON limit). What survives is the file and the line
 * range — which is exactly what a citation IS.
 *
 * So the peek shows the address in full: path, range, how many lines that is, and the commit those
 * lines were read at. Rendering six lines of plausible-looking source here instead would be the
 * single most damaging fabrication this UI could contain, because it would look like evidence.
 *
 * `pointer-events: none` — it is a peek, not a panel. It never sits between the reader and the chip
 * they are about to click, and it cannot trap focus.
 */
function CodePeek({
  target,
  commitSha,
  at,
}: {
  target: CitationTarget;
  commitSha?: string | null;
  at: { x: number; y: number };
}) {
  const lines =
    target.startLine !== undefined && target.endLine !== undefined
      ? target.endLine - target.startLine + 1
      : null;

  return (
    <div className="peek" aria-hidden="true" style={{ left: at.x, top: at.y }}>
      <div className="peek-head">
        <span aria-hidden="true">⌗</span>
        <span className="peek-path">{citationLabel(target)}</span>
        <span className="peek-head-note">read-only peek</span>
      </div>
      <div className="peek-body">
        <dl className="peek-facts">
          <dt>file</dt>
          <dd>{target.fileId}</dd>
          <dt>lines</dt>
          <dd>
            {target.startLine === undefined
              ? "whole file"
              : `${target.startLine}–${target.endLine ?? target.startLine}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"}` : ""}`}
          </dd>
          <dt>commit</dt>
          <dd>{commitSha ? `⌗${commitSha.slice(0, 7)}` : "not recorded"}</dd>
        </dl>
        <p className="peek-note">
          The analysis keeps the address, not the bytes — the working tree is deleted after a run.
          {commitSha ? " Follow the chip to read these exact lines at that commit." : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * Where the peek goes: above the chip when there is room, below it otherwise, and always fully on
 * screen. A popover that opens off the right edge of a narrow viewport is a popover nobody reads.
 */
export function peekPosition(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number } = {
    width: typeof window === "undefined" ? 1200 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  },
): { x: number; y: number } {
  const width = Math.min(430, viewport.width * 0.88);
  const height = 190;
  const x = Math.max(12, Math.min(viewport.width - width - 12, rect.left));
  const above = rect.top > height + 20;
  const y = Math.max(12, Math.min(viewport.height - height - 12, above ? rect.top - (height + 8) : rect.bottom + 10));
  return { x, y };
}
