import { useEffect, useRef, useState } from "react";
import { sourceRangeError, type SelectedMediaClip } from "./clip-source-range";

export interface SourceRangeEdit {
  clipId: string;
  sourceInFrame: number;
  sourceOutFrame: number;
  timelineStartFrame: number;
}

export function ClipSourceRangeInspector({
  selection,
  unsupported,
  revisionKey,
  disabled,
  saving,
  error,
  onCommit,
}: {
  selection: SelectedMediaClip | null;
  unsupported: boolean;
  revisionKey: string;
  disabled: boolean;
  saving: boolean;
  error: Error | null;
  onCommit: (edit: SourceRangeEdit) => void;
}) {
  const [values, setValues] = useState(["", ""]);
  const submitted = useRef(false);
  const returnFocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const key = selection ? `${selection.sequenceId}:${selection.trackId}:${selection.clipId}` : "";
  const reset = () => {
    setValues(
      selection ? [String(selection.sourceIn.value), String(selection.sourceOut.value)] : ["", ""],
    );
    submitted.current = false;
  };
  useEffect(reset, [key, revisionKey]);
  useEffect(() => {
    returnFocus.current = false;
  }, [key]);
  useEffect(() => {
    if (saving || disabled || selection?.locked) return;
    if (returnFocus.current && input.current && document.activeElement === document.body)
      input.current.focus();
    returnFocus.current = false;
    submitted.current = false;
  }, [saving, disabled, revisionKey, error, selection?.locked]);
  if (!selection && !unsupported) return null;
  if (!selection)
    return (
      <section className="panel" aria-label="Source range inspector">
        <h2>Source range</h2>
        <p>Source range editing is not supported for nested sequences.</p>
      </section>
    );
  const validation = sourceRangeError(selection, values[0]!, values[1]!);
  const changed =
    Number(values[0]) !== selection.sourceIn.value ||
    Number(values[1]) !== selection.sourceOut.value;
  const rate = `${selection.sourceIn.rateNumerator}/${selection.sourceIn.rateDenominator}`;
  return (
    <section
      className="panel clip-inspector-panel"
      aria-label="Source range inspector"
      aria-busy={saving}
    >
      <h2>Source range</h2>
      <p>
        {selection.label} · {selection.totalAssetFrames} source frames · {rate} fps
      </p>
      <fieldset disabled={disabled || saving || selection.locked}>
        <legend>Source frames ({rate} fps)</legend>
        {["Source in", "Source out (exclusive)"].map((label, index) => (
          <label key={label}>
            {label} ({rate} fps)
            <input
              ref={index === 0 ? input : undefined}
              type="number"
              min={0}
              max={selection.totalAssetFrames}
              step={1}
              value={values[index]}
              aria-invalid={validation !== null}
              aria-describedby="source-range-status"
              onChange={(event) =>
                setValues((current) =>
                  current.map((value, at) => (at === index ? event.target.value : value)),
                )
              }
            />
          </label>
        ))}
        <button type="button" onClick={reset}>
          Reset draft
        </button>
        <button
          type="button"
          disabled={!changed || validation !== null}
          onClick={(event) => {
            if (submitted.current || disabled || saving || selection.locked || validation !== null)
              return;
            submitted.current = true;
            returnFocus.current = event.detail === 0;
            onCommit({
              clipId: selection.clipId,
              sourceInFrame: Number(values[0]),
              sourceOutFrame: Number(values[1]),
              timelineStartFrame: selection.timelineStartFrame,
            });
          }}
        >
          Apply source range
        </button>
      </fieldset>
      <p id="source-range-status" role="status" aria-live="polite">
        {selection.locked
          ? "Track is locked."
          : saving
            ? "Saving source range…"
            : (validation ?? error?.message ?? "Timeline start and later clips stay in place.")}
      </p>
    </section>
  );
}
