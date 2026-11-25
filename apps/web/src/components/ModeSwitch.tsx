import { useId } from "react";
import type { AiAvailability, AiChoice } from "../lib/aiMode";

/**
 * THE MODE SWITCH — "Map only · free" / "Map + AI · uses credits".
 *
 * Two NATIVE radio inputs in a fieldset, styled as a segmented control. Native rather than a
 * hand-rolled `role="radiogroup"` because the browser then supplies everything a radio group owes a
 * keyboard user for free — one tab stop, arrow keys to move, Space to select — and a screen reader
 * announces "Analysis mode, radio group, Map only, 1 of 2" without a line of ARIA here.
 *
 * "Map + AI" is DISABLED, not hidden, when the server said AI is off: hiding it would make the free
 * mode look like the whole product, and a disabled option with a reason beside it tells the truth
 * about both. The reason is visible text, not only a tooltip — a tooltip is invisible on touch.
 */

export interface ModeSwitchProps {
  choice: AiChoice;
  availability: AiAvailability;
  onChange(choice: AiChoice): void;
  /** Disabled while a run is starting, so the mode cannot change under an in-flight request. */
  disabled?: boolean;
}

export function ModeSwitch({ choice, availability, onChange, disabled }: ModeSwitchProps) {
  const name = useId();
  const aiOff = !availability.enabled;
  const aiNote = availability.dailyAiAnalyses !== null ? `uses credits · ${availability.dailyAiAnalyses}/day` : "uses credits";

  return (
    <div className="mode">
      <fieldset className="mode-switch" disabled={disabled}>
        <legend className="sr-only">Analysis mode</legend>
        <label className="mode-opt" data-checked={choice === "map-only"}>
          <input
            type="radio"
            name={name}
            value="map-only"
            checked={choice === "map-only"}
            onChange={() => onChange("map-only")}
          />
          <span className="mode-opt-label">Map only</span>
          <span className="mode-opt-note">free</span>
        </label>
        <label
          className="mode-opt"
          data-checked={choice === "map-ai"}
          data-disabled={aiOff}
          title={aiOff ? "AI is off on this server" : undefined}
        >
          <input
            type="radio"
            name={name}
            value="map-ai"
            checked={choice === "map-ai"}
            disabled={aiOff}
            onChange={() => onChange("map-ai")}
          />
          <span className="mode-opt-label">Map + AI</span>
          <span className="mode-opt-note">{aiOff ? "off" : aiNote}</span>
        </label>
      </fieldset>
      {aiOff ? (
        <p className="mode-aside" data-ai-off="true">
          AI is off on this server — Map only is free and complete.
        </p>
      ) : null}
    </div>
  );
}

/** The small badge in the nav pill and the workbench header. Renders nothing when there is no mode. */
export function ModeBadge({ badge }: { badge: { label: string; title: string; ai: boolean } | null }) {
  if (!badge) return null;
  return (
    <span className="mode-badge" data-ai={badge.ai} title={badge.title}>
      {badge.label}
    </span>
  );
}
