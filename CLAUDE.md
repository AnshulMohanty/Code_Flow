# CodeFlow — working notes for Claude

Read `DESIGN.md` first. Its section 7 ("Roadmap and status") says which phase is in progress and what is
left; continue from there. `README.md` is the public page.

- Gate before every commit: `npx -y pnpm@9.15.4 -r typecheck`, `-r lint`, `test` (serial), `-r --workspace-concurrency=1 build`,
  then the accuracy checks in `DESIGN.md` §3.3. All must pass.
- Any change to deterministic output (parsing, resolution, graph, metrics) bumps `ANALYZER_VERSION` in
  `packages/config/src/constants.ts`.
- A new language follows `DESIGN.md` §3.4, including a truth tool built on that language's own toolchain.
- Never add Claude/AI attribution (co-author trailers, "Generated with") to commits or PRs.
- Never state a number that was not measured; say where each number came from.
- Explain things to the owner in simple, direct language.
