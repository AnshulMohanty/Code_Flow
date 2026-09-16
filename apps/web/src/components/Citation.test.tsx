import type { RepositoryRef } from "@codeflow/shared-types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationChip, peekPosition } from "./Citation";

/**
 * THE PEEK MUST NOT BECOME A SECOND SOURCE OF TRUTH.
 *
 * A citation is an address, and the peek exists to show that address in full before a reader commits
 * a click. These tests pin the two properties that keep it honest: it shows the range the analysis
 * recorded, and it contains no source text and no second link — so the chip remains the one thing on
 * screen that resolves to code.
 */

const REPOSITORY: RepositoryRef = { provider: "github", owner: "acme", name: "repo" };

describe("the citation peek", () => {
  it("shows the exact line range and the commit it was read at, on hover", () => {
    render(<CitationChip repository={REPOSITORY} commitSha="c0ffee1234567890" fileId="src/auth.ts" startLine={4} endLine={9} />);

    expect(document.querySelector(".peek")).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("link"));

    const peek = document.querySelector(".peek");
    expect(peek).toBeTruthy();
    expect(peek).toHaveTextContent("4–9");
    expect(peek).toHaveTextContent("6 lines");
    // The SHORT sha of the analysed commit — the peek's job is to say which bytes these lines are.
    expect(peek).toHaveTextContent("c0ffee1");

    fireEvent.mouseLeave(screen.getByRole("link"));
    expect(document.querySelector(".peek")).toBeNull();
  });

  it("never renders source lines or a second link — the chip stays the only address", () => {
    render(<CitationChip repository={REPOSITORY} commitSha="c0ffee1234567890" fileId="src/auth.ts" startLine={4} endLine={9} />);
    fireEvent.mouseEnter(screen.getByRole("link"));

    // Exactly one link in the whole subtree: the chip. A link inside the peek would give a reader two
    // things to follow for one citation, and `getByRole` throwing on a second one is the point.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(document.querySelector(".peek")).toHaveTextContent(/keeps the address, not the bytes/i);
  });

  it("peeks on a chip that CANNOT resolve, without offering a link", () => {
    // No commit ⇒ no addressable URL ⇒ the chip is plain text. The line range is still real, so the
    // peek still has something true to say.
    render(<CitationChip repository={REPOSITORY} fileId="src/auth.ts" startLine={4} endLine={9} />);
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.mouseEnter(document.querySelector(".cite-chip")!);
    expect(document.querySelector(".peek")).toHaveTextContent("not recorded");
  });
});

describe("peekPosition keeps the peek on screen", () => {
  it("opens ABOVE the chip when there is room", () => {
    const at = peekPosition({ left: 100, top: 400, bottom: 420 }, { width: 1200, height: 800 });
    expect(at.y).toBeLessThan(400);
  });

  it("flips BELOW when the chip is near the top", () => {
    const at = peekPosition({ left: 100, top: 30, bottom: 50 }, { width: 1200, height: 800 });
    expect(at.y).toBeGreaterThan(50);
  });

  it("clamps to the viewport rather than opening off the right edge", () => {
    const at = peekPosition({ left: 1180, top: 400, bottom: 420 }, { width: 1200, height: 800 });
    // 1200 - min(430, 1056) - 12
    expect(at.x).toBe(758);
    expect(at.x).toBeGreaterThanOrEqual(12);
  });
});
