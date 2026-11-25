import type { AnalysisResult, FileRole } from "@codeflow/shared-types";
import { useMemo, useState } from "react";
import {
  ARCHITECTURE_RULES,
  CONTAINER_LANES,
  LANE_LABELS,
  LANE_NOTES,
  assignLanes,
  buildAdjacency,
  classifyEdges,
  hopTieredDependents,
  type ContainerLane,
  type LaneMatch,
} from "../lib/architecture";
import { BOARD_H, BOARD_W, buildSystemDiagram, placeLabels, type SystemDiagram } from "../lib/systemDiagram";
import { edgeKey } from "../lib/radial";
import { heroLabel } from "../lib/heroGraph";
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
  /** Click-through from a container box to TAB 03 for that module — the design's "click for impact". */
  onOpenImpact?(fileId: string): void;
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

export function TabSystem({ result, graph, selectedId, onSelect, onOpenImpact }: TabSystemProps) {
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

  const adjacency = useMemo(() => buildAdjacency(graph), [graph]);
  const diagram = useMemo(() => {
    const cache = new Map<string, number>();
    const downstream = (fileId: string) => {
      let value = cache.get(fileId);
      if (value === undefined) {
        value = hopTieredDependents(adjacency, fileId).total;
        cache.set(fileId, value);
      }
      return value;
    };
    // One specifier per pair; a value import wins over a type-only one, because it is the import
    // that actually loads the module.
    const specifiers = new Map<string, { specifier?: string; typeOnly?: boolean }>();
    for (const edge of result.graph?.edges ?? []) {
      const key = edgeKey(edge.from, edge.to);
      const existing = specifiers.get(key);
      if (!existing || (existing.typeOnly && !edge.typeOnly)) {
        specifiers.set(key, { specifier: edge.specifier, typeOnly: edge.typeOnly });
      }
    }
    return buildSystemDiagram({
      lanes,
      edges: classified.edges,
      downstream,
      specifier: (from, to) => specifiers.get(edgeKey(from, to)),
    });
  }, [adjacency, classified, lanes, result]);

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
          {repoName(result)} — as built
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

      <SystemBoard
        diagram={diagram}
        selectedId={selectedId}
        onOpen={(fileId) => (onOpenImpact ? onOpenImpact(fileId) : onSelect(fileId))}
      />

      {/* Narrow screens: the same lanes as a list. The board needs ~1100px to be legible, and a
          diagram you must pan sideways on a phone is worse than an honest list of the same facts. */}
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

const LANE_HUES: Record<ContainerLane, string> = {
  "clients-entry": "#6B5B45",
  "edge-transport": "#8C4038",
  application: "#41626A",
  "domain-engine": "#37484F",
  "data-configuration": "#4F4A38",
  "platform-libraries": "#42504A",
  unclassified: "#4A423C",
};

/**
 * The routed board. Hovering or focusing a box isolates every link it has among the shown modules;
 * clicking opens it on IMPACT. Boxes are real buttons, so the board is fully keyboard-operable.
 */
function SystemBoard({
  diagram,
  selectedId,
  onOpen,
}: {
  diagram: SystemDiagram;
  selectedId: string | null;
  onOpen(fileId: string): void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const onBoard = (id: string | null) => (id && diagram.boxes.some((box) => box.id === id) ? id : null);
  const focus = onBoard(hovered) ?? onBoard(selectedId);
  const visible = useMemo(
    () => (focus ? diagram.links.filter((link) => link.from === focus || link.to === focus) : diagram.links.filter((link) => link.primary)),
    [diagram, focus],
  );
  const labels = useMemo(() => placeLabels(diagram, visible), [diagram, visible]);
  const labelByLink = new Map(labels.map((label) => [`${label.from}>${label.to}`, label]));
  const linked = new Set<string>();
  if (focus) {
    linked.add(focus);
    for (const link of visible) {
      linked.add(link.from);
      linked.add(link.to);
    }
  }
  const pct = (value: number, of: number) => `${((value / of) * 100).toFixed(3)}%`;
  const primaryCount = diagram.links.filter((link) => link.primary).length;

  return (
    <div className="sysmap-wrap">
      <div className="sysmap-scroll">
        <div className="sysmap" data-focus={focus !== null}>
          <svg viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} preserveAspectRatio="none" aria-hidden="true" className="sysmap-svg">
            {diagram.groups.map((group) => (
              <rect key={group.lane} className="sysmap-frame" x={group.x} y={group.y} width={group.w} height={group.h} rx={4} />
            ))}
            {visible.map((link) => (
              <g key={`${link.from}>${link.to}`} className="sysmap-link" data-class={link.cls} data-isolated={focus !== null}>
                <path d={link.d} />
                <circle cx={link.head.x} cy={link.head.y} r={3} />
              </g>
            ))}
          </svg>

          {diagram.groups.map((group) => (
            <div
              key={group.lane}
              className="sysmap-group-title"
              style={{ left: pct(group.x + 10, BOARD_W), top: pct(group.y + 8, BOARD_H), width: pct(group.w - 20, BOARD_W) }}
            >
              <span>{LANE_LABELS[group.lane]}</span>
              <span className="sysmap-group-meta">
                {group.shown < group.total ? `top ${count(group.shown)} of ${count(group.total)}` : `${count(group.total)}`}
              </span>
            </div>
          ))}

          {visible.map((link) => {
            const label = labelByLink.get(`${link.from}>${link.to}`);
            if (!label) return null;
            return (
              <span
                key={`label:${link.from}>${link.to}`}
                className="sysmap-label"
                data-class={link.cls}
                data-isolated={focus !== null}
                style={{ left: pct(label.x, BOARD_W), top: pct(label.y, BOARD_H) }}
                aria-hidden="true"
              >
                {link.label}
              </span>
            );
          })}

          {diagram.boxes.map((box) => {
            const isFocus = box.id === focus;
            const dimmed = focus !== null && !linked.has(box.id);
            return (
              <button
                type="button"
                key={box.id}
                className="sysmap-box"
                data-focus={isFocus}
                data-dim={dimmed}
                data-selected={box.id === selectedId}
                style={{
                  left: pct(box.x, BOARD_W),
                  top: pct(box.y, BOARD_H),
                  width: pct(box.w, BOARD_W),
                  height: pct(box.h, BOARD_H),
                  borderLeftColor: LANE_HUES[box.lane],
                }}
                onMouseEnter={() => setHovered(box.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(box.id)}
                onBlur={() => setHovered(null)}
                onClick={() => onOpen(box.id)}
                title={box.id}
                aria-label={`${box.id}: ${count(box.downstream)} modules downstream. Open impact.`}
              >
                <span className="sysmap-box-top">
                  <span className="sysmap-box-name">{heroLabel(box.id)}</span>
                  <span className="sysmap-box-blast" data-heavy={box.downstream >= 12}>
                    ↯{count(box.downstream)}
                  </span>
                </span>
                <span className="sysmap-box-sub">{box.id}</span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="sysmap-notes">
        <span>↯ = modules downstream of a change here</span>
        <span>
          {focus
            ? `${count(visible.length)} link${visible.length === 1 ? "" : "s"} of ${heroLabel(focus)} among the modules shown`
            : `${count(primaryCount)} of ${count(diagram.candidateCount)} links between the modules shown are drawn`}
        </span>
        <span>labels are the import specifier as written</span>
        <span>hover or focus a container to isolate its links · click for impact</span>
      </p>
    </div>
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
