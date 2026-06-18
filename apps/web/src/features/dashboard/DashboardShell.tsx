import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { Tabs } from "../../components/ui/Tabs";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/appStore";
import { StartHere } from "./StartHere";
import { StructureMap } from "./StructureMap";
import { FileDrilldown } from "./FileDrilldown";
import { AskRepo } from "./AskRepo";
import { DependencyGraph } from "../graph/DependencyGraph";

type DashboardView = "start" | "structure" | "graph" | "drilldown" | "ask";

const TABS = [
  { label: "Start here", value: "start" as const },
  { label: "Structure", value: "structure" as const },
  { label: "Graph", value: "graph" as const },
  { label: "Drill-down", value: "drilldown" as const },
  { label: "Ask the repo", value: "ask" as const },
];

/**
 * The dashboard shell: a repo header, navigation across the data-read views, and the selected-file
 * context the drill-down reads. Opening a file from any view switches to drill-down. The 2D graph
 * is a placeholder (its own session, P17). Visually consistent with the P15 pipeline panel.
 */
export function DashboardShell() {
  const dashboard = useAppStore((state) => state.dashboard);
  const graph = useAppStore((state) => state.graph);
  const selectedFileId = useAppStore((state) => state.selectedFileId);
  const selectFile = useAppStore((state) => state.selectFile);
  const currentJobId = useAppStore((state) => state.currentJobId);
  const [view, setView] = useState<DashboardView>("start");

  if (!dashboard) {
    return (
      <Card className="dash-view">
        <EmptyState title="No analysis loaded" message="Analyze a public repository to explore the dashboard." />
      </Card>
    );
  }

  const openFile = (fileId: string) => {
    selectFile(fileId);
    setView("drilldown");
  };

  return (
    <section className="dashboard">
      <Card className="dash-header">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h2>{dashboard.repositoryName}</h2>
          </div>
          <span className="chip chip--muted">
            {dashboard.fileCount} files · {dashboard.structure.layout}
          </span>
        </div>
        <Tabs items={TABS} value={view} onChange={(v) => setView(v)} />
      </Card>

      {view === "start" ? <StartHere startHere={dashboard.startHere} onOpenFile={openFile} /> : null}
      {view === "structure" ? <StructureMap model={dashboard} onOpenFile={openFile} /> : null}
      {view === "graph" ? (
        graph ? (
          <DependencyGraph model={graph} selectedFileId={selectedFileId} onSelectNode={selectFile} onOpenFile={openFile} />
        ) : (
          <Card className="dash-view">
            <EmptyState title="Dependency graph" message="No graph available for this run." />
          </Card>
        )
      ) : null}
      {view === "drilldown" ? <FileDrilldown model={dashboard} fileId={selectedFileId} onOpenFile={openFile} /> : null}
      {view === "ask" ? <AskRepo jobId={currentJobId} onOpenFile={openFile} /> : null}
    </section>
  );
}
