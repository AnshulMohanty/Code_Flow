import type { AnalysisResult } from "@codeflow/shared-types";
import { useMemo, useState } from "react";
import {
  assignLanes,
  buildAdjacency,
  hopTieredDependents,
  moveImpact,
  reachesApiSurface,
  safeToChangeAlone,
  testFilesReaching,
} from "../lib/architecture";
import type { GraphModel } from "../lib/graphModel";
import { moduleLabel } from "../lib/citation";
import { count } from "../lib/siteModel";

/**
 * TAB 03 — IMPACT SIMULATOR.
 *
 * `IF I CHANGE IT` / `IF I MOVE IT`, hop-tiered blast radius, and three verdict cards.
 *
 * THE TOGGLE ANSWERS TWO DIFFERENT QUESTIONS, which is why it exists. Changing a module's BEHAVIOUR
 * ripples transitively — anything downstream can be affected. Changing its PATH does not ripple at
 * all: only the files that name it directly have to be edited. Reporting the same number for both
 * would inflate a rename into a refactor, and the design's own toggle implies they differ.
 *
 * THE THIRD VERDICT CARD IS RELABELLED, on the owner's call. There is no coverage data and no
 * test-execution graph here, so "TESTS THAT COVER IT" is not a claim this can make. What it CAN state
 * exactly is which `role: "test"` files reach the module over the resolved import graph, with the
 * nearest hop count — a real deterministic fact under a label that does not overclaim, and the
 * caption says "by import, not coverage" so nobody reads it as the stronger thing.
 */

export interface TabImpactProps {
  result: AnalysisResult;
  graph: GraphModel;
  selectedId: string | null;
  onSelect(fileId: string | null): void;
}

type Mode = "change" | "move";

export function TabImpact({ result, graph, selectedId, onSelect }: TabImpactProps) {
  const [mode, setMode] = useState<Mode>("change");

  const roleByPath = useMemo(
    () => new Map((result.structure?.files ?? []).map((file) => [file.path, file.role as string])),
    [result],
  );
  const roleOf = (fileId: string) => {
    const node = graph.nodes.find((candidate) => candidate.id === fileId);
    return node ? (roleByPath.get(node.path) ?? node.role) : undefined;
  };

  const adjacency = useMemo(() => buildAdjacency(graph), [graph]);
  const lanes = useMemo(
    () =>
      assignLanes(
        graph.nodes.map((node) => ({ fileId: node.id, path: node.path, role: roleByPath.get(node.path) ?? node.role })),
        new Set((result.entryPoints ?? []).map((entry) => entry.fileId)),
      ),
    [graph, roleByPath, result],
  );

  // Default to the most central module, so the tab is useful on arrival rather than empty. It is a
  // real pick from real metrics, not a hardcoded example.
  const fallback = result.metrics?.keyFiles?.[0] ?? graph.nodes[0]?.id ?? null;
  const active = selectedId ?? fallback;

  if (graph.nodes.length === 0 || !active) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing to simulate</p>
        <p className="empty-body">
          This run resolved no dependency graph, so there is no blast radius to compute.
        </p>
      </div>
    );
  }

  const tiers = hopTieredDependents(adjacency, active);
  const move = moveImpact(adjacency, active);
  const api = reachesApiSurface(adjacency, active, lanes);
  const tests = testFilesReaching(adjacency, active, roleOf);
  const safe = safeToChangeAlone(tiers);
  const lane = lanes.byFileId.get(active)?.lane ?? "unclassified";

  // In MOVE mode the tiers collapse to one: only direct references break. Presented as a real single
  // tier rather than as four tiers with three empty ones, because three empty tiers would read as
  // "we checked and found nothing" when the truth is "there is nothing to check past hop 1".
  const maxCount = Math.max(1, ...tiers.tiers.map((tier) => tier.fileIds.length));

  return (
    <>
      <p className="wb-step">Impact simulator</p>
      <div className="wb-head">
        <h2 className="display display-m">{moduleLabel(active)}</h2>
        <p className="wb-head-note">
          {active} · {lane} · {roleOf(active) ?? "unknown role"}
        </p>
      </div>

      <div className="impact">
        <div className="explore-col">
          <p className="panel-label">Pick a module ./</p>
          <div className="mod-list">
            {[...graph.nodes]
              .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id))
              .slice(0, 80)
              .map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className="mod-row"
                  aria-pressed={node.id === active}
                  onClick={() => onSelect(node.id)}
                  title={node.id}
                >
                  <span className="mod-name">{moduleLabel(node.id)}</span>
                </button>
              ))}
          </div>
        </div>

        <div className="explore-col">
          <div className="toggle" role="group" aria-label="Impact mode">
            <button type="button" aria-pressed={mode === "change"} onClick={() => setMode("change")}>
              If I change it
            </button>
            <button type="button" aria-pressed={mode === "move"} onClick={() => setMode("move")}>
              If I move it
            </button>
          </div>

          {mode === "change" ? (
            <div className="tiers">
              {tiers.tiers.map((tier) => (
                <div className="tier" key={tier.hops}>
                  <div>
                    <p className="tier-label">{tier.label}</p>
                    <p className="tier-count">{count(tier.fileIds.length)}</p>
                  </div>
                  <div>
                    <div
                      className="tier-bar"
                      data-empty={tier.fileIds.length === 0}
                      style={{ width: `${Math.max(2, (tier.fileIds.length / maxCount) * 100)}%` }}
                    />
                    <div className="chips">
                      {tier.fileIds.slice(0, 8).map((fileId) => (
                        <button
                          type="button"
                          key={fileId}
                          className="chip"
                          onClick={() => onSelect(fileId)}
                          title={fileId}
                        >
                          {moduleLabel(fileId)}
                        </button>
                      ))}
                      {tier.fileIds.length > 8 ? (
                        <span className="chip-count mono">+{count(tier.fileIds.length - 8)}</span>
                      ) : null}
                      {tier.fileIds.length === 0 ? (
                        <span className="chip-count mono">nothing at this distance</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tiers">
              <div className="tier">
                <div>
                  <p className="tier-label">Must edit</p>
                  <p className="tier-count">{count(move.filesToEdit)}</p>
                </div>
                <div>
                  <div className="tier-bar" style={{ width: "100%" }} />
                  <div className="chips">
                    {move.directImporters.slice(0, 12).map((fileId) => (
                      <button type="button" key={fileId} className="chip" onClick={() => onSelect(fileId)} title={fileId}>
                        {moduleLabel(fileId)}
                      </button>
                    ))}
                    {move.directImporters.length === 0 ? (
                      <span className="chip-count mono">nothing names this module directly</span>
                    ) : null}
                  </div>
                  <p className="verdict-note">
                    A path change breaks only DIRECT references, so the {count(tiers.total)} module
                    {tiers.total === 1 ? "" : "s"} in the change-impact radius are unaffected by a move.
                    {move.ownImports.length > 0
                      ? ` This module's own ${count(move.ownImports.length)} import${move.ownImports.length === 1 ? "" : "s"} are relative and change with it.`
                      : ""}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="verdicts">
            <div className="verdict">
              <p className="verdict-label">Reaches API surface</p>
              <p className="verdict-value" data-tone={api.reaches ? "yes" : "ok"}>
                <span aria-hidden="true">{api.reaches ? "✕" : "✓"}</span>
                {api.reaches
                  ? `yes — ${api.via.map(moduleLabel).join(", ")}`
                  : "no — internal to this repository"}
              </p>
              <p className="verdict-note">
                {api.reaches
                  ? `Nearest at ${api.nearestHops} hop${api.nearestHops === 1 ? "" : "s"}. The application lane is what something outside the repo can call.`
                  : "Nothing in the application lane depends on it, at any distance."}
              </p>
            </div>

            <div className="verdict">
              {/* RELABELLED. See the module note: no coverage source exists, so the card states the
                  import-reachability fact and names the limitation instead of implying coverage. */}
              <p className="verdict-label">Test files that reach it</p>
              <p className="verdict-value" data-tone={tests.count > 0 ? "ok" : "unknown"}>
                <span aria-hidden="true">{tests.count > 0 ? "✓" : "—"}</span>
                {tests.count > 0
                  ? `${count(tests.count)} file${tests.count === 1 ? "" : "s"} · nearest ${tests.nearestHops} hop${tests.nearestHops === 1 ? "" : "s"}`
                  : "no test file reaches it"}
              </p>
              <p className="verdict-note">
                By import reachability, NOT coverage — this analysis has no coverage data, and an
                import does not prove a code path is exercised.
                {tests.fileIds.length > 0 ? ` ${tests.fileIds.map(moduleLabel).join(", ")}.` : ""}
              </p>
            </div>

            <div className="verdict">
              <p className="verdict-label">Safe to change alone</p>
              <p className="verdict-value" data-tone={safe.safe ? "ok" : "yes"}>
                <span aria-hidden="true">{safe.safe ? "✓" : "✕"}</span>
                {safe.advice}
              </p>
              <p className="verdict-note">
                {count(safe.affected)} module{safe.affected === 1 ? "" : "s"} in the transitive radius. The
                threshold is a judgement; the count is exact.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
