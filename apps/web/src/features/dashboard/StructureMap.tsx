import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import type { DashboardModel } from "../../lib/dashboard";

interface StructureMapProps {
  model: DashboardModel;
  onOpenFile: (fileId: string) => void;
}

// Render-only cap: show the first N files, with "Show all" to reveal the rest. The underlying
// model list is NEVER truncated (standing rule) — this only bounds what's painted.
const FILE_CAP = 20;

/**
 * View 2 — the structure map. Layout convention up top, file-role counts, then the full file
 * list (sorted by path so directories group together; a directory header precedes each group).
 * Files are clickable into drill-down. Capped to FILE_CAP rows with a "Show all (N)" toggle.
 */
export function StructureMap({ model, onOpenFile }: StructureMapProps) {
  const [showAll, setShowAll] = useState(false);
  const { structure, fileList } = model;
  const visible = showAll ? fileList : fileList.slice(0, FILE_CAP);
  const hidden = fileList.length - visible.length;

  let lastDir = "";

  return (
    <Card className="dash-view dash-structure">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Structure</p>
          <h2>How the repo is laid out</h2>
        </div>
        <Badge tone="info">{structure.layout}</Badge>
      </div>

      <div className="chip-row dash-roles">
        {structure.roleCounts.map((rc) => (
          <span className="chip" key={rc.role}>
            {rc.role}
            <strong>{rc.count}</strong>
          </span>
        ))}
        <span className="chip chip--muted">
          {structure.byDirectory.length} directories · {fileList.length} files
        </span>
      </div>

      <ul className="dash-files">
        {visible.map((file) => {
          const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "(root)";
          const header = dir !== lastDir ? ((lastDir = dir), dir) : null;
          return (
            <li key={file.id}>
              {header !== null ? <p className="dash-files__dir">{header}/</p> : null}
              <button type="button" className="dash-files__file" data-testid="structure-file" onClick={() => onOpenFile(file.id)}>
                <span className="dash-files__name">{file.name}</span>
                <span className={`badge badge-${roleTone(file.role)}`}>{file.role}</span>
                <span className="dash-files__loc">{file.loc} LOC</span>
              </button>
            </li>
          );
        })}
      </ul>

      {fileList.length > FILE_CAP ? (
        <Button type="button" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all (${fileList.length})`}
        </Button>
      ) : null}
      {hidden > 0 ? <small className="dash-files__hidden">{hidden} more not shown</small> : null}
    </Card>
  );
}

function roleTone(role: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (role) {
    case "source":
      return "success";
    case "test":
      return "info";
    case "docs":
      return "neutral";
    case "config":
    case "build":
      return "warning";
    default:
      return "neutral";
  }
}
