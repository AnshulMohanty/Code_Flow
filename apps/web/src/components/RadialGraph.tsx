import { useMemo, useState } from "react";
import type { GraphModel } from "../lib/graphModel";
import { edgeKey, radialFocus, radialLayout } from "../lib/radial";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";

/**
 * THE RADIAL DEPENDENCY GRAPH — "RINGS = HOW FOUNDATIONAL".
 *
 * Every dot is a real module from the resolved import graph; every line is a real edge between two
 * real nodes (the model already dropped dangling ones). Nothing here is generated, sampled or
 * padded — so an empty repository draws an EMPTY state rather than a decorative graph, which is the
 * one case where a plausible-looking picture would be a lie.
 *
 * The count in the footer is the FULL node count, not the drawn one, and it says so when they
 * differ. "31 modules" must never quietly mean "31 modules, some of which we drew".
 */

export interface RadialGraphProps {
  model: GraphModel;
  /** The selected module, or null. Its one-hop neighbourhood lights up. */
  selectedId: string | null;
  onSelect(fileId: string | null): void;
  /** Extra facts about the selection, rendered bottom-right. Caller-supplied so this stays a view. */
  readout?: string | null;
  /** Rendered above the graph. The design's "DEPENDENCY GRAPH · RINGS = HOW FOUNDATIONAL". */
  caption?: string;
}

export function RadialGraph({ model, selectedId, onSelect, readout, caption }: RadialGraphProps) {
  const layout = useMemo(() => radialLayout(model), [model]);
  const focus = useMemo(() => radialFocus(model, selectedId), [model, selectedId]);
  // WHAT AN EDGE IS, on hover. The design's instruction is "hover a module · hover an edge for the
  // import", and an unlabelled line is the one thing in this picture a reader cannot decode. The
  // tooltip states the real, resolved edge — `importer → imported` — and nothing else.
  const [edgeTip, setEdgeTip] = useState<{ label: string; x: number; y: number } | null>(null);

  if (model.nodes.length === 0) {
    return (
      <div className="graph-wrap">
        <div className="graph-empty">
          <span>NO RESOLVED MODULES</span>
          <span>
            This run produced no dependency graph, so there is nothing to draw. The pipeline rows say
            which stage stopped.
          </span>
        </div>
      </div>
    );
  }

  const focused = selectedId !== null;

  return (
    <div className="graph-wrap">
      {caption ? <p className="graph-caption">{caption}</p> : null}
      <svg
        className="graph-svg"
        viewBox={`0 0 ${layout.size} ${layout.size}`}
        preserveAspectRatio="xMidYMid meet"
        data-focused={focused}
        role="img"
        aria-label={`Dependency graph: ${count(model.nodeCount)} modules, ${count(model.linkCount)} resolved edges. Distance from the centre is how foundational a module is.`}
      >
        {/* Guide rings. Decoration for the eye, but they carry the caption's meaning: each ring is a
            band of "how much depends on this". */}
        {layout.rings.map((radius, index) => (
          <circle
            key={index}
            className="graph-ring"
            cx={layout.size / 2}
            cy={layout.size / 2}
            r={radius}
            aria-hidden="true"
          />
        ))}

        {layout.edges.map((edge) => {
          const key = edgeKey(edge.from, edge.to);
          const hot = focus.edges.has(key);
          return (
            <g key={key}>
              <path className="graph-edge" d={edge.path} data-hot={hot ? "true" : undefined} />
              {/* A transparent fat stroke over the hairline: the drawn edge is under a pixel wide and
                  no pointer can reliably land on it. Same geometry, so the hit area is never
                  somewhere the line is not. */}
              <path
                className="graph-edge-hit"
                d={edge.path}
                onMouseMove={(event) =>
                  setEdgeTip({
                    label: `${moduleLabel(edge.from)} → ${moduleLabel(edge.to)}`,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }
                onMouseLeave={() => setEdgeTip(null)}
              />
            </g>
          );
        })}

        {layout.nodes.map((node) => {
          const hot = focus.nodes.has(node.id);
          return (
            <g
              key={node.id}
              className="graph-node"
              data-hot={hot ? "true" : undefined}
              onClick={() => onSelect(node.id === selectedId ? null : node.id)}
              role="button"
              tabIndex={0}
              aria-label={`${node.id} — ${count(node.fanIn)} importers, ${count(node.fanOut)} imports`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id === selectedId ? null : node.id);
                }
              }}
            >
              <circle
                className="graph-node-dot"
                cx={node.x}
                cy={node.y}
                r={hot ? node.radius + 1.4 : node.radius}
                fill={hot ? "var(--rust)" : "var(--chalk-3)"}
              />
              {/* A generous invisible hit area: the dots are small by design, and a 3px click target
                  makes the graph unusable with a trackpad. */}
              <circle cx={node.x} cy={node.y} r={Math.max(9, node.radius + 6)} fill="transparent" />
              {node.labelled || hot ? (
                <text className="graph-label" x={node.x + node.radius + 5} y={node.y + 3}>
                  {node.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {readout ? <p className="graph-readout">{readout}</p> : null}
      {edgeTip ? (
        <span className="graph-tip" aria-hidden="true" style={{ left: edgeTip.x, top: edgeTip.y }}>
          {edgeTip.label}
        </span>
      ) : null}
    </div>
  );
}
