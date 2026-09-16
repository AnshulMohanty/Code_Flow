import type { AnalysisResult } from "@codeflow/shared-types";
import { useMemo } from "react";
import type { GraphModel } from "../lib/graphModel";
import { buildAdjacency, isEntryProbable } from "../lib/architecture";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";

/**
 * TAB 04 — DOMAINS. Inferred domain lanes, and nothing else.
 *
 * `result.ai.domains`, produced by the bounded specialist fan-out, labelled as inference in the
 * header and on every lane. A reader must never mistake an agent's guess about "authentication" for
 * a measured fact, so the distinction is stated more than once rather than in a tooltip.
 *
 * THE TAB IS HIDDEN ENTIRELY WHEN THERE ARE NO LANES — see `hasDomainLanes` and the tab list in
 * Workbench.tsx. The fan-out is 5N+1 provider calls where the single-shot stage is 1, so it is OFF by
 * default and off on every free deployment; a tab that exists only to apologise for a feature nobody
 * enabled is worse than no tab.
 *
 * WHAT MOVED, AND WHY THAT MATTERED. This view used to open with the parser's STRUCTURAL ROLES — real
 * counts, available on every run including a keyless one. Hiding this tab would have hidden those
 * too, so they moved to TAB 01, where they belong anyway: they are facts about the system, not about
 * any agent. Discarding measured data to tidy away an empty panel would have been the wrong trade.
 *
 * WHAT IS STILL DELIBERATELY ABSENT: the community partition. Communities are STRUCTURAL and domains
 * are INFERRED, and quietly substituting one for the other — to have something to show — would be
 * exactly the confusion this view exists to prevent.
 */

export interface TabDomainsProps {
  result: AnalysisResult;
  graph: GraphModel;
  onSelect(fileId: string | null): void;
}

/**
 * Does this analysis have inferred domain lanes to show?
 *
 * Exported because the TAB LIST needs the same answer this component does: the tab is not rendered
 * at all when it is false, and two places deciding that independently is how a tab ends up in the
 * bar with nothing behind it.
 */
export function hasDomainLanes(result: AnalysisResult): boolean {
  return (result.ai?.domains ?? []).length > 0;
}

export function TabDomains({ result, graph, onSelect }: TabDomainsProps) {
  const adjacency = useMemo(() => buildAdjacency(graph), [graph]);
  const entryPointIds = useMemo(() => new Set((result.entryPoints ?? []).map((entry) => entry.fileId)), [result]);

  const lanes = result.ai?.domains ?? [];
  const emptyLanes = lanes.filter((lane) => lane.headlines.length === 0).length;

  return (
    <>
      <p className="inference-note" style={{ margin: "0 0 26px" }}>
        Everything on this tab is INFERRED by specialist agents. The parser&rsquo;s own structural
        roles — which are measured, not inferred — are on TAB 01.
      </p>

      <div className="wb-head">
        <p className="wb-step" style={{ margin: 0 }}>
          Domain lanes — specialist agents · inferred
        </p>
        <p className="wb-head-note">
          {lanes.length === 0
            ? "none — this tab is hidden when a run produces none"
            : `${count(lanes.length)} detected${emptyLanes > 0 ? ` · ${count(emptyLanes)} with no findings` : ""}`}
        </p>
      </div>

      {lanes.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No inferred domains for this run</p>
          <p className="empty-body">
            Domain lanes come from the bounded specialist fan-out, which needs a chat provider and
            community detection. This run produced neither, or it was served from a cache built before
            the lanes were recorded.
            <br />
            <br />
            The structural roles above are unaffected — they are the parser&rsquo;s own classification and
            need no provider. The community partition is also real, but it is a STRUCTURAL grouping and
            is deliberately not shown here as though it were an inferred domain.
          </p>
        </div>
      ) : (
        <div className="lanes">
          {lanes.map((lane) => {
            const probable = lane.moduleIds.filter((fileId) => isEntryProbable(fileId, adjacency, entryPointIds)).length;
            return (
              <section className="lane" key={lane.cluster}>
                <div>
                  <h3 className="lane-title">{lane.title}</h3>
                  <p className="lane-agent">
                    agent · {lane.agentTag}
                    {lane.specialists.length > 1 ? ` (+${lane.specialists.length - 1} more lens)` : ""}
                  </p>
                  <p className="lane-counts">
                    {count(lane.moduleIds.length)} module{lane.moduleIds.length === 1 ? "" : "s"} ·{" "}
                    {count(probable)} entry-probable
                    {lane.corroborated > 0 ? ` · ${count(lane.corroborated)} corroborated` : ""}
                  </p>
                </div>
                <div>
                  {lane.headlines.length > 0 ? (
                    <ul className="lane-headlines">
                      {lane.headlines.map((headline) => (
                        <li className="lane-headline" key={headline}>
                          {headline}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="verdict-note" style={{ marginTop: 0, marginBottom: 12 }}>
                      No specialist reported a finding for this group — a coverage gap, stated rather than
                      hidden.
                    </p>
                  )}
                  <div className="chips">
                    {lane.moduleIds.map((fileId) => (
                      <button
                        type="button"
                        key={fileId}
                        className="chip"
                        onClick={() => onSelect(fileId)}
                        title={fileId}
                      >
                        {moduleLabel(fileId)}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
