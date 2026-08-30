/**
 * The analyzer's version — the third component of the Mongo analysis cache key
 * ({repoFullName, commitSha, analyzerVersion}). It namespaces every cached analysis, so
 * BUMP IT whenever a change to the deterministic stages would make previously-cached
 * results wrong; that invalidates the cache without a manual purge.
 *
 * It lives here (not package.json) because it is a cache-correctness contract shared by
 * the API and worker, not a published artifact version: it must change when analyzer
 * OUTPUT changes, which is not the same cadence as a release. `ANALYZER_VERSION` in the
 * environment still overrides it for ad-hoc cache namespacing.
 */
export const ANALYZER_VERSION = "1.1.0";

export const DEFAULT_API_PORT = 4000;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_LOCAL_API_PORT = 3001;

// ── P4 scale + cost guardrails ───────────────────────────────────────────────
// Named limits for the five guardrails. ALL VALUES ARE PLACEHOLDERS FLAGGED FOR P7
// TUNING — real numbers come from the measured large-repo run (you can't pick them
// hermetically). They are constants (not env) so the guard behaviour is deterministic
// and testable; P7 may promote the ones worth operator control to env.

// Guard 1 — repo-size cap (Ingest, authoritative post-clone).
/** Max number of files in a cloned repo before it is rejected as too large. */
export const MAX_FILES = 25_000;
/** Max total bytes of a cloned repo before it is rejected as too large. */
export const MAX_BYTES = 512 * 1024 * 1024; // 512 MB

// Guard 2 — parsing concurrency (Inventory).
/** Max files parsed concurrently (bounds memory + CPU on a big repo). */
export const PARSE_CONCURRENCY = 8;

// Guard 2b — tree-sitter file-size ceiling (parsers).
/**
 * Files larger than this are parsed by the REGEX fallback instead of tree-sitter. A byte
 * ceiling, deliberately not a clock: a time-based bail-out would make the deterministic
 * spine non-deterministic (the same file could parse on one run and fall back on the next).
 */
export const TREE_SITTER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// Guard 3 — per-file parse timeout (Inventory).
/** A single file's read+parse is abandoned (recorded unparsed) after this many ms. */
export const FILE_TIMEOUT_MS = 5_000;

// Guard 4 — per-IP rate limit (API analyze endpoint).
/** Fixed-window length for per-IP rate limiting. */
export const RATE_WINDOW_MS = 60_000;
/** Max analyze-enqueue requests per IP per window before a 429. */
export const RATE_MAX = 30;

// Guard 5 — global daily LLM spend ceiling (the wallet guard).
/** Cumulative LLM/embedding tokens allowed across ALL callers per UTC day. */
export const DAILY_LLM_BUDGET = 5_000_000;

// ── Dependency-graph render caps (P5 viz; render-only, P7-tunable) ───────────
// These cap what the 2D graph PAINTS, never the underlying model (the full graph stays
// in memory; "expand / show all" raises the cap). Placeholders — tune against a big repo.
/** Default backbone: the top-N most-central files shown before "expand". */
export const GRAPH_BACKBONE_NODES = 80;
/** Focus mode reveals a node's k-hop neighbourhood. */
export const GRAPH_FOCUS_HOPS = 1;
/** Painting more than this many nodes triggers a perf warning (still allowed). */
export const GRAPH_PERF_WARN_NODES = 600;

// ── RAG query path (ask-the-repo; P7-tunable) ────────────────────────────────
/** Top-k chunks retrieved per question before answering. */
export const RAG_TOP_K = 6;
/** Min cosine similarity of the BEST retrieved chunk to attempt an answer; below this we
 *  return an honest "not found in this repo" and never call the answer LLM (no fabrication). */
export const RAG_MIN_SIMILARITY = 0.2;

// -- Hybrid retrieval (V3-P2; fusion + rerank + diversity; P5-tunable) -------
// Every constant here is a knob with a documented default and NO measured calibration yet:
// the numbers below come from the literature (BM25's original paper for k1/b, the TREC RRF
// paper for RRF_K) or from a stated trade-off, never from this repo's own eval. Calibrating
// them needs the real scored run, which is deferred.
/** How many candidates EACH retrieval arm returns before fusion. Wider than the final k on
 *  purpose: the whole value of hybrid is that one arm surfaces what the other missed, and a
 *  narrow arm cannot do that. 4x the final k, capped by RETRIEVAL_MAX_CANDIDATES. */
export const RETRIEVAL_ARM_OVERSAMPLE = 4;
/** Hard ceiling on the fused candidate set handed to the reranker. A cross-encoder is O(n)
 *  in real model calls, so this is a latency AND cost bound, not a nicety. */
export const RETRIEVAL_MAX_CANDIDATES = 40;
/** BM25 term-frequency saturation. 1.2 is the standard default: higher lets a term repeated
 *  many times in one chunk keep gaining, which over-rewards a long file that mentions a name
 *  repeatedly over the short function actually named after it. */
export const BM25_K1 = 1.2;
/** BM25 length normalisation, 0 = none, 1 = full. 0.75 standard. Length normalisation matters
 *  more in code than in prose: without it a 400-line file outranks the 8-line function. */
export const BM25_B = 0.75;
/** Shortest token the lexical index keeps. Single characters in code (i, x, _) are noise. */
export const LEXICAL_MIN_TOKEN_LENGTH = 2;
/** RRF's rank-smoothing constant. 60 is the value from the original paper; larger values
 *  flatten the rank curve, which means trusting AGREEMENT between arms over either arm's own
 *  confidence — the right bias here, because neither arm is reliable alone. */
export const RRF_K = 60;
/** MMR relevance-vs-diversity trade-off. 1.0 = pure relevance, 0.0 = pure diversity. 0.7
 *  leans relevant: aggressive diversification starts returning weakly-relevant chunks from
 *  unrelated files, which reads to a user as retrieval getting worse. */
export const MMR_LAMBDA = 0.7;

// -- Agentic Q&A + memory (V3-P3; P5-tunable) --------------------------------
// The two loop bounds are the wallet and latency guard for the agent. An unbounded
// tool-calling loop is the single most expensive failure mode in this codebase: each turn is a
// paid call, and a model that keeps deciding "one more search" spends indefinitely. Both are
// HARD caps enforced in code, never suggestions in a prompt.
/** Max LLM turns per question, including the final answering turn. */
export const AGENT_MAX_TURNS = 6;
/** Max tool invocations per question, across all turns. Lower than turns x tools on purpose:
 *  the interesting questions need 2-3 lookups, and 10 is already generous for a bad case. */
export const AGENT_MAX_TOOL_CALLS = 10;
/** Max characters of any single tool observation fed back into the prompt. A tool that returns
 *  800 files must not be able to blow the context window; it is truncated with the count stated,
 *  so the model knows it saw a prefix rather than silently believing it saw everything. */
export const AGENT_MAX_TOOL_RESULT_CHARS = 4_000;
/** Max consecutive unparseable model outputs before the agent gives up and refuses honestly. */
export const AGENT_MAX_PARSE_RETRIES = 2;
/** Max tool DESCRIPTIONS included in one prompt. Descriptions are the fixed per-call cost of
 *  having tools at all, so curating them is the main context-budget lever (V3-P3 task 3). */
export const AGENT_MAX_TOOLS_PER_STEP = 4;

// Memory bounds. Memory feeds the prompt, so unbounded memory is a context-budget bug that
// grows silently until requests cost several times what they used to.
/** Turns kept per session. Older turns are dropped oldest-first. */
export const SESSION_MAX_TURNS = 8;
/** Resolved entities kept per session (most recent first). */
export const SESSION_MAX_ENTITIES = 20;
/** Retrieved chunk ids remembered per session. */
export const SESSION_MAX_CHUNK_IDS = 200;
/** Characters of an answer kept in memory. Memory is a prompt input, not an archive. */
export const SESSION_MAX_ANSWER_CHARS = 600;
/** Snapshots kept per repository. "What changed recently", not a full history. */
export const REPO_MAX_SNAPSHOTS = 10;

// -- Bounded agent fan-out + test-time compute (V3-P4; P5-tunable) -----------
// PARALLELISM IS EARNED HERE, not assumed: the fan-out is over V3-P1's Louvain communities,
// which are low-coupling by construction, so per-community work is genuinely independent.
/** Max specialist workers in flight at once. Bounds provider concurrency (rate limits) and
 *  peak memory, NOT the number of communities — a 60-community repo still gets all 60 analysed,
 *  in waves. */
export const FANOUT_MAX_CONCURRENCY = 5;
/** Max communities analysed per run. A repo with more gets the most COMPLEX ones (see
 *  `complexityOf`), and the omission is REPORTED — a silent cap reads as "covered everything". */
export const FANOUT_MAX_COMMUNITIES = 12;
/** Files from a community shown to one specialist. Input safety AND a cost bound: a specialist
 *  reasoning over 400 files is a specialist reasoning over noise. */
export const SPECIALIST_MAX_FILES = 25;
/** Characters of a specialist's `detail` kept on the blackboard. Bounded because the SUPERVISOR
 *  reads it, and the supervisor's context must not grow with worker count. */
export const SPECIALIST_MAX_DETAIL_CHARS = 400;
/** Max findings one specialist may return per community. */
export const SPECIALIST_MAX_FINDINGS = 3;

// THE property that makes the orchestrator scale: the supervisor sees a BOUNDED selection of the
// blackboard, chosen deterministically by importance. With 5 workers or 500, its prompt has the
// same ceiling — which is the documented failure at 4+ workers, avoided by construction rather
// than by hoping summaries stay short.
/** Findings handed to the supervisor, at most. */
export const SUPERVISOR_MAX_FINDINGS = 12;
/** Reading-order steps the supervisor may produce. */
export const SUPERVISOR_MAX_READING_STEPS = 10;

// Test-time compute. N-times cost is paid ONLY on the routed-hard tail, never repo-wide.
/** Complexity score at or above which a community is "hard" and gets best-of-N. */
export const HARD_COMMUNITY_COMPLEXITY = 0.6;
/** Trajectories sampled for a hard community. */
export const BEST_OF_N = 3;
/** Max communities that may be routed hard in one run — the ceiling on the N-times bill. */
export const MAX_HARD_COMMUNITIES = 3;
