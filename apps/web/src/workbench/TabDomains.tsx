import type { AnalysisResult, FileRole } from "@codeflow/shared-types";
import { useMemo } from "react";
import type { GraphModel } from "../lib/graphModel";
import { buildAdjacency, isEntryProbable } from "../lib/architecture";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";

/**
 * TAB 04 — DOMAINS. Two halves, and keeping them apart is the whole job of this view.
 *
 * TOP: STRUCTURAL ROLES — DETERMINISTIC PASS. The parser's `classifyRole` output, counted. These are
 * facts: a file either matched a test pattern or it did not.
 *
 * BOTTOM: DOMAIN LANES — SPECIALIST AGENTS · INFERRED. `result.ai.domains`, produced by the fan-out
 * and labelled as inference in the header, in the serif note between the halves, and on every lane.
 *
 * WHY THE LABELLING IS BELT AND BRACES. These two blocks sit inches apart and look alike. A reader
 * who cannot tell them apart will read an agent's guess about "authentication" with the same
 * confidence as the parser's count of test files — and the second is checkable while the first is a
 * model's opinion. So the distinction is stated three times, in three registers, rather than once in
 * a tooltip.
 *
 * WHEN THERE ARE NO DOMAIN LANES (a keyless run, a single-shot synthesis, a cached result from before
 * the field existed) the bottom half says so plainly. It does NOT fall back to showing the community
 * partition as though it were a domain: communities are structural, domains are inferred, and
 * quietly substituting one for the other would be exactly the confusion this view exists to prevent.
 */

export interface TabDomainsProps {
  result: AnalysisResult;
  graph: GraphModel;
  onSelect(fileId: string | null): void;
}

/** The roles the design's top row shows, in its order. */
const SHOWN_ROLES: FileRole[] = ["source", "build", "config", "test", "docs"];

export function TabDomains({ result, graph, onSelect }: TabDomainsProps) {
  const roleCounts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const file of result.structure?.files ?? []) {
      tally.set(file.role, (tally.get(file.role) ?? 0) + 1);
    }
    return tally;
  }, [result]);

  const adjacency = useMemo(() => buildAdjacency(graph), [graph]);
  const entryPointIds = useMemo(() => new Set((result.entryPoints ?? []).map((entry) => entry.fileId)), [result]);

  const lanes = result.ai?.domains ?? [];
  const emptyLanes = lanes.filter((lane) => lane.headlines.length === 0).length;

  return (
    <>
      <p className="wb-step">Structural roles — deterministic pass</p>

      <div className="roles">
        {SHOWN_ROLES.map((role) => {
          const value = roleCounts.get(role) ?? 0;
          return (
            <div className="role" key={role} data-zero={value === 0}>
              <p className="role-count">{count(value)}</p>
              <p className="role-name">
                {role}
                {/* A zero is a FACT here, not a gap: the parser looked and found none. Saying "none"
                    beside the 0 distinguishes it from a figure nobody measured. */}
                {value === 0 ? <span className="role-note"> · none</span> : null}
              </p>
            </div>
          );
        })}
      </div>

      <p className="inference-note" style={{ margin: "18px 0 26px" }}>
        Roles come from the parser. Domains below are inferred by specialist agents — labelled as
        inference, never as fact.
      </p>

      <div className="wb-head">
        <p className="wb-step" style={{ margin: 0 }}>
          Domain lanes — specialist agents · inferred
        </p>
        <p className="wb-head-note">
          {lanes.length === 0
            ? "none available for this run"
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
