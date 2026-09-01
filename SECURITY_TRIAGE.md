# SECURITY_TRIAGE — CodeQL, PR #1

**Result: 22 alerts, 22 fixed, 0 dismissed.**

The PR check reported "17 new alerts including 17 high severity". The real number on the merge ref
is **22** — GitHub attributes only some of them to the diff because the change was large enough
that it stopped trying ("_Alerts not introduced by this pull request might have been detected
because the code changes were too large_"). Ten of the 22 also stand open on `main`, so they are
not regressions introduced by this branch; they are pre-existing and were fixed here anyway,
because leaving a known-exploitable pattern in place to keep a diff tidy is not a triage decision.

Every alert is the same rule: **`js/polynomial-redos`**, high severity — a regular expression whose
worst-case cost is superlinear in the length of its input, applied to a value that flows from
outside the program.

```
GET /repos/AnshulMohanty/Code_Flow/code-scanning/alerts?pr=1&state=open   →  22
                                                          ?ref=refs/heads/main  →  11
```

---

## Why nothing was dismissed

This application clones an arbitrary public repository and runs regular expressions over its source
text, line by line. "Untrusted input reaches a regex" is not a theoretical taint path here — it is
the product. So the prior was that these would be real, and each one was checked rather than
assumed, in both directions:

**The measurement.** Each flagged pattern was run against the input its own alert message
described, at 4 000 and 16 000 characters. Polynomial growth of degree 2 predicts 16× the time for
4× the input:

| Pattern | n=4 000 | n=16 000 | growth |
|---|---|---|---|
| `/^import\s+(.+)$/` (Python) | 38.7 ms | 608.4 ms | 15.7× |
| `/^from\s+([.\w]+)\s+import\s+(.+)$/` | 38.3 ms | 607.5 ms | 15.9× |
| `/\s+as\s+/` (as a `split` delimiter) | 17.3 ms | 276.0 ms | 16.0× |
| `/\{([^}]+)\}/` | 14.9 ms | 236.6 ms | 15.9× |
| `/\*+\/$/` | 10.1 ms | 158.9 ms | 15.7× |
| `/-+$/` (the second half of `/^-+\|-+$/g`) | 20.0 ms | 220.5 ms | 11.0× |
| `/\s*```$/` | 12.7 ms | 199.4 ms | 15.7× |

Three are worse than quadratic — they pair *three* quantifiers that can claim the same character,
which is cubic. These did not finish at n=4 000 within a 20-second cap, so they are reported at 250
and 1 000:

| Pattern | n=250 | n=1 000 | n=4 000 |
|---|---|---|---|
| ` ```(?:json)?\s*([\s\S]*?)\s*``` ` | 31 ms | 322 ms | **> 20 s** |
| `/^\s*import\s+(?:type\s+)?(?:(.*?)\s+from\s+)?["']([^"']+)["']/` | 33 ms | 317 ms | **> 20 s** |
| `/…\(?[^=]*\)?\s*=>/` (arrow assignment) | 33 ms | 273 ms | **> 20 s** |

**The reachability.** Two of the alerts needed real work to confirm rather than assume, and both
confirmed:

- The Python patterns look unexploitable, because every caller passes `line.trim()` and a trimmed
  string cannot end in whitespace. The exploit is **U+2028 LINE SEPARATOR**: it is whitespace to
  `\s` but is *not* matched by `.`, and `splitLines` splits on `\r\n|\r|\n` only — so U+2028 stays
  *inside* a line. `"import" + " "×n + "X"×n + " y"` forces the failing path, survives
  `.trim()` intact (it ends in `y`), and is the 608 ms row above.
- `slug()` in `namespace.ts` takes `repoFullName`, which is user-supplied. `/^-+|-+$/g` looks safe
  because the `^-+` alternative short-circuits — but only when the string *starts* with a dash.
  A repository name of punctuation collapses to a run of dashes with content either side, and the
  `-+$` half is then quadratic.

**The tool was precise, which is itself evidence.** CodeQL did *not* flag
`/\*\s+as\s+([A-Za-z_$][\w$]*)/` two lines above one that it did, nor
`/^\s*export\s*\{([^}]+)\}/`. Both are genuinely linear: the first is pinned by a literal `*` and
the second by `^`, so each has one viable start position. A query that flags every `\s+` would have
flagged those too. Nothing here is a false positive, so no dismissal would have been honest.

---

## The fixes

Two techniques, in order of preference: **pin the boundary** between adjacent quantifiers so only
one split is viable, or **drop the regex** for an index scan when pinning would change what the
pattern accepts.

| # | Location | Pattern | Fix |
|---|---|---|---|
| 3, 17 | `pythonParser.ts:26`, `cpg.ts:428` | `/^import\s+(.+)$/` | `PY_IMPORT_LINE` — `(\S.*)` pins the tail |
| 5, 19 | `pythonParser.ts:42`, `cpg.ts:435` | `/^from\s+([.\w]+)\s+import\s+(.+)$/` | `PY_FROM_IMPORT_LINE` — same |
| 4, 6, 8, 11, 18, 20 | `pythonParser.ts:29,47`, `javascriptParser.ts:103,175`, `cpg.ts:431,439` | `split(/\s+as\s+/)` | `splitAliasSegments()` — tokenise, then find the keyword |
| 7, 21 | `javascriptParser.ts:49`, `cpg.ts:447` | the cubic import clause | `parseStaticImportLine()` — `import\s([^"']*)["']` plus index arithmetic |
| 9 | `javascriptParser.ts:130` | `\(?[^=]*\)?\s*=>` | `ARROW_ASSIGNMENT_LINE` — `=[^=]*=>` |
| 10 | `javascriptParser.ts:170` | `/\{([^}]+)\}/` | `namedBraceBody()` — two `indexOf` calls |
| 2, 12, 13, 14, 15 | `synthesize.ts:283`, `specialists.ts:293`, `parseAction.ts:21`, `supervisor.ts:247`, `answer.ts:246` | the cubic fence regex, **five identical copies** | `stripCodeFence()` — one shared linear unwrapper |
| 16 | `judge.ts:212` | `/\s*```$/` | `stripTrailingCodeFence()` — `endsWith` + `trimEnd` |
| 22 | `enrichment.ts:298` | `/\*+\/$/` | `stripTrailingBlockComment()` — walk back from the end |
| 23 | `namespace.ts:34` | `/^-+\|-+$/g` | `trimDashes()` — two pointers |

New modules: `packages/parsers/src/utils/importScan.ts`,
`packages/analyzers/src/llm/completionText.ts`.

**After: every one of them handles 200 000 characters in 0.1–1.9 ms** — the same inputs that cost
the old patterns 95 seconds (Python, extrapolated from the measured quadratic) to hours (the cubic
three).

The import-clause pin uses a **single `\s`**, not `\s+` with a `(?=\S)` lookahead. Whitespace is a
subset of `[^"']`, so `\s+[^"']*` and `\s[^"']*` accept exactly the same strings — but the second
has no adjacent quantifiers at all, so it is linear **by construction** rather than by a lookahead a
static analyser has to model as a pin. The lookahead form was written first, verified equivalent over
the corpus, and then replaced: it measured twice as slow, and depending on a tool's treatment of
lookaheads to prove the fix is a worse position than not needing one. **No regex in either new
module contains a lookahead.**

`=[^=]*=>` deserves a note, because it looks like a weakening and is not. Everything the old
pattern spelled out after the `=` — `\s*`, `async`, `\(`, `\)`, `\s*` — is a subset of `[^=]`, so
the concatenation *is* `[^=]*`: the same language, written without the ambiguity. And `[^=]*`
cannot cross the `=` of the arrow, so it has one place to stop rather than one per space.

---

## Verified equivalent, not assumed equivalent

Each replacement was differentially tested against the pattern it replaced over a corpus of real
import forms, fence shapes, comment markers and slug inputs, before any source file was touched.
That is what caught the two first attempts that were wrong:

- `\(?[^=]*=>` for the arrow pattern still took **40 seconds** at n=200 000 — the `\s*` before it
  was the ambiguity, not the `\)?` after. Replaced with `=[^=]*=>`.
- `/\{([^{}]+)\}/` for the brace body is linear but **changes the captured text** on nested braces.
  Replaced with `indexOf`, which reproduces the original exactly.

The differential run found **two** intentional behaviour changes, both only on input that is not
valid source in any dialect the parsers claim to handle. Both are asserted in tests, so they are
decisions on the record rather than drift:

1. **`import "a" from "b"`** reported `b` as the module, because the lazy `(.*?)` was free to
   swallow a quoted string. It now reports `a`, reading the line as the side-effect import its
   prefix spells. There is no JavaScript or TypeScript syntax in which this line means anything.
2. **`splitAliasSegments("x as")`** returns `["x as"]` — one segment, exactly as `\s+as\s+`
   behaved, since the delimiter required whitespace on *both* sides. Separately, the two
   JavaScript call sites used `/\s+as\s+/i` and so also matched `AS`, which is not the keyword in
   either language; the shared helper is case-sensitive. Both were latent bugs on garbage input,
   not features.

---

## One prescribed measure deliberately not taken

The brief said to "rewrite catastrophic patterns to linear (anchors/atomic), **bound input
length**". The rewrites are done and measured. The length bound is **not** applied, and that is a
judgement call rather than an omission:

- With every pattern now linear at 200 000 characters in under 2 ms, a bound adds no security.
- It would change behaviour on real input. A line-length cap in a fallback parser silently stops
  reporting imports on minified or generated files — the parser would return *fewer* dependency
  edges with no signal that it had given up, which is precisely the kind of quiet wrongness the
  grounding rules in this codebase exist to prevent.

If a future pattern here cannot be made linear, a bound is the right tool — and it should announce
what it skipped, the way `CODEFLOW_MAX_FILES` does.

---

## Regression tests

The tests assert a **2 000 ms budget on a 200 000-character pathological input**. The measurements
above are what make that a real gate rather than a formality: the linear implementations use
0.1–1.9 ms, so the margin is three orders of magnitude and cannot flake on a slow runner, while no
quadratic implementation can meet it — the removed patterns need ~95 seconds on the same input.

The old patterns are deliberately **not** kept in the test files. A test that asserts code is
*slow* fails for good reasons on fast hardware, and re-introducing the vulnerable pattern to prove
a point puts it back in the tree. The numbers in this document are the record instead, and they are
reproducible by reverting a single fix.

Parser-level tests were added alongside the helper-level ones — `pythonParser.parseFile`,
`javascriptParser.parseFile`, `extractCpgFacts`, `deriveEnrichment` and `retrievalNamespace` are
each driven with a hostile input. A helper test proves the helper is linear; only the caller test
proves the fix is on the path the product uses.

| Suite | Added |
|---|---|
| `packages/parsers/src/__tests__/importScan.test.ts` | 19 |
| `packages/analyzers/src/__tests__/completionText.test.ts` | 8 |
| `packages/retrieval/src/__tests__/enrichment.test.ts` | 2 |
| `packages/retrieval/src/__tests__/memoryStores.test.ts` | 1 |
| `packages/retrieval/src/__tests__/sqlStores.test.ts` | 1 (pgvector DDL idempotency — Part B) |
| `apps/api/src/config/port.test.ts` | 9 (platform `PORT` — Part B) |

All hermetic: no network, no service, no key.
