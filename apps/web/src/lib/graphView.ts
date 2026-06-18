import type { GraphModel, GraphModelLink, GraphModelNode } from "./graphModel";

// Render-cap + focus selection over a full GraphModel. PURE: these pick a SUBSET to paint; the
// model is never mutated or truncated. "showing shownCount of totalCount files" is honest.

export type GraphViewMode = "backbone" | "focus" | "all";

export interface GraphView {
  nodes: GraphModelNode[];
  links: GraphModelLink[];
  mode: GraphViewMode;
  /** Files painted (=== nodes.length). */
  shownCount: number;
  /** Files in the full model. */
  totalCount: number;
  truncated: boolean;
  /** Centre of a focus view, if any. */
  focusId?: string;
}

/** Links whose BOTH endpoints are in `ids` (induced subgraph — already grounded by the model). */
function inducedLinks(model: GraphModel, ids: Set<string>): GraphModelLink[] {
  return model.links.filter((l) => ids.has(l.source) && ids.has(l.target));
}

function view(model: GraphModel, nodes: GraphModelNode[], mode: GraphViewMode, focusId?: string): GraphView {
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    links: inducedLinks(model, ids),
    mode,
    shownCount: nodes.length,
    totalCount: model.nodeCount,
    truncated: nodes.length < model.nodeCount,
    ...(focusId ? { focusId } : {}),
  };
}

/** The backbone: the top-N most-central files (ties broken by id) + edges among them. */
export function backboneView(model: GraphModel, n: number): GraphView {
  const top = [...model.nodes]
    .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, n));
  return view(model, top, "backbone");
}

/** The full graph (used by "expand / show all"). */
export function fullView(model: GraphModel): GraphView {
  return view(model, model.nodes, "all");
}

/**
 * The k-hop neighbourhood around `fileId` over the UNDIRECTED adjacency (imports + importers),
 * plus the induced edges. An unknown id yields an empty view; k ≤ 0 yields just the node.
 */
export function focusView(model: GraphModel, fileId: string, k: number): GraphView {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  if (!byId.has(fileId)) return view(model, [], "focus", fileId);

  // Undirected adjacency from the (grounded) links.
  const adj = new Map<string, Set<string>>();
  for (const node of model.nodes) adj.set(node.id, new Set());
  for (const l of model.links) {
    adj.get(l.source)!.add(l.target);
    adj.get(l.target)!.add(l.source);
  }

  const reached = new Set<string>([fileId]);
  let frontier = [fileId];
  for (let hop = 0; hop < Math.max(0, k); hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adj.get(id) ?? []) {
        if (!reached.has(neighbour)) {
          reached.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const nodes = [...reached].map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
  return view(model, nodes, "focus", fileId);
}
