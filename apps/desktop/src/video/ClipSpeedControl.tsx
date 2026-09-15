import {
  clipSpeedPercent,
  clipTimelineDuration,
  parseClipSpeedPercent,
  type ClipSpeed,
  type RationalRate,
  type RationalTime,
} from "@supa-video/contracts";
import { RotateCcw } from "lucide-react";
import { useState, type Ref } from "react";
import type { ClipSpeedEdit } from "./clip-speed-edit";

export interface ClipSpeedSelection {
  readonly speed?: ClipSpeed;
  readonly sourceIn: RationalTime;
  readonly sourceOut: RationalTime;
  readonly sequenceRate: RationalRate;
}

export function ClipSpeedControl({
  selection,
  disabled,
  saving,
  error,
  onCommit,
  inputRef,
}: {
  readonly selection: ClipSpeedSelection & Omit<ClipSpeedEdit, "speed">;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly onCommit: (edit: ClipSpeedEdit, keyboard: boolean) => void;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const canonical = String(clipSpeedPercent(selection.speed));
  const [text, setText] = useState(canonical);
  let validation: string | null = null;
  let duration: number | null = null;
  let speed: ClipSpeed | null = null;
  try {
    speed = parseClipSpeedPercent(text);
    duration = clipTimelineDuration(
      { in: selection.sourceIn, out: selection.sourceOut },
      selection.sequenceRate,
      speed,
    ).value;
  } catch (cause) {
    validation = cause instanceof Error ? cause.message : String(cause);
  }
  return (
    <fieldset className="clip-transform-controls" disabled={disabled || saving} aria-busy={saving}>
      <legend>Speed</legend>
      <label htmlFor="clip-speed">Speed (%)</label>
      <input
        ref={inputRef}
        id="clip-speed"
        type="number"
        min={50}
        max={200}
        step={1}
        value={text}
        aria-invalid={validation !== null}
        aria-describedby="clip-speed-duration clip-speed-error"
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <p id="clip-speed-duration" role="status">
        {duration === null
          ? "Exact duration unavailable"
          : `Resulting duration: ${duration} sequence frames`}
      </p>
      <div className="clip-transform-actions">
        {[50, 100, 150, 200].map((percent) => (
          <button
            key={percent}
            type="button"
            className="secondary-button compact-button"
            onClick={() => setText(String(percent))}
          >
            {percent}%
          </button>
        ))}
      </div>
      <div className="clip-transform-actions">
        <button
          type="button"
          className="primary-button compact-button"
          disabled={
            disabled || saving || speed === null || validation !== null || text === canonical
          }
          onClick={(event) => {
            if (speed !== null && validation === null && !disabled && !saving)
              onCommit(
                {
                  sequenceId: selection.sequenceId,
                  trackId: selection.trackId,
                  clipId: selection.clipId,
                  speed,
                },
                event.detail === 0,
              );
          }}
        >
          Apply speed
        </button>
        <button
          type="button"
          className="secondary-button compact-button clip-transform-reset"
          disabled={disabled || saving || text === "100"}
          onClick={() => setText("100")}
        >
          <RotateCcw size={15} aria-hidden />
          Reset speed
        </button>
      </div>
      <p className="clip-inspector-guidance">
        Source range and later clips stay in place. Draft speed is not previewed. Reset selects
        100%; Apply saves it.
      </p>
      <div id="clip-speed-error">
        {validation !== null || error !== null ? (
          <p className="clip-transform-validation" role="alert">
            {validation ?? error?.message}
          </p>
        ) : null}
      </div>
      {saving ? (
        <p className="clip-inspector-saving" role="status">
          Saving clip speed
        </p>
      ) : null}
    </fieldset>
  );
}
