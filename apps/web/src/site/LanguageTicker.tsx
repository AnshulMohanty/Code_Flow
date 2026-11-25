/**
 * THE LANGUAGE TICKER.
 *
 * The design runs a marquee of language names under the hero. What it lists here is the truth about
 * this engine, in two groups that are never mixed:
 *
 *   FULLY PARSED  tree-sitter grammars plus a resolver per language, and every one of them is scored
 *                 edge by edge against that language's OWN toolchain (tsc, go list, javac, Roslyn,
 *                 clang, Python's import machinery) — see DESIGN.md §4.
 *   STRUCTURAL    everything else: the file is counted (lines, role, place in the tree) but no
 *                 imports are read, so it has no edges. Named honestly rather than listed as
 *                 "supported".
 *
 * A ticker that listed twenty languages as though they were equally supported would be the single
 * easiest place in this UI to overclaim. A language appears in FULLY_PARSED only once it has a
 * resolver and a truth tool (DESIGN.md §3.4) — nothing aspirational goes in that list.
 *
 * `aria-hidden` on the moving track, because it is a duplicated marquee for the eye; the same facts
 * are in the `sr-only` sentence beside it.
 */

/** Parsed and resolved, each measured against its own compiler/toolchain. */
export const FULLY_PARSED_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "C#", "C", "C++"] as const;

/** Files are recognised and counted, but no imports are read — so no dependency edges. */
export const STRUCTURAL_LANGUAGES = ["Rust", "Ruby", "PHP", "Kotlin", "Swift", "Scala", "Elixir"] as const;

export function LanguageTicker() {
  const run = (copy: number) => (
    <div className="ticker-run" key={copy}>
      <span className="ticker-group">fully parsed</span>
      {FULLY_PARSED_LANGUAGES.map((name) => (
        <span key={`${copy}-${name}`} className="ticker-item" data-parsed="true">
          {name}
          <span className="ticker-mark">⌗</span>
        </span>
      ))}
      <span className="ticker-group" data-parsed="false">structural only</span>
      {STRUCTURAL_LANGUAGES.map((name) => (
        <span key={`${copy}-${name}`} className="ticker-item" data-parsed="false">
          {name}
          <span className="ticker-mark">·</span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="ticker">
      <p className="sr-only">
        Fully parsed, each checked against its own compiler: {FULLY_PARSED_LANGUAGES.join(", ")}. Structural only —
        files are counted but imports are not read: {STRUCTURAL_LANGUAGES.join(", ")}.
      </p>
      {/* Duplicated once so the -50% translate loops seamlessly. */}
      <div className="ticker-track" aria-hidden="true">
        {[0, 1].map(run)}
      </div>
    </div>
  );
}
