/**
 * THE LANGUAGE TICKER.
 *
 * The design runs a marquee of language names under the hero. What it lists is the truth about this
 * engine, which is more interesting than a list of logos anyway: the five languages tree-sitter
 * genuinely parses into a code property graph, and — separately marked — the ones that fall through
 * to the regex engine and therefore get imports but no call graph.
 *
 * THAT DISTINCTION IS LEDGER #16, and putting it in the marquee rather than in a footnote is the
 * point. A ticker that listed twenty languages as though they were equally supported would be the
 * single easiest place in this UI to overclaim, and the honest version is not even less impressive:
 * "five parsed to a CPG, nine more resolved structurally" is a real capability statement.
 *
 * `aria-hidden`, because it is a duplicated marquee for the eye; the same facts are in the
 * `sr-only` sentence beside it.
 */

/** Parsed by tree-sitter into a full CPG (symbols + calls + inheritance). */
const CPG_LANGUAGES = ["TypeScript", "JavaScript", "TSX", "JSX", "Python"] as const;

/** Recognised structurally by the regex/generic engine: nodes and (where the syntax allows) imports,
 *  but no symbols and no call graph. Named honestly rather than listed as "supported". */
const STRUCTURAL_LANGUAGES = ["Go", "Rust", "Java", "Ruby", "PHP", "C#", "C", "C++", "Kotlin", "Swift", "Scala", "Elixir"] as const;

export function LanguageTicker() {
  const items = [
    ...CPG_LANGUAGES.map((name) => ({ name, cpg: true })),
    ...STRUCTURAL_LANGUAGES.map((name) => ({ name, cpg: false })),
  ];

  return (
    <div className="ticker">
      <p className="sr-only">
        Parsed to a full code property graph: {CPG_LANGUAGES.join(", ")}. Recognised structurally only —
        files and imports, no symbols or call graph: {STRUCTURAL_LANGUAGES.join(", ")}.
      </p>
      {/* Duplicated once so the -50% translate loops seamlessly. */}
      <div className="ticker-track" aria-hidden="true">
        {[0, 1].map((copy) => (
          <div key={copy} style={{ display: "flex" }}>
            {items.map((item) => (
              <span key={`${copy}-${item.name}`} className="ticker-item">
                <span className="ticker-mark">{item.cpg ? "⌗" : "·"}</span>
                {item.name}
                {item.cpg ? null : <span className="ticker-mark">structural</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
