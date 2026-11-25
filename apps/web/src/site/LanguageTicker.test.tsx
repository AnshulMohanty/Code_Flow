import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FULLY_PARSED_LANGUAGES, LanguageTicker, STRUCTURAL_LANGUAGES } from "./LanguageTicker";

/**
 * The marquee is the easiest place on the page to overclaim, so its two lists are pinned. A
 * language moves into FULLY_PARSED only with a resolver and a truth tool from its own toolchain
 * (DESIGN.md §3.4) — and this test changes in the same commit, on purpose.
 */

describe("LanguageTicker", () => {
  it("lists exactly the eight languages that are parsed and measured against their own compilers", () => {
    expect([...FULLY_PARSED_LANGUAGES]).toEqual(["TypeScript", "JavaScript", "Python", "Go", "Java", "C#", "C", "C++"]);
  });

  it("never lists an unsupported language as parsed", () => {
    for (const name of ["Zig", "Rust", "Ruby", "PHP", "Kotlin", "Swift", "Scala", "Elixir"]) {
      expect(FULLY_PARSED_LANGUAGES as readonly string[]).not.toContain(name);
    }
    expect(STRUCTURAL_LANGUAGES as readonly string[]).not.toContain("Zig");
  });

  it("keeps the two groups disjoint and says what 'structural' means to a screen reader", () => {
    const parsed = new Set<string>(FULLY_PARSED_LANGUAGES);
    for (const name of STRUCTURAL_LANGUAGES) expect(parsed.has(name)).toBe(false);
    const { container } = render(<LanguageTicker />);
    const sentence = container.querySelector(".sr-only")!;
    expect(sentence).toHaveTextContent(/Fully parsed, each checked against its own compiler: TypeScript, JavaScript, Python, Go, Java, C#, C, C\+\+/);
    expect(sentence).toHaveTextContent(/imports are not read/);
  });

  it("marks every visible item with its group, so the eye can tell them apart too", () => {
    const { container } = render(<LanguageTicker />);
    const parsed = [...container.querySelectorAll('.ticker-item[data-parsed="true"]')].map((el) => el.firstChild?.textContent);
    // Two copies for the seamless loop.
    expect(parsed).toEqual([...FULLY_PARSED_LANGUAGES, ...FULLY_PARSED_LANGUAGES]);
    expect(container.querySelector(".ticker-track")).toHaveAttribute("aria-hidden", "true");
  });
});
