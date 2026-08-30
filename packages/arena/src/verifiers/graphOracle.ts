import { buildImportGraph, getTransitiveDependents } from "@codeflow/graph";
import type { AnalysisResult } from "@codeflow/shared-types";
import type {
  AgentHarness,
  AgentOutput,
  OracleQuestionKind,
  Sandbox,
  TaskSpec,
  VerificationResult,
  Verifier,
} from "../contracts.js";
import { exactReward } from "../reward.js";

/**
 * The GRAPH ORACLE — exact verification with NO LLM call (V3-P0 §0.5).
 *
 * For a whole class of questions ("who calls this?", "what breaks if I change this?") the
 * answer is already a FACT in the analysis result. Asking a model to grade those would be
 * slower, cost money, and vary between runs — three properties that disqualify a grader. This
 * derives the truth from the graph instead, so the verdict is deterministic, free, and not
 * arguable.
 *
 * V3-P1 is what made `who-calls` possible: before the code property graph there were no call
 * edges at all, so the only honest answer to "who calls this?" was "we only know who imports
 * it". `graph.cpgEdges` now carries real call/inheritance relationships, and this oracle reads
 * them — while still being explicit (in `truthFor`) that a call edge is resolved through the
 * calling file's own imports, so an unimported dynamic call is not represented.
 */
export const GRAPH_ORACLE_ID = "graph-oracle";

/** Answer a machine-verifiable question from the frozen analysis. Order-insensitive: the
 *  returned fileIds are sorted so two truths are comparable as sets. */
export function truthFor(kind: OracleQuestionKind, result: AnalysisResult, fileId?: string): string[] {
  switch (kind) {
    case "imports-of": {
      // Files that DIRECTLY import `fileId` (dependency edges only — the documented meaning
      // of an import edge; call edges are the `who-calls` question).
      if (!fileId) return [];
      const edges = result.graph?.edges ?? [];
      return sorted(edges.filter((edge) => edge.to === fileId).map((edge) => edge.from));
    }

    case "who-calls": {
      // Files with a CALL or inheritance edge into `fileId` (V3-P1 `graph.cpgEdges`).
      // NOTE the honest limit: a cpgEdge target is resolved through the calling file's own
      // imports, so this is "files that call into it via an import it declares" — not a
      // compiler-exact reference set. That is why SCIP stays on the roadmap.
      if (!fileId) return [];
      const cpgEdges = result.graph?.cpgEdges ?? [];
      return sorted(cpgEdges.filter((edge) => edge.to === fileId).map((edge) => edge.from));
    }

    case "blast-radius": {
      // Transitive dependents — everything affected if `fileId` changes. Computed with the
      // SAME @codeflow/graph traversal the metrics use, so the oracle and the product cannot
      // drift apart on what "affected" means.
      if (!fileId) return [];
      const graph = result.graph;
      if (!graph) return [];
      const live = buildImportGraph({ nodes: graph.nodes, edges: graph.edges });
      return sorted(getTransitiveDependents(live, fileId).map((entry) => entry.node.id));
    }

    case "entry-points": {
      // Prefer Connect's fileId-keyed projection; fall back to Inventory's POSIX-keyed list
      // (they are the same paths by contract — fileId === repo-relative POSIX path).
      const projected = result.entryPoints?.map((entry) => entry.fileId) ?? [];
      if (projected.length) return sorted(projected);
      return sorted((result.inventory?.entryPoints ?? []).map((entry) => entry.filePath));
    }

    case "cycle-through": {
      // Every file that shares a dependency cycle with `fileId` (excluding itself).
      if (!fileId) return [];
      const cycles = result.metrics?.cycles ?? [];
      const members = new Set<string>();
      for (const cycle of cycles) {
        if (!cycle.files.includes(fileId)) continue;
        for (const member of cycle.files) if (member !== fileId) members.add(member);
      }
      return sorted([...members]);
    }

    default:
      return [];
  }
}

/**
 * The oracle as a VERIFIER: derive the truth, compare the output's fileIds as a set, and
 * score exact-match with precision/recall components so a near-miss is distinguishable from
 * a wrong answer.
 */
export function createGraphOracleVerifier(): Verifier {
  return {
    id: GRAPH_ORACLE_ID,
    supports(task: TaskSpec): boolean {
      // No oracle spec ⇒ not machine-verifiable ⇒ this verifier must not pretend otherwise.
      if (!task.oracle) return false;
      // Every kind except entry-points is ABOUT a file, so it needs one.
      return task.oracle.kind === "entry-points" || Boolean(task.oracle.fileId);
    },
    async verify(task: TaskSpec, output: AgentOutput, sandbox: Sandbox): Promise<VerificationResult> {
      if (!task.oracle) {
        throw new Error(`${GRAPH_ORACLE_ID}: task ${task.id} has no oracle spec — check supports() first.`);
      }
      const truth = truthFor(task.oracle.kind, sandbox.result, task.oracle.fileId);
      const claimed = sorted(output.fileIds ?? []);

      // Ungrounded claims are counted separately from wrong ones: naming a file that does not
      // exist in the repo is a different (worse) failure than naming the wrong real file.
      const ungrounded = claimed.filter((fileId) => !sandbox.hasFile(fileId));

      const truthSet = new Set(truth);
      const claimedSet = new Set(claimed);
      const hits = truth.filter((fileId) => claimedSet.has(fileId));
      const recall = truthSet.size === 0 ? (claimedSet.size === 0 ? 1 : 0) : hits.length / truthSet.size;
      const precision = claimedSet.size === 0 ? (truthSet.size === 0 ? 1 : 0) : hits.length / claimedSet.size;
      const exactMatch = recall === 1 && precision === 1;

      const notes: string[] = [];
      const missing = truth.filter((fileId) => !claimedSet.has(fileId));
      const extra = claimed.filter((fileId) => !truthSet.has(fileId));
      if (missing.length) notes.push(`missed: ${missing.join(", ")}`);
      if (extra.length) notes.push(`not in the truth set: ${extra.join(", ")}`);
      if (ungrounded.length) notes.push(`NOT IN THE REPOSITORY (fabricated): ${ungrounded.join(", ")}`);
      if (exactMatch) notes.push(`exact match on ${truth.length} file(s)`);

      return {
        verifierId: GRAPH_ORACLE_ID,
        passed: exactMatch && ungrounded.length === 0,
        reward: exactReward(exactMatch ? 1 : 0, { recall, precision, grounded: ungrounded.length ? 0 : 1 }, notes),
        exact: true, // no model was consulted
      };
    },
  };
}

/**
 * The oracle as an AGENT — it answers the question it can also grade.
 *
 * This exists to keep the oracle honest: run it as the agent, grade it with itself, and a
 * perfect score is the minimum bar. If that round trip ever fails, the derivation and the
 * comparison have drifted apart, and every score the Arena has produced is suspect.
 */
export function createGraphOracleAgent(): AgentHarness {
  return {
    id: "graph-oracle-agent",
    async run(task: TaskSpec, sandbox: Sandbox): Promise<AgentOutput> {
      if (!task.oracle) return {};
      const fileIds = truthFor(task.oracle.kind, sandbox.result, task.oracle.fileId);
      return { fileIds, text: `${task.oracle.kind}: ${fileIds.length} file(s)` };
    },
  };
}

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
