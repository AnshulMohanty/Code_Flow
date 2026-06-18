import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2DImport from "react-force-graph-2d";
import { GRAPH_BACKBONE_NODES, GRAPH_FOCUS_HOPS, GRAPH_PERF_WARN_NODES } from "@codeflow/config";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import type { GraphModel } from "../../lib/graphModel";
import { backboneView, focusView, fullView } from "../../lib/graphView";

// The force-graph component has heavy generics; we use only a handful of props, so cast to a
// minimal typed signature. Tests mock the module, so the real (canvas) renderer never loads there.
interface ForceGraphProps {
  graphData: { nodes: unknown[]; links: unknown[] };
  width?: number;
  height?: number;
  nodeId?: string;
  nodeVal?: (node: GraphNodeDatum) => number;
  nodeColor?: (node: GraphNodeDatum) => string;
  nodeLabel?: (node: GraphNodeDatum) => string;
  linkColor?: (link: GraphLinkDatum) => string;
  linkDirectionalArrowLength?: number;
  linkDirectionalArrowRelPos?: number;
  onNodeClick?: (node: GraphNodeDatum) => void;
  cooldownTicks?: number;
  warmupTicks?: number;
  backgroundColor?: string;
}
const ForceGraph2D = ForceGraph2DImport as unknown as (props: ForceGraphProps) => JSX.Element;

interface GraphNodeDatum {
  id: string;
  path: string;
  role: string;
  centrality: number;
  inCycle: boolean;
  size: number;
}
interface GraphLinkDatum {
  source: string;
  target: string;
  kind: string;
  inCycle: boolean;
}

interface DependencyGraphProps {
  model: GraphModel;
  selectedFileId: string | null;
  /** Node click → focus its neighbourhood AND set the dashboard selected-file (stay on graph). */
  onSelectNode: (fileId: string) => void;
  /** Explicit "open in drill-down" (switches tab). */
  onOpenFile: (fileId: string) => void;
}

const ROLE_COLOR: Record<string, string> = {
  source: "#55d6a4",
  test: "#5ba8ff",
  docs: "#9aa7b8",
  config: "#ffd08a",
  build: "#ffb84d",
  asset: "#c08bf0",
  other: "#6b7a8d",
};
const CYCLE_COLOR = "#ff5e74";

/**
 * The interactive 2D dependency graph (canvas + force sim). An ENHANCEMENT, not the only path to
 * the data — the same dependencies are reachable via Structure + Drill-down (canvas isn't
 * screen-readable). Default view is the central backbone with an honest "N of M"; clicking a node
 * focuses its k-hop neighbourhood and drives the dashboard selected-file. The full model is never
 * truncated — "Show all" raises the cap (with a perf warning past the threshold).
 */
export function DependencyGraph({ model, selectedFileId, onSelectNode, onOpenFile }: DependencyGraphProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const reducedMotion = useReducedMotion();
  const { width } = useContainerWidth();
  const containerRef = useRef<HTMLDivElement>(null);

  const viewData = useMemo(() => {
    if (focusId) return focusView(model, focusId, GRAPH_FOCUS_HOPS);
    if (expanded) return fullView(model);
    return backboneView(model, GRAPH_BACKBONE_NODES);
  }, [model, focusId, expanded]);

  // force-graph mutates node/link objects (adds x/y) — hand it fresh copies per view.
  const graphData = useMemo(
    () => ({ nodes: viewData.nodes.map((n) => ({ ...n })), links: viewData.links.map((l) => ({ ...l })) }),
    [viewData],
  );

  if (model.nodeCount === 0) {
    return (
      <Card className="dash-view dash-graph">
        <EmptyState
          title="No dependency graph"
          message="This repo has no resolved file-to-file dependencies to plot. Use Structure and Drill-down to explore files."
        />
      </Card>
    );
  }

  const overThreshold = viewData.shownCount > GRAPH_PERF_WARN_NODES;
  const focusNode = focusId ? model.nodes.find((n) => n.id === focusId) : undefined;

  return (
    <Card className="dash-view dash-graph">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Dependency graph</p>
          <h2>How the files connect</h2>
        </div>
        <Badge tone="info">
          showing {viewData.shownCount} of {viewData.totalCount} files
        </Badge>
      </div>

      <div className="dash-graph__controls">
        {focusNode ? (
          <>
            <span className="chip">
              focus: <strong>{focusNode.name}</strong> · {GRAPH_FOCUS_HOPS}-hop
            </span>
            <Button type="button" variant="ghost" onClick={() => onOpenFile(focusNode.id)}>
              Open in drill-down
            </Button>
            <Button type="button" variant="ghost" onClick={() => setFocusId(null)}>
              Clear focus
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show backbone" : `Show all (${model.nodeCount})`}
          </Button>
        )}
        {model.unresolvedCount > 0 ? (
          <span className="chip chip--muted">{model.unresolvedCount} imports unresolved</span>
        ) : null}
        {model.externalCount > 0 ? <span className="chip chip--muted">{model.externalCount} external</span> : null}
      </div>

      {overThreshold ? (
        <p className="dash-graph__warn" role="status">
          Rendering {viewData.shownCount} nodes — this may be slow. Focus a node or show the backbone for a faster view.
        </p>
      ) : null}

      <div className="dash-graph__canvas" ref={containerRef} data-selected={selectedFileId ?? ""}>
        <ForceGraph2D
          graphData={graphData}
          width={width}
          height={520}
          nodeId="id"
          nodeVal={(node) => node.size}
          nodeColor={(node) => (node.inCycle ? CYCLE_COLOR : ROLE_COLOR[node.role] ?? ROLE_COLOR.other)}
          nodeLabel={(node) => `${node.path} · ${node.role} · centrality ${node.centrality}`}
          linkColor={(link) => (link.inCycle ? "rgba(255,94,116,0.7)" : "rgba(120,140,165,0.28)")}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={1}
          onNodeClick={(node) => {
            setFocusId(node.id);
            onSelectNode(node.id);
          }}
          backgroundColor="rgba(0,0,0,0)"
          warmupTicks={reducedMotion ? 80 : 0}
          cooldownTicks={reducedMotion ? 0 : undefined}
        />
      </div>

      <div className="dash-graph__legend">
        {(["source", "test", "docs", "config"] as const).map((role) => (
          <span className="dash-graph__swatch" key={role}>
            <i style={{ background: ROLE_COLOR[role] }} />
            {role}
          </span>
        ))}
        <span className="dash-graph__swatch">
          <i style={{ background: CYCLE_COLOR }} />
          in a cycle
        </span>
        <span className="chip chip--muted">click a node to focus + select it</span>
      </div>
    </Card>
  );
}

/** Read `prefers-reduced-motion` once (guarded for jsdom, which lacks matchMedia). */
function useReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false,
    [],
  );
}

/** Track the canvas container width (guarded for jsdom, which lacks ResizeObserver). */
function useContainerWidth(): { width: number } {
  const [width, setWidth] = useState(800);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const el = document.querySelector<HTMLElement>(".dash-graph__canvas");
    ref.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { width };
}
