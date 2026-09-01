import { tokenizeCode } from "@codeflow/retrieval";
import type { AnalysisResult } from "@codeflow/shared-types";
import type { Blackboard, SpecialistFinding, SpecialistId } from "./contracts.js";

/**
 * OFFLINE MEMORY CONSOLIDATION (V3-P5 task 6) — per-community findings into a compact, queryable
 * repository knowledge base.
 *
 * THE PROBLEM. A V3-P4 fan-out over a 12-community repository produces up to 60 specialist findings
 * (5 lenses x 12 communities). They are structured and bounded individually, but as a set they are
 * repetitive: five lenses looking at the same community say overlapping things, and the supervisor
 * only ever reads a bounded selection of 12. The rest is paid for and then discarded. That is the
 * waste this closes — the findings already exist, and consolidating them costs nothing further.
 *
 * "CONSOLIDATE" HERE MEANS EXTRACTIVE, NOT GENERATIVE, and that is the central decision rather than
 * a limitation to apologise for. The obvious approach is another LLM pass that reads all 60 findings
 * and writes a summary. Three reasons that is the wrong tool:
 *
 *   1. It would spend money to compress information the fan-out already paid to produce, and the
 *      compression is the part a machine does exactly.
 *   2. It would make the KB NON-DETERMINISTIC, so the same analysis would produce a different KB on
 *      every run — and a knowledge base you cannot reproduce is not one you can diff, cache, or
 *      trust to answer the same question twice.
 *   3. It would introduce a new place for an ungrounded claim to enter, immediately after the
 *      fan-out went to some trouble to ground every fileId to its own community.
 *
 * So this is sorting, merging, de-duplicating and templating. No clock, no RNG, no provider. The
 * same blackboard always produces the byte-identical KB.
 *
 * CORROBORATION IS THE MOST VALUABLE THING IT PRODUCES. When the architecture lens and the
 * dependency-risk lens independently say the same thing about a community, that agreement is a
 * stronger signal than either finding alone — and it is invisible while the findings sit in a flat
 * list. Merging by normalised headline surfaces it explicitly as `corroboratedBy`, which is
 * information that did not exist before consolidation rather than a restatement of what did.
 *
 * GROUNDING IS RE-CHECKED, not trusted. Findings were grounded to their community's files when they
 * were produced, but a KB is a durable artefact that outlives the run, so every fileId is re-checked
 * against `graph.nodes` and drops are COUNTED. A KB that cites a file the graph does not contain
 * would be the same failure the three grounding passes exist to prevent, just one layer later.
 */

/** Deterministic facts read straight off the graph and metrics. No agent involved. */
export interface RepoFact {
  id: string;
  kind: "entry-point" | "cycle" | "hub" | "community" | "scale";
  /** One sentence, plain prose. */
  statement: string;
  /** Grounded fileIds, sorted. May be empty for a whole-repo fact. */
  fileIds: string[];
}

/** One community, consolidated across every specialist that looked at it. */
export interface CommunityDigest {
  cluster: number;
  fileCount: number;
  /** The community's most-connected files, bounded. */
  keyFiles: string[];
  /** Which lenses reported on it. Sorted. */
  specialists: SpecialistId[];
  /** Merged findings, most important first. */
  points: ConsolidatedPoint[];
  /** Lenses that produced nothing for this community, with the reason. Never silent. */
  gaps: Array<{ specialist: SpecialistId; reason: string }>;
}

/** A finding after merging duplicates across lenses. */
export interface ConsolidatedPoint {
  headline: string;
  detail: string;
  importance: "low" | "medium" | "high";
  /** Every lens that made this point. Length > 1 is CORROBORATION. */
  corroboratedBy: SpecialistId[];
  fileIds: string[];
}

/** A question/answer pair, generated from facts and digests by template. */
export interface KbQuestion {
  id: string;
  question: string;
  answer: string;
  fileIds: string[];
  source: "graph" | "agents";
}

export interface RepoKnowledgeBase {
  repoFullName: string;
  commitSha: string;
  /** Supplied, never read from a clock — the same rule `snapshotOf` follows, for the same reason. */
  capturedAt: string;
  facts: RepoFact[];
  communities: CommunityDigest[];
  faq: KbQuestion[];
  /** What consolidation discarded, and why. The honest half of "compact". */
  reduction: {
    findingsIn: number;
    pointsOut: number;
    mergedDuplicates: number;
    droppedUngroundedFileIds: number;
    /** Communities omitted by the cap, with their numbers — reported, never silent. */
    omittedClusters: number[];
    jsonBytes: number;
  };
}

// --- bounds ------------------------------------------------------------------
// Every one of these is what makes the artefact COMPACT, and each is a ceiling on a different axis.
// Bounding only the total size would let one enormous community crowd out eleven others.

/** Merged points kept per community. */
export const KB_MAX_POINTS_PER_COMMUNITY = 5;
/** Communities in one KB. Matches FANOUT_MAX_COMMUNITIES so a full fan-out is never truncated. */
export const KB_MAX_COMMUNITIES = 12;
/** Key files listed per community. */
export const KB_MAX_KEY_FILES = 5;
/** Characters of merged detail. Bounded because this text is what a query returns. */
export const KB_MAX_DETAIL_CHARS = 400;
/** Generated FAQ entries. */
export const KB_MAX_FAQ = 20;

export interface ConsolidateInput {
  result: AnalysisResult;
  blackboard: Blackboard;
  /** ISO timestamp, supplied by the caller. */
  capturedAt: string;
}

/**
 * Build the knowledge base. Pure and deterministic: same input, byte-identical output.
 */
export function consolidateKnowledge(input: ConsolidateInput): RepoKnowledgeBase {
  const { result, blackboard, capturedAt } = input;
  const groundedFiles = new Set((result.graph?.nodes ?? []).map((node) => node.id));

  let dropped = 0;
  /** Keep only fileIds the graph actually contains. Sorted and deduped. */
  const ground = (fileIds: readonly string[]): string[] => {
    const kept = new Set<string>();
    for (const fileId of fileIds) {
      if (groundedFiles.has(fileId)) kept.add(fileId);
      else dropped += 1;
    }
    return [...kept].sort();
  };

  // Facts are grounded against the same set but WITHOUT the counter, for the same reason
  // `keyFilesFor` is: they are derived from the graph and metrics, not claimed by an agent. A
  // mismatch there is an internal inconsistency, and folding it into
  // `droppedUngroundedFileIds` would make that number mean two different things — it exists
  // specifically to measure how often agents cite files they should not.
  const facts = deriveFacts(result, (fileIds) => [...new Set(fileIds.filter((id) => groundedFiles.has(id)))].sort());

  // Group findings by community, then merge within each. Grouping first is what makes the merge
  // meaningful: two lenses saying "this module owns persistence" about DIFFERENT communities are not
  // duplicates, and a global merge would collapse them.
  const byCluster = new Map<number, SpecialistFinding[]>();
  for (const finding of blackboard.findings) {
    const bucket = byCluster.get(finding.cluster) ?? [];
    bucket.push(finding);
    byCluster.set(finding.cluster, bucket);
  }

  const clusters = result.metrics?.clusters?.clusters ?? [];
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));

  // Ordered by how much was FOUND, then by cluster number for a total order. A community with four
  // corroborated findings is more worth a reader's attention than one with a single low-importance
  // note, and ordering by cluster id alone would bury it.
  const orderedClusters = [...byCluster.keys()].sort((a, b) => {
    const weight = (cluster: number) => (byCluster.get(cluster) ?? []).reduce((sum, f) => sum + importanceRank(f.importance), 0);
    return weight(b) - weight(a) || a - b;
  });

  const kept = orderedClusters.slice(0, KB_MAX_COMMUNITIES);
  const omittedClusters = orderedClusters.slice(KB_MAX_COMMUNITIES).sort((a, b) => a - b);

  let mergedDuplicates = 0;
  const communities: CommunityDigest[] = kept.map((cluster) => {
    const findings = byCluster.get(cluster) ?? [];
    const { points, merged } = mergePoints(findings, ground);
    mergedDuplicates += merged;

    const entryGaps = blackboard.entries
      .filter((entry) => entry.cluster === cluster && entry.status !== "ok")
      .map((entry) => ({ specialist: entry.specialist, reason: entry.reason ?? entry.status }))
      .sort((a, b) => a.specialist.localeCompare(b.specialist));

    const clusterInfo = clusterById.get(cluster);
    return {
      cluster,
      fileCount: clusterInfo?.size ?? new Set(findings.flatMap((finding) => finding.fileIds)).size,
      keyFiles: keyFilesFor(result, clusterInfo?.files ?? [], groundedFiles),
      specialists: [...new Set(findings.map((finding) => finding.specialist))].sort(),
      points: points.slice(0, KB_MAX_POINTS_PER_COMMUNITY),
      gaps: entryGaps,
    };
  });

  const faq = buildFaq(facts, communities).slice(0, KB_MAX_FAQ);

  const kb: RepoKnowledgeBase = {
    repoFullName: repoNameOf(result),
    commitSha: result.commitSha ?? "",
    capturedAt,
    facts,
    communities,
    faq,
    reduction: {
      findingsIn: blackboard.findings.length,
      pointsOut: communities.reduce((sum, community) => sum + community.points.length, 0),
      mergedDuplicates,
      droppedUngroundedFileIds: dropped,
      omittedClusters,
      jsonBytes: 0,
    },
  };

  // Measured after assembly, because "compact" is a claim that should carry a number. Computed on
  // the KB with the field zeroed so the measurement cannot depend on its own digits.
  kb.reduction.jsonBytes = Buffer.byteLength(JSON.stringify(kb), "utf8");
  return kb;
}

/**
 * Merge findings that make the same point.
 *
 * THE MERGE KEY IS THE NORMALISED HEADLINE — lowercased, tokenised, sorted, rejoined. So "Owns user
 * persistence" and "owns USER persistence." collapse, while "owns user persistence" and "owns user
 * validation" do not. Token-set rather than string equality, because two lenses phrasing the same
 * observation identically down to the punctuation is not the case worth catching.
 *
 * The merged point takes the HIGHEST importance of its inputs, and the LONGEST detail: if one lens
 * judged something high-importance, the merged point is high-importance, and the fuller explanation
 * is the more useful one to keep.
 */
function mergePoints(
  findings: readonly SpecialistFinding[],
  ground: (fileIds: readonly string[]) => string[],
): { points: ConsolidatedPoint[]; merged: number } {
  const groups = new Map<string, SpecialistFinding[]>();
  for (const finding of findings) {
    const key = normalizeHeadline(finding.headline);
    const bucket = groups.get(key) ?? [];
    bucket.push(finding);
    groups.set(key, bucket);
  }

  let merged = 0;
  const points: ConsolidatedPoint[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length > 1) merged += bucket.length - 1;
    // Sorted inside the group so the representative choice is deterministic rather than dependent
    // on blackboard append order.
    const sorted = [...bucket].sort(
      (a, b) => importanceRank(b.importance) - importanceRank(a.importance) || a.specialist.localeCompare(b.specialist),
    );
    const detail = [...bucket].sort((a, b) => b.detail.length - a.detail.length || a.specialist.localeCompare(b.specialist))[0].detail;
    points.push({
      headline: sorted[0].headline,
      detail: detail.length > KB_MAX_DETAIL_CHARS ? `${detail.slice(0, KB_MAX_DETAIL_CHARS - 1)}…` : detail,
      importance: sorted[0].importance,
      corroboratedBy: [...new Set(bucket.map((finding) => finding.specialist))].sort(),
      fileIds: ground(bucket.flatMap((finding) => finding.fileIds)),
    });
  }

  // CORROBORATION OUTRANKS IMPORTANCE at equal importance: two lenses agreeing on a medium-severity
  // observation is better evidence than one lens asserting another medium-severity one.
  points.sort(
    (a, b) =>
      importanceRank(b.importance) - importanceRank(a.importance) ||
      b.corroboratedBy.length - a.corroboratedBy.length ||
      a.headline.localeCompare(b.headline),
  );
  return { points, merged };
}

/** Deterministic facts. These need no agent and cannot be wrong about the code. */
function deriveFacts(result: AnalysisResult, ground: (fileIds: readonly string[]) => string[]): RepoFact[] {
  const facts: RepoFact[] = [];
  const nodes = result.graph?.nodes ?? [];

  if (nodes.length) {
    facts.push({
      id: "scale",
      kind: "scale",
      statement:
        `The repository has ${nodes.length} analysed file(s) and ${(result.graph?.edges ?? []).length} ` +
        "dependency edge(s).",
      fileIds: [],
    });
  }

  const entryPoints = (result.entryPoints ?? []).map((entry) => entry.fileId);
  if (entryPoints.length) {
    facts.push({
      id: "entry-points",
      kind: "entry-point",
      statement: `Execution starts at ${entryPoints.slice(0, KB_MAX_KEY_FILES).join(", ")}.`,
      fileIds: ground(entryPoints),
    });
  }

  const cycles = result.metrics?.cycles ?? [];
  if (cycles.length) {
    facts.push({
      id: "cycles",
      kind: "cycle",
      // The COUNT plus one example rather than every cycle: a repo with 40 cycles produces 40 facts
      // nobody reads, and the actionable information is "there are cycles, here is one".
      statement:
        `There ${cycles.length === 1 ? "is 1 dependency cycle" : `are ${cycles.length} dependency cycles`}, ` +
        `for example ${[...cycles[0].files].sort().join(" → ")}.`,
      fileIds: ground(cycles[0].files),
    });
  }

  const hubs = [...(result.metrics?.perFile ?? [])]
    .sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0) || a.fileId.localeCompare(b.fileId))
    .filter((entry) => (entry.fanIn ?? 0) > 0)
    .slice(0, 3);
  if (hubs.length) {
    facts.push({
      id: "hubs",
      kind: "hub",
      statement: `The most depended-on files are ${hubs.map((hub) => `${hub.fileId} (${hub.fanIn} importers)`).join(", ")}.`,
      fileIds: ground(hubs.map((hub) => hub.fileId)),
    });
  }

  const clusters = result.metrics?.clusters;
  if (clusters) {
    facts.push({
      id: "communities",
      kind: "community",
      statement:
        `The code partitions into ${clusters.count} community/communities (modularity ` +
        `${clusters.modularity.toFixed(3)}; higher means more cleanly separated).`,
      fileIds: [],
    });
  }

  return facts;
}

/**
 * Generate the FAQ by TEMPLATE, from facts and digests.
 *
 * These are the questions a newcomer to a repository actually asks, and every answer is either a
 * deterministic graph fact or an already-grounded agent finding — so the FAQ adds retrieval value
 * without adding a new source of claims. `source` records which, so a reader can tell a measured
 * fact from a model's judgement.
 */
function buildFaq(facts: readonly RepoFact[], communities: readonly CommunityDigest[]): KbQuestion[] {
  const faq: KbQuestion[] = [];

  const fact = (id: string) => facts.find((entry) => entry.id === id);

  const scale = fact("scale");
  if (scale) faq.push({ id: "faq-size", question: "How big is this repository?", answer: scale.statement, fileIds: [], source: "graph" });

  const entry = fact("entry-points");
  if (entry) {
    faq.push({
      id: "faq-entry",
      question: "Where does execution start?",
      answer: entry.statement,
      fileIds: entry.fileIds,
      source: "graph",
    });
  }

  const cycles = fact("cycles");
  if (cycles) {
    faq.push({
      id: "faq-cycles",
      question: "Are there dependency cycles?",
      answer: cycles.statement,
      fileIds: cycles.fileIds,
      source: "graph",
    });
  } else {
    // The ABSENCE is worth stating: "no cycles" is a real answer and a good one, and leaving the
    // question out would make a clean repository indistinguishable from an unanalysed one.
    faq.push({
      id: "faq-cycles",
      question: "Are there dependency cycles?",
      answer: "No dependency cycles were detected.",
      fileIds: [],
      source: "graph",
    });
  }

  const hubs = fact("hubs");
  if (hubs) {
    faq.push({
      id: "faq-hubs",
      question: "Which files matter most / are most depended on?",
      answer: hubs.statement,
      fileIds: hubs.fileIds,
      source: "graph",
    });
  }

  for (const community of communities) {
    const top = community.points[0];
    if (!top) continue;
    faq.push({
      id: `faq-community-${community.cluster}`,
      question: `What does community ${community.cluster} do?`,
      answer:
        `${top.headline} ${top.detail}` +
        (top.corroboratedBy.length > 1 ? ` (agreed by ${top.corroboratedBy.join(", ")})` : ""),
      fileIds: top.fileIds.length ? top.fileIds : community.keyFiles,
      source: "agents",
    });
  }

  const risks = communities
    .flatMap((community) => community.points.filter((point) => point.importance === "high").map((point) => ({ community, point })))
    .slice(0, 5);
  if (risks.length) {
    faq.push({
      id: "faq-risks",
      question: "What are the biggest risks or problems?",
      answer: risks.map((risk) => `[community ${risk.community.cluster}] ${risk.point.headline}`).join(" | "),
      fileIds: [...new Set(risks.flatMap((risk) => risk.point.fileIds))].sort(),
      source: "agents",
    });
  }

  return faq;
}

/**
 * A community's most-connected files, so `keyFiles` is a ranking rather than an alphabetical slice.
 *
 * Takes the grounded-file SET rather than the `ground()` helper, deliberately: these fileIds come
 * from the deterministic cluster partition, not from an agent, so a mismatch here would be an
 * internal inconsistency rather than a model claiming a file that does not exist. Counting them in
 * `droppedUngroundedFileIds` would make that number mean two different things at once, and the
 * number exists specifically to measure how often agents cite files they should not.
 */
function keyFilesFor(result: AnalysisResult, clusterFiles: readonly string[], groundedFiles: ReadonlySet<string>): string[] {
  const perFile = new Map((result.metrics?.perFile ?? []).map((entry) => [entry.fileId, entry]));
  const score = (fileId: string) => {
    const entry = perFile.get(fileId);
    return (entry?.fanIn ?? 0) + (entry?.fanOut ?? 0);
  };
  return [...clusterFiles]
    .filter((fileId) => groundedFiles.has(fileId))
    // Ranked by total degree, ties by path for a total order.
    .sort((a, b) => score(b) - score(a) || a.localeCompare(b))
    .slice(0, KB_MAX_KEY_FILES);
}

// --- query -------------------------------------------------------------------

export interface KbHit {
  /** Where the answer came from, so a caller can cite it. */
  kind: "fact" | "faq" | "community";
  question?: string;
  text: string;
  fileIds: string[];
  /** Token-overlap score, 0..1. */
  score: number;
}

/**
 * Query the KB. Deterministic lexical overlap — the same tokenizer the retrieval package uses.
 *
 * WHY NOT EMBEDDINGS. A KB is small (tens of entries, a few kilobytes), so an exact scan over
 * token overlap is both cheaper and more predictable than an index, and it needs no model — which
 * means the KB stays queryable in the local-first CLI and in a keyless deployment. The KB is
 * explicitly the CHEAP tier: it answers "what is this repo, roughly" without touching a provider,
 * and V3-P2 hybrid retrieval remains the path for questions about specific code.
 *
 * A ZERO-OVERLAP QUERY RETURNS NOTHING rather than the least-bad entry. The same rule as the
 * similarity floor: "nothing here is relevant" is a real answer, and a KB that always replies is
 * indistinguishable from one that is guessing.
 */
export function queryKnowledgeBase(kb: RepoKnowledgeBase, question: string, k = 3): KbHit[] {
  const queryTokens = new Set(tokenizeCode(question));
  if (queryTokens.size === 0) return [];

  const candidates: KbHit[] = [];

  for (const fact of kb.facts) {
    candidates.push({ kind: "fact", text: fact.statement, fileIds: fact.fileIds, score: overlap(queryTokens, fact.statement) });
  }
  for (const entry of kb.faq) {
    candidates.push({
      kind: "faq",
      question: entry.question,
      text: entry.answer,
      fileIds: entry.fileIds,
      // The QUESTION is scored alongside the answer, weighted toward the question: an FAQ exists to
      // be matched by its question, and scoring the answer alone would miss "are there cycles?"
      // against an answer that never uses the word.
      score: Math.max(overlap(queryTokens, entry.question) * 1.2, overlap(queryTokens, entry.answer)),
    });
  }
  for (const community of kb.communities) {
    for (const point of community.points) {
      candidates.push({
        kind: "community",
        text: `${point.headline} ${point.detail}`,
        fileIds: point.fileIds,
        score: overlap(queryTokens, `${point.headline} ${point.detail}`),
      });
    }
  }

  return candidates
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .slice(0, k);
}

/** Fraction of the QUERY's tokens present in the text. Query-normalised, so a long entry does not
 *  score highly merely by containing many words. */
function overlap(queryTokens: ReadonlySet<string>, text: string): number {
  const textTokens = new Set(tokenizeCode(text));
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

/** Human-readable rendering. What goes in a log, a PR comment, or a terminal. */
export function renderKnowledgeBase(kb: RepoKnowledgeBase): string {
  const lines = [`# ${kb.repoFullName} @ ${kb.commitSha || "(unpinned)"} — repo knowledge base`, ""];
  lines.push("## Facts");
  for (const fact of kb.facts) lines.push(`- ${fact.statement}`);
  lines.push("", "## Communities");
  for (const community of kb.communities) {
    lines.push(`### Community ${community.cluster} (${community.fileCount} file(s))`);
    if (community.keyFiles.length) lines.push(`key files: ${community.keyFiles.join(", ")}`);
    for (const point of community.points) {
      const agreement = point.corroboratedBy.length > 1 ? ` [agreed by ${point.corroboratedBy.join(", ")}]` : "";
      lines.push(`- (${point.importance}) ${point.headline}${agreement}`);
    }
    for (const gap of community.gaps) lines.push(`- gap: ${gap.specialist} produced nothing (${gap.reason})`);
  }
  lines.push("", "## FAQ");
  for (const entry of kb.faq) lines.push(`- Q: ${entry.question}\n  A: ${entry.answer} [${entry.source}]`);
  lines.push(
    "",
    `consolidated ${kb.reduction.findingsIn} finding(s) → ${kb.reduction.pointsOut} point(s) ` +
      `(${kb.reduction.mergedDuplicates} merged as duplicates, ${kb.reduction.droppedUngroundedFileIds} ungrounded ` +
      `fileId(s) dropped); ${kb.reduction.jsonBytes} bytes` +
      (kb.reduction.omittedClusters.length ? `; communities omitted by the cap: ${kb.reduction.omittedClusters.join(", ")}` : ""),
  );
  return lines.join("\n");
}

// --- helpers -----------------------------------------------------------------

/**
 * The merge key: lowercased alphanumeric tokens, deduped and sorted.
 *
 * DELIBERATELY NOT `tokenizeCode`, and the reason is a bug this had. That tokenizer drops tokens
 * shorter than `LEXICAL_MIN_TOKEN_LENGTH` because single characters are noise when RETRIEVING code —
 * a correct decision there, and the wrong one here. As a merge key it made "Cluster 1 is risky" and
 * "Cluster 2 is risky" normalise identically, so two findings about different things collapsed into
 * one and reported themselves as corroborating each other. Caught by the point-cap test, which
 * unexpectedly saw nine distinct headlines merge into one.
 *
 * So this keeps EVERY token, including single digits. Splitting camelCase is also dropped: a
 * headline is prose written by a model, not an identifier.
 */
function normalizeHeadline(headline: string): string {
  return [
    ...new Set(
      headline
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(" ");
}

function importanceRank(importance: "low" | "medium" | "high"): number {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

function repoNameOf(result: AnalysisResult): string {
  const ref = result.repository;
  return ref?.owner ? `${ref.owner}/${ref.name}` : (ref?.name ?? "");
}
