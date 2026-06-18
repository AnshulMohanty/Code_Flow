export function GraphLegend() {
  return (
    <div className="graph-legend" aria-label="Graph legend placeholder">
      <span><i className="legend-dot legend-ui" /> UI</span>
      <span><i className="legend-dot legend-api" /> API</span>
      <span><i className="legend-dot legend-data" /> Data</span>
      <span><i className="legend-dot legend-risk" /> Risk</span>
    </div>
  );
}
