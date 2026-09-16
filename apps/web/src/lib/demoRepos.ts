/**
 * THE CURATED DEMO ALLOWLIST.
 *
 * WHAT PROBLEM IT SOLVES. A first-time visitor arrives at a static page and a backend that may be
 * asleep. Asking them to paste a repository URL and then wait 40 seconds for the container to wake
 * plus a minute for a real clone-and-parse is asking them to leave. These four are PRE-WARMED: the
 * analysis has already been run against them, so the SHA-keyed Mongo cache holds the result and a
 * click returns it in roughly the time of one round trip.
 *
 * WHY AN ALLOWLIST AND NOT "POPULAR REPOS". Every entry here has to be something this deployment has
 * ACTUALLY analysed, because the whole benefit is the cache hit. A list of impressive names that
 * were never indexed would produce exactly the cold, slow first click it exists to prevent — with
 * the added problem of looking curated while behaving worse than a random URL.
 *
 * WHY THESE FOUR. They cover the three parser families the engine treats differently plus the one
 * repository a reader can check the claims against:
 *   - a tiny JS repo, so the FIRST thing anyone sees finishes fast and the whole graph fits on screen;
 *   - a real Node/Express service, because that is the shape most visitors have at work;
 *   - a Python library, which exercises the other tree-sitter grammar and a different import model;
 *   - CodeFlow itself, which is the only honest way to answer "does it work on a real TypeScript
 *     monorepo" — and the reader can diff the answer against the source in the same tab.
 *
 * THE CACHE KEY IS (repo, commit SHA, analyzerVersion). So a pre-warm is not permanent: the repo
 * moves on, and a bumped ANALYZER_VERSION invalidates every entry at once. That is correct — a stale
 * cached analysis is a wrong analysis — and it is why the pre-warm is a documented, repeatable
 * script rather than a one-off (see scripts/prewarm-demos.mjs and GO_LIVE.md).
 */

export interface DemoRepo {
  owner: string;
  repo: string;
  /** What the button says. */
  label: string;
  /** One line under the label. A fact about the repository, not a sales line. */
  note: string;
  /** The parser family it exercises. Shown so the four do not look like an arbitrary list. */
  language: "JavaScript" | "TypeScript" | "Python";
}

export const DEMO_REPOS: readonly DemoRepo[] = [
  {
    owner: "jamiebuilds",
    repo: "the-super-tiny-compiler",
    label: "the-super-tiny-compiler",
    note: "One file, heavily commented. The whole graph fits on screen.",
    language: "JavaScript",
  },
  {
    owner: "expressjs",
    repo: "express",
    label: "expressjs/express",
    note: "A real Node service: middleware chain, router, no build step.",
    language: "JavaScript",
  },
  {
    owner: "psf",
    repo: "requests",
    label: "psf/requests",
    note: "Python. A different grammar and a different import model.",
    language: "Python",
  },
  {
    owner: "AnshulMohanty",
    repo: "Code_Flow",
    label: "CodeFlow itself",
    note: "A pnpm TypeScript monorepo — check the answers against the source.",
    language: "TypeScript",
  },
] as const;

/** `owner/repo`, the form the API and the cache key both use. */
export function demoFullName(demo: DemoRepo): string {
  return `${demo.owner}/${demo.repo}`;
}

/**
 * Is this what the user typed one of the pre-warmed four?
 *
 * Used to decide whether a request can be served while the backend is still waking. It is NOT a
 * permission check — any public repository is analysable — only a "will this be fast" hint.
 */
export function isDemoRepo(input: { owner: string; repo: string }): boolean {
  return DEMO_REPOS.some(
    (demo) => demo.owner.toLowerCase() === input.owner.toLowerCase() && demo.repo.toLowerCase() === input.repo.toLowerCase(),
  );
}
