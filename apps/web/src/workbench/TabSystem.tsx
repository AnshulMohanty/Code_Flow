import type { AnalysisResult, FileRole } from "@codeflow/shared-types";
import { useMemo } from "react";
import {
  ARCHITECTURE_RULES,
  CONTAINER_LANES,
  LANE_LABELS,
  LANE_NOTES,
  assignLanes,
  classifyEdges,
  type ContainerLane,
  type LaneMatch,
} from "../lib/architecture";
import type { GraphModel } from "../lib/graphModel";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";

/**
 * TAB 01 — SYSTEM. "C4 container level · derived from <N> resolved edges."
 *
 * The container diagram, and every element of it is derived from something real: nodes and fan
 * badges from the resolved import graph, lane assignment from the parser's file roles plus path
 * segments, edge classification from the lane pair. Selecting a module dims everything it does not
 * touch — a highlight that is a fact about the graph rather than a hover effect.
 *
 * THE VIOLATION CLASS IS OWNER-DEFINED. Two rules, chosen by the owner and no others: UI → platform
 * direct, and API skipping the domain. An architectural rule set is a policy decision about a
 * codebase, so a third rule invented here would be rendering an opinion as a fact. The legend shows
 * the violation entry only when a rule actually fires — a legend key for a class that cannot occur is
 * a claim about the codebase too.
 *
 * WHY A LANE ASSIGNMENT IS AUDITABLE. Each module's subtitle names WHY it landed where it did (its
 * role, an entry point, or the path segment that matched). A diagram that placed modules by an
 * unexplained rule would be asking for trust it has not earned.
 */

export interface TabSystemProps {
  result: AnalysisResult;
  graph: GraphModel;
  selectedId: string | null;
  onSelect(fileId: string | null): void;
}

/** Modules listed per lane. Render-only — the lane's COUNT is always the full one. */
const LANE_RENDER_CAP = 14;

/**
 * The roles the design's row shows, in its order.
 *
 * MOVED HERE FROM TAB 04. It sat above the inferred domain lanes, which meant that hiding the lanes
 * when a run produced none would also have hidden this — and these are the parser's own
 * classification: real, measured, and available on every run including a keyless one. Losing
 * measured data to tidy away an empty panel would be the wrong trade in this codebase specifically.
 */
const SHOWN_ROLES: FileRole[] = ["source", "build", "config", "test", "docs"];

export function TabSystem({ result, graph, selectedId, onSelect }: TabSystemProps) {
  const roleCounts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const file of result.structure?.files ?? []) {
      tally.set(file.role, (tally.get(file.role) ?? 0) + 1);
    }
    return tally;
  }, [result]);

  const roleByPath = useMemo(
    () => new Map((result.structure?.files ?? []).map((file) => [file.path, file.role as string])),
    [result],
  );
  const entryPointIds = useMemo(
    () => new Set((result.entryPoints ?? []).map((entry) => entry.fileId)),
    [result],
  );

  const lanes = useMemo(
    () =>
      assignLanes(
        graph.nodes.map((node) => ({ fileId: node.id, path: node.path, role: roleByPath.get(node.path) ?? node.role })),
        entryPointIds,
      ),
    [graph, roleByPath, entryPointIds],
  );

  const classified = useMemo(() => classifyEdges(graph, lanes), [graph, lanes]);

  const fan = useMemo(() => {
    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();
    for (const link of graph.links) {
      inbound.set(link.target, (inbound.get(link.target) ?? 0) + 1);
      outbound.set(link.source, (outbound.get(link.source) ?? 0) + 1);
    }
    return { inbound, outbound };
  }, [graph]);

  /** Modules the selection touches, one hop. Used to dim the rest. */
  const linked = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const set = new Set<string>();
    for (const link of graph.links) {
      if (link.source === selectedId) set.add(link.target);
      if (link.target === selectedId) set.add(link.source);
    }
    return set;
  }, [graph, selectedId]);

  const selectedEdges = useMemo(
    () =>
      selectedId
        ? classified.edges.filter((edge) => edge.from === selectedId || edge.to === selectedId)
        : classified.edges.filter((edge) => edge.class === "violation"),
    [classified, selectedId],
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No container diagram</p>
        <p className="empty-body">
          This run resolved no dependency graph, so there are no containers to lay out. The pipeline
          rows on the resolving step name the stage that stopped.
        </p>
      </div>
    );
  }

  // Lanes with nothing in them are OMITTED, not shown empty. An empty "EDGE — TRANSPORT" box would
  // read as "this system has no transport layer", which is a claim; omitting it says nothing.
  const present = CONTAINER_LANES.filter((lane) => (lanes.byLane.get(lane)?.length ?? 0) > 0);
  const unclassified = lanes.byLane.get("unclassified") ?? [];
  const rendered: ContainerLane[] = unclassified.length > 0 ? [...present, "unclassified"] : [...present];

  return (
    <>
      <p className="wb-step">
        System design · C4 container level · derived from {count(graph.linkCount)} resolved edges
      </p>
      <div className="wb-head">
        <h2 className="display display-m">
          {repoName(result)} — as built<span className="dot" aria-hidden="true" />
        </h2>
        <p className="wb-head-note">
          {count(graph.nodeCount)} modules · {rendered.length} lanes
        </p>
      </div>

      <div className="legend">
        <span className="legend-item">
          <span className="legend-mark" aria-hidden="true" /> control flow
        </span>
        <span className="legend-item">
          <span className="legend-mark" data-kind="data" aria-hidden="true" /> data / read
        </span>
        {/* Shown ONLY when a sanctioned rule actually fired. A key for an impossible class would be a
            claim about this codebase in its own right. */}
        {classified.counts.violation > 0 ? (
          <span className="legend-item" style={{ color: "var(--refused)" }}>
            <span className="legend-mark" data-kind="violation" aria-hidden="true" /> violation (
            {count(classified.counts.violation)})
          </span>
        ) : (
          <span className="legend-item">no rule violations detected</span>
        )}
      </div>

      <div className="c4" data-selected={selectedId !== null}>
        {rendered.map((lane) => {
          const members = lanes.byLane.get(lane) ?? [];
          return (
            <section className="c4-lane" key={lane}>
              <header className="c4-lane-head">
                <h3 className="c4-lane-title">{LANE_LABELS[lane]}</h3>
                {LANE_NOTES[lane] ? <span className="c4-lane-note">{LANE_NOTES[lane]}</span> : null}
              </header>
              <div className="c4-modules">
                {members.slice(0, LANE_RENDER_CAP).map((fileId) => {
                  const assignment = lanes.byFileId.get(fileId)!;
                  const inbound = fan.inbound.get(fileId) ?? 0;
                  const outbound = fan.outbound.get(fileId) ?? 0;
                  return (
                    <button
                      type="button"
                      key={fileId}
                      className="c4-module"
                      aria-pressed={fileId === selectedId}
                      data-linked={linked.has(fileId) ? "true" : undefined}
                      onClick={() => onSelect(fileId === selectedId ? null : fileId)}
                      title={fileId}
                    >
                      <span className="c4-module-top">
                        <span className="c4-module-name">{moduleLabel(fileId)}</span>
                        <span className="c4-module-fan">
                          ↯{inbound}/{outbound}
                        </span>
                      </span>
                      <span className="c4-module-sub">{describeMatch(assignment.matchedBy)}</span>
                    </button>
                  );
                })}
              </div>
              {members.length > LANE_RENDER_CAP ? (
                <p className="c4-lane-note" style={{ marginTop: 8 }}>
                  + {count(members.length - LANE_RENDER_CAP)} more in this lane
                </p>
              ) : null}
            </section>
          );
        })}
      </div>

      <section className="edge-list" aria-label="Edges">
        <p className="panel-label">
          {selectedId ? `Edges touching ${moduleLabel(selectedId)}` : "Rule violations"}
          <span className="panel-label-right mono">{count(selectedEdges.length)}</span>
        </p>
        {selectedEdges.length === 0 ? (
          <p className="honest-detail" style={{ margin: 0 }}>
            {selectedId
              ? "This module has no resolved edges in either direction — nothing imports it and it imports nothing."
              : "No edge matches either sanctioned rule. That is a real result, not an absence of checking."}
          </p>
        ) : (
          selectedEdges.slice(0, 40).map((edge) => (
            <p className="edge-row" key={`${edge.from}->${edge.to}`} data-class={edge.class}>
              <span>{moduleLabel(edge.from)}</span>
              <span className="edge-arrow" aria-hidden="true">
                {edge.class === "control" ? "──▸" : edge.class === "data" ? "⋯▸" : "⋯▸"}
              </span>
              <span>{moduleLabel(edge.to)}</span>
              {edge.rule ? <span className="edge-rule">{ARCHITECTURE_RULES[edge.rule].label}</span> : null}
            </p>
          ))
        )}
      </section>

      <p className="wb-step" style={{ marginTop: 34 }}>
        Structural roles — deterministic pass
      </p>
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
      <p className="honest-detail">
        The parser&rsquo;s own classification of every file it discovered. No model is involved, and
        these are available on every run — including one with no provider key.
      </p>
    </>
  );
}

/** The human form of a lane match. This is what makes the assignment auditable rather than magic. */
export function describeMatch(match: LaneMatch): string {
  switch (match.kind) {
    case "role":
      return `role: ${match.detail}`;
    case "entry-point":
      return "detected entry point";
    case "path-token":
      return `path: /${match.detail}/`;
    case "default-source":
      return "source, no lane token — business logic by default";
    case "unclassified":
      return "no rule placed this module";
  }
}

function repoName(result: AnalysisResult): string {
  const repo = result.repository;
  return repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}
