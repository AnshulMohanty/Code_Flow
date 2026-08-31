import type { AnalysisResult } from "@codeflow/shared-types";
import { useMemo, useState } from "react";
import { RadialGraph } from "../components/RadialGraph";
import { AskBlock } from "../components/PipelineCard";
import { buildAdjacency, hopTieredDependents, type ContainerLane } from "../lib/architecture";
import { assignLanes } from "../lib/architecture";
import type { GraphModel } from "../lib/graphModel";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";
import { suggestedQuestions } from "../lib/questions";
import type { AskState } from "../lib/useAnalysis";

/**
 * TAB 02 — EXPLORE.
 *
 * Left: the narrated "START HERE" reading order. Centre: the live radial graph with domain filter
 * chips. Right: the real module list and the selected module's stats.
 *
 * THE NARRATION IS AGENT OUTPUT, and its provenance is stated on screen. `result.ai.synthesis
 * .readingOrder` is the supervisor's (or the single-shot stage's) grounded reading order — every
 * step's `fileId` was checked against `graph.nodes` before it got here, and ungrounded steps were
 * dropped and counted. So each step names a module that exists, and the caption says where the prose
 * came from.
 *
 * WHEN THERE IS NO SYNTHESIS the panel degrades to the deterministic fallback the dashboard model
 * already computes — the most central files, labelled as centrality rather than as narration. It does
 * NOT invent narration, and it does not go blank: a keyless run still has a defensible reading order,
 * it just has no prose about it.
 */

export interface TabExploreProps {
  result: AnalysisResult;
  graph: GraphModel;
  selectedId: string | null;
  onSelect(fileId: string | null): void;
  ask: AskState;
  onAsk(question: string): void;
  askDisabledReason: string | null;
}

/** Filter chips, mapped onto container lanes so the labels mean something structural. */
const FILTERS: Array<{ id: string; label: string; lanes: readonly ContainerLane[] }> = [
  { id: "all", label: "ALL", lanes: [] },
  { id: "backend", label: "BACKEND", lanes: ["edge-transport", "domain-engine", "data-configuration"] },
  { id: "frontend", label: "FRONTEND", lanes: ["application"] },
  { id: "platform", label: "PLATFORM", lanes: ["platform-libraries"] },
  { id: "entry", label: "ENTRY", lanes: ["clients-entry"] },
];

export function TabExplore({
  result,
  graph,
  selectedId,
  onSelect,
  ask,
  onAsk,
  askDisabledReason,
}: TabExploreProps) {
  const [filter, setFilter] = useState("all");

  const roleByPath = useMemo(
    () => new Map((result.structure?.files ?? []).map((file) => [file.path, file.role as string])),
    [result],
  );
  const lanes = useMemo(
    () =>
      assignLanes(
        graph.nodes.map((node) => ({ fileId: node.id, path: node.path, role: roleByPath.get(node.path) ?? node.role })),
        new Set((result.entryPoints ?? []).map((entry) => entry.fileId)),
      ),
    [graph, roleByPath, result],
  );

  const adjacency = useMemo(() => buildAdjacency(graph), [graph]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of FILTERS) {
      map.set(
        item.id,
        item.lanes.length === 0
          ? graph.nodes.length
          : graph.nodes.filter((node) => item.lanes.includes(lanes.byFileId.get(node.id)?.lane ?? "unclassified")).length,
      );
    }
    return map;
  }, [graph, lanes]);

  const filtered = useMemo(() => {
    const active = FILTERS.find((item) => item.id === filter);
    if (!active || active.lanes.length === 0) return graph;
    const keep = new Set(
      graph.nodes.filter((node) => active.lanes.includes(lanes.byFileId.get(node.id)?.lane ?? "unclassified")).map((node) => node.id),
    );
    const nodes = graph.nodes.filter((node) => keep.has(node.id));
    const links = graph.links.filter((link) => keep.has(link.source) && keep.has(link.target));
    // `nodeCount` stays the FULL count so the footer can honestly say "N of M".
    return { ...graph, nodes, links, linkCount: links.length };
  }, [graph, lanes, filter]);

  const steps = useMemo(() => readingSteps(result, graph, adjacency), [result, graph, adjacency]);
  const questions = useMemo(() => suggestedQuestions(result), [result]);

  const selected = selectedId ? graph.nodes.find((node) => node.id === selectedId) : null;
  const tiers = selectedId ? hopTieredDependents(adjacency, selectedId) : null;
  const importers = selectedId ? (adjacency.importers.get(selectedId) ?? []) : [];
  const imports = selectedId ? (adjacency.imports.get(selectedId) ?? []) : [];

  return (
    <>
      <div className="explore">
        {/* ── START HERE ─────────────────────────────────────────────────── */}
        <div className="explore-col">
          <p className="panel-label">Start here ./</p>
          {steps.steps.length === 0 ? (
            <p className="honest-detail" style={{ margin: 0 }}>
              No reading order — this run produced neither a synthesis nor centrality metrics, so there
              is nothing to rank.
            </p>
          ) : (
            <div className="steps">
              {steps.steps.map((step, index) => (
                <button
                  type="button"
                  key={step.fileId}
                  className="step"
                  onClick={() => onSelect(step.fileId)}
                  aria-pressed={step.fileId === selectedId}
                >
                  <span className="step-top">
                    <span className="step-num">{String(index + 1).padStart(2, "0")}</span>
                    <span className="step-title">{moduleLabel(step.fileId)}</span>
                  </span>
                  <span className="step-why">{step.reason}</span>
                  <span className="step-meta">
                    <span className="step-meta-rule" aria-hidden="true" />
                    {count(step.downstream)} downstream · {step.fileId}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* PROVENANCE, on screen. The prose either came from the onboarding agent or it did not,
              and a reader must be able to tell which. */}
          <p className="provenance">{steps.provenance}</p>
        </div>

        {/* ── Live graph ─────────────────────────────────────────────────── */}
        <div className="explore-col explore-center">
          <div style={{ padding: "18px 18px 0" }}>
            <div className="chips">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  disabled={(counts.get(item.id) ?? 0) === 0}
                >
                  {item.label} <span className="chip-count">{count(counts.get(item.id) ?? 0)}</span>
                </button>
              ))}
            </div>
          </div>
          <RadialGraph
            model={filtered}
            selectedId={selectedId}
            onSelect={onSelect}
            caption={`Live graph · ${count(filtered.nodes.length)} of ${count(graph.nodeCount)} modules`}
            readout={
              selected && tiers
                ? `${moduleLabel(selected.id)} → ${count(tiers.total)} downstream · ${tiers.maxHops} hop${tiers.maxHops === 1 ? "" : "s"} · ${lanes.byFileId.get(selected.id)?.lane ?? "unclassified"}`
                : `${count(filtered.links.length)} resolved edges${graph.unresolvedCount > 0 ? ` · ${count(graph.unresolvedCount)} unresolved` : ""}`
            }
          />
        </div>

        {/* ── Modules + stats ───────────────────────────────────────────── */}
        <div className="explore-col">
          <p className="panel-label">
            Modules ./
            <span className="panel-label-right mono">{count(graph.nodeCount)}</span>
          </p>
          <div className="mod-list">
            {[...graph.nodes]
              .sort((a, b) => b.loc - a.loc || a.id.localeCompare(b.id))
              .slice(0, 80)
              .map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className="mod-row"
                  aria-pressed={node.id === selectedId}
                  onClick={() => onSelect(node.id === selectedId ? null : node.id)}
                  title={node.id}
                >
                  <span className="mod-name">{moduleLabel(node.id)}</span>
                  {/* Real LOC from Inventory. `0` for a non-source node is a fact (LOC is a
                      source-code metric), so it renders as 0 rather than being hidden. */}
                  <span className="mod-loc">{node.loc} LOC</span>
                </button>
              ))}
          </div>

          {selected ? (
            <>
              <div className="neighbours">
                <p className="panel-label">Direct neighbours</p>
                <NeighbourFan center={selected.id} importers={importers} imports={imports} />
              </div>
              <div className="stats-rows">
                <p className="stat-row">
                  importers <span className="stat-row-value">{count(importers.length)}</span>
                </p>
                <p className="stat-row">
                  imports <span className="stat-row-value">{count(imports.length)}</span>
                </p>
                <p className="stat-row">
                  blast radius
                  <span className="stat-row-value" data-emphasis="true">
                    {count(tiers?.total ?? 0)} modules
                  </span>
                </p>
                <p className="stat-row">
                  lane <span className="stat-row-value">{lanes.byFileId.get(selected.id)?.lane ?? "unclassified"}</span>
                </p>
                <p className="stat-row">
                  role <span className="stat-row-value">{roleByPath.get(selected.path) ?? selected.role}</span>
                </p>
              </div>
            </>
          ) : (
            <p className="honest-detail" style={{ marginTop: 18 }}>
              Select a module — from this list, the graph, or ⌘K — to see its importers, blast radius
              and lane.
            </p>
          )}
        </div>
      </div>

      <div className="card dark" style={{ marginTop: 18 }}>
        <AskBlock
          suggestions={questions}
          question={ask.question}
          answer={
            ask.answer
              ? { text: ask.answer.answer, answered: ask.answer.answered, citations: ask.answer.citations }
              : null
          }
          busy={ask.busy}
          disabledReason={askDisabledReason}
          onAsk={onAsk}
          result={result}
        />
      </div>
    </>
  );
}

/** The mini fan the design draws for a selected module's direct neighbours. */
export function NeighbourFan({
  center,
  importers,
  imports,
}: {
  center: string;
  importers: readonly string[];
  imports: readonly string[];
}) {
  const shown = [...importers.slice(0, 4), ...imports.slice(0, 3)];
  if (shown.length === 0) {
    return (
      <p className="honest-detail" style={{ margin: 0 }}>
        No resolved neighbours — nothing imports {moduleLabel(center)} and it imports nothing.
      </p>
    );
  }
  const width = 200;
  const step = width / (shown.length + 1);
  return (
    <svg className="neighbour-svg" viewBox={`0 0 ${width} 96`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {shown.map((id, index) => {
        const x = step * (index + 1);
        return (
          <g key={id}>
            <path className="neighbour-edge" d={`M${width / 2},78 Q${(width / 2 + x) / 2},46 ${x},20`} />
            <circle cx={x} cy={20} r={2.2} fill="var(--rust)" />
            <text className="neighbour-label" x={x} y={13} textAnchor="middle">
              {id.split("/").pop()?.replace(/\.[^.]+$/, "")}
            </text>
          </g>
        );
      })}
      <circle cx={width / 2} cy={78} r={3.4} fill="var(--rust)" />
      <text className="neighbour-label" x={width / 2} y={92} textAnchor="middle">
        {moduleLabel(center)}
      </text>
    </svg>
  );
}

export interface ReadingStepView {
  fileId: string;
  reason: string;
  downstream: number;
}

/**
 * The reading order, with its provenance.
 *
 * AGENT-NARRATED when a synthesis exists: the reasons are the supervisor's own prose, already
 * grounded to real graph nodes at production time. DETERMINISTIC otherwise: the most central files,
 * with centrality stated as the reason rather than narrated. The two are never mixed and the caption
 * always says which one this is — a reader must be able to tell a model's sentence from a metric.
 */
export function readingSteps(
  result: AnalysisResult,
  graph: GraphModel,
  adjacency: ReturnType<typeof buildAdjacency>,
): { steps: ReadingStepView[]; provenance: string } {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const downstreamOf = (fileId: string) => hopTieredDependents(adjacency, fileId).total;

  const synthesis = result.ai?.synthesis;
  if (synthesis && synthesis.readingOrder.length > 0) {
    const steps = synthesis.readingOrder
      // Re-grounded on read. It was grounded when produced, but this is a durable document and a
      // step pointing at a file the graph no longer has must not render.
      .filter((step) => nodeIds.has(step.fileId))
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => ({ fileId: step.fileId, reason: step.reason, downstream: downstreamOf(step.fileId) }));
    const dropped = synthesis.droppedCitations ?? 0;
    return {
      steps,
      provenance:
        `Narrated by the onboarding agent over the deterministic graph — every step cites a module that exists.` +
        (dropped > 0 ? ` ${dropped} ungrounded step${dropped === 1 ? "" : "s"} were dropped.` : ""),
    };
  }

  const keyFiles = (result.metrics?.keyFiles ?? []).filter((fileId) => nodeIds.has(fileId)).slice(0, 6);
  return {
    steps: keyFiles.map((fileId) => ({
      fileId,
      reason: "Most-connected file — a lot depends on it, so it is where the shape of the system shows.",
      downstream: downstreamOf(fileId),
    })),
    provenance:
      "Derived from graph centrality, NOT narrated: this run produced no AI synthesis, so there is no agent prose to show.",
  };
}
