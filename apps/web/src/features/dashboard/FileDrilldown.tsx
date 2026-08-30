import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { EmptyState } from "../../components/ui/EmptyState";
import { MetricCard } from "./MetricCard";
import type { DashboardModel } from "../../lib/dashboard";

interface FileDrilldownProps {
  model: DashboardModel;
  fileId: string | null;
  onOpenFile: (fileId: string) => void;
}

/**
 * View 3 — file drill-down. Per-file metrics (complexity shown as a RELATIVE rank + bar with an
 * explicit proxy note — never implying cyclomatic precision), symbols, and imports/importers
 * derived from graph.edges. Every neighbour link resolves to a real node and re-opens drill-down.
 */
export function FileDrilldown({ model, fileId, onOpenFile }: FileDrilldownProps) {
  const file = (fileId && model.files[fileId]) || undefined;
  const metricsFileCount = model.fileList.filter((f) => f.metrics).length;

  if (!file) {
    return (
      <Card className="dash-view dash-drill">
        <EmptyState title="No file selected" message="Pick a file in Start here or Structure to inspect it." />
      </Card>
    );
  }

  const m = file.metrics;

  return (
    <Card className="dash-view dash-drill">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Drill-down</p>
          <h2>{file.path}</h2>
        </div>
        <div className="badge-row">
          <Badge tone="info">{file.role}</Badge>
          <Badge tone="neutral">{file.language}</Badge>
        </div>
      </div>

      <div className="metric-grid dash-stats">
        <MetricCard label="LOC" value={file.loc} />
        <MetricCard label="Symbols" value={file.symbolCount} />
        {m ? <MetricCard label="Centrality" value={m.centrality} /> : null}
        {m ? <MetricCard label="Fan-in" value={m.fanIn} /> : null}
        {m ? <MetricCard label="Fan-out" value={m.fanOut} /> : null}
        {m ? <MetricCard label="Blast radius" value={m.blastRadius} /> : null}
      </div>

      {m ? (
        <div className="dash-complexity">
          <div className="dash-complexity__head">
            <span>Complexity</span>
            <strong>
              rank #{m.complexityRank} of {metricsFileCount}
            </strong>
          </div>
          <div className="dash-complexity__bar" role="img" aria-label={`Complexity rank ${m.complexityRank} of ${metricsFileCount}`}>
            <span style={{ width: `${Math.round(m.complexityRelative * 100)}%` }} />
          </div>
          <small className="dash-complexity__note">
            Relative structural proxy (loc + symbols + fan-in/out) — not cyclomatic complexity.
          </small>
        </div>
      ) : (
        <p className="dash-empty">No graph metrics for this file (non-source or isolated).</p>
      )}

      <Section title={`Symbols (${file.symbols.length})`}>
        {file.symbols.length ? (
          <ul className="dash-symbols">
            {file.symbols.map((symbol) => (
              <li key={`${symbol.name}-${symbol.line}`}>
                <span className="dash-symbols__name">{symbol.name}</span>
                <span className="dash-symbols__kind">{symbol.kind}</span>
                <span className="dash-symbols__line">L{symbol.line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dash-empty">No symbols parsed for this file.</p>
        )}
      </Section>

      <div className="dash-neighbours">
        <NeighbourList title={`Imports (${file.imports.length})`} ids={file.imports} model={model} onOpenFile={onOpenFile} empty="Imports nothing in-repo." />
        <NeighbourList title={`Imported by (${file.importers.length})`} ids={file.importers} model={model} onOpenFile={onOpenFile} empty="No in-repo importers." />
      </div>
    </Card>
  );
}

function NeighbourList({
  title,
  ids,
  model,
  onOpenFile,
  empty,
}: {
  title: string;
  ids: string[];
  model: DashboardModel;
  onOpenFile: (fileId: string) => void;
  empty: string;
}) {
  return (
    <Section title={title}>
      {ids.length ? (
        <ul className="dash-links">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className="dash-links__link" onClick={() => onOpenFile(id)}>
                {model.files[id]?.path ?? id}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dash-empty">{empty}</p>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dash-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
