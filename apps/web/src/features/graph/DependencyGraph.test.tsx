import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DependencyGraph } from "./DependencyGraph";
import { buildGraphModel } from "../../lib/graphModel";
import { mockAnalysisResult, mockBigResult } from "../../lib/mockAnalysis";

// Canvas doesn't render in jsdom — mock the force-graph and capture the props/handlers it
// receives, then assert the DATA + callbacks (never canvas pixels).
const fg = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock("react-force-graph-2d", () => ({
  default: (props: Record<string, unknown>) => {
    fg.props = props;
    return null;
  },
}));

beforeEach(() => {
  fg.props = null;
});
afterEach(cleanup);

describe("DependencyGraph", () => {
  it("renders the backbone with an honest 'N of M' and passes grounded data to the force-graph", () => {
    const model = buildGraphModel(mockAnalysisResult());
    render(<DependencyGraph model={model} selectedFileId={null} onSelectNode={() => {}} onOpenFile={() => {}} />);

    expect(screen.getByText(/showing 4 of 4 files/)).toBeInTheDocument();
    expect(fg.props).not.toBeNull();
    const data = fg.props!.graphData as { nodes: unknown[]; links: unknown[] };
    expect(data.nodes).toHaveLength(4);
    expect(data.links).toHaveLength(2); // src/index.ts → auth, → db
  });

  it("node click sets the dashboard selected-file (→ drill-down context)", () => {
    const model = buildGraphModel(mockAnalysisResult());
    const onSelectNode = vi.fn();
    render(<DependencyGraph model={model} selectedFileId={null} onSelectNode={onSelectNode} onOpenFile={() => {}} />);

    const onNodeClick = fg.props!.onNodeClick as (n: { id: string }) => void;
    act(() => onNodeClick({ id: "src/auth.ts" }));
    expect(onSelectNode).toHaveBeenCalledWith("src/auth.ts");
  });

  it("'Show all' raises the cap without dropping model data (render-only cap)", () => {
    const model = buildGraphModel(mockBigResult(100));
    render(<DependencyGraph model={model} selectedFileId={null} onSelectNode={() => {}} onOpenFile={() => {}} />);

    // Backbone caps the painted nodes; the model keeps all 100.
    expect(screen.getByText(/showing 80 of 100 files/)).toBeInTheDocument();
    expect((fg.props!.graphData as { nodes: unknown[] }).nodes).toHaveLength(80);
    expect(model.nodeCount).toBe(100); // underlying model intact

    fireEvent.click(screen.getByRole("button", { name: /Show all \(100\)/ }));
    expect(screen.getByText(/showing 100 of 100 files/)).toBeInTheDocument();
    expect((fg.props!.graphData as { nodes: unknown[] }).nodes).toHaveLength(100);
  });

  it("focuses a node's k-hop neighbourhood on click", () => {
    const model = buildGraphModel(mockAnalysisResult());
    render(<DependencyGraph model={model} selectedFileId={null} onSelectNode={() => {}} onOpenFile={() => {}} />);

    act(() => (fg.props!.onNodeClick as (n: { id: string }) => void)({ id: "src/index.ts" }));
    // 1-hop around src/index.ts → itself + auth + db (3 of 4).
    expect(screen.getByText(/showing 3 of 4 files/)).toBeInTheDocument();
    expect(screen.getByText(/focus:/)).toBeInTheDocument();
  });

  it("degenerate graph (no nodes) → graceful empty state, no force-graph", () => {
    const empty = buildGraphModel({ ...mockAnalysisResult(), graph: { nodes: [], edges: [], resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] } }, files: [] });
    render(<DependencyGraph model={empty} selectedFileId={null} onSelectNode={() => {}} onOpenFile={() => {}} />);

    expect(screen.getByText("No dependency graph")).toBeInTheDocument();
    expect(fg.props).toBeNull(); // force-graph not rendered
  });
});
