import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * SUGGESTED QUESTIONS, built from the repository in front of the user.
 *
 * The design shows three: "What breaks if I change the session shape?", "Where does a request
 * actually enter?", "What's safe to delete?". Those are the prototype's questions about its sample
 * repository — the first one names a module (`auth/session`) that exists in `vercel/next.js` and
 * almost certainly not in yours.
 *
 * A hardcoded suggestion that names a module the repository does not contain is a small lie with a
 * large cost: the user clicks it, gets a refusal, and concludes the engine cannot answer. So the
 * suggestions are TEMPLATED over real facts — the most central module, the detected entry point, the
 * most isolated file — and a template whose fact is missing is simply not offered.
 *
 * The generic third question ("what's safe to delete?") needs no fact and is always offered, because
 * it is answerable from the graph alone.
 */

/** Suggestions shown. Three, as the design has it — more becomes a menu rather than a nudge. */
export const MAX_SUGGESTIONS = 3;

export function suggestedQuestions(result: AnalysisResult | null): string[] {
  if (!result) return [];
  const questions: string[] = [];

  // The most central module: the one whose change ripples furthest. Named, so the question is
  // about this repository and not about software in general.
  const central = result.metrics?.keyFiles?.[0];
  if (central) questions.push(`What breaks if I change ${short(central)}?`);

  // A real detected entry point. Only offered when Inventory found one — "where does a request
  // enter?" is a bad question for a library, and asking it anyway wastes a paid call.
  // `EntryPoint.fileId` (Connect) and `InventoryEntryPoint.filePath` (Inventory) are the same
  // repo-relative path under two field names; either is real evidence.
  const entry = result.entryPoints?.[0]?.fileId ?? result.inventory?.entryPoints?.[0]?.filePath;
  if (entry) questions.push(`What happens when ${short(entry)} runs?`);

  // A real dependency cycle, if there is one. This is the question a graph is uniquely good at, and
  // offering it when there are no cycles would be inviting a refusal.
  const cycle = result.metrics?.cycles?.[0];
  if (cycle && cycle.files.length > 0 && questions.length < MAX_SUGGESTIONS) {
    questions.push(`Why is there a cycle through ${short(cycle.files[0])}?`);
  }

  // Answerable from the graph alone, so it needs no fact and is always safe to offer.
  if (questions.length < MAX_SUGGESTIONS) questions.push("What's safe to delete?");

  return questions.slice(0, MAX_SUGGESTIONS);
}

/** The last two path segments — enough to identify a module, short enough for a chip. */
function short(fileId: string): string {
  const parts = fileId.split("/");
  return parts.length <= 2 ? fileId : parts.slice(-2).join("/");
}
