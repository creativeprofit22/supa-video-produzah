import type { EditOperationState } from "../use-video-project";
import { AlertCircle, Redo2, Scissors, Undo2 } from "lucide-react";

interface TrimInspectorProps {
  readonly inFrame: number;
  readonly outFrame: number;
  readonly durationFrames: number;
  readonly valid: boolean;
  readonly changed: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly operation: EditOperationState;
  readonly onInFrameChange: (frame: number) => void;
  readonly onOutFrameChange: (frame: number) => void;
  readonly onApply: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function TrimInspector({
  inFrame,
  outFrame,
  durationFrames,
  valid,
  changed,
  canUndo,
  canRedo,
  operation,
  onInFrameChange,
  onOutFrameChange,
  onApply,
  onUndo,
  onRedo,
}: TrimInspectorProps) {
  const pending = operation.phase === "saving";
  const validationMessage = valid
    ? `${outFrame - inFrame} frames will be kept.`
    : `Enter a range from frame 0 through ${durationFrames}, with trim out after trim in.`;
  return (
    <section className="panel trim-panel" aria-labelledby="trim-title">
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Exact edit</p>
          <h2 id="trim-title">Trim inspector</h2>
        </div>
        <div className="history-actions" aria-label="Edit history">
          <button type="button" disabled={!canUndo || pending} onClick={onUndo}>
            <Undo2 size={16} aria-hidden />
            Undo
          </button>
          <button type="button" disabled={!canRedo || pending} onClick={onRedo}>
            <Redo2 size={16} aria-hidden />
            Redo
          </button>
        </div>
      </div>

      <div className="trim-fields">
        <label>
          <span>Trim in</span>
          <span className="frame-input">
            <input
              type="number"
              inputMode="numeric"
              aria-label="Trim in"
              min={0}
              max={Math.max(0, durationFrames - 1)}
              step={1}
              value={inFrame}
              disabled={pending}
              aria-describedby="trim-help"
              aria-invalid={!valid}
              onChange={(event) => onInFrameChange(event.currentTarget.valueAsNumber)}
            />
            <span>frame</span>
          </span>
        </label>
        <label>
          <span>Trim out</span>
          <span className="frame-input">
            <input
              type="number"
              inputMode="numeric"
              aria-label="Trim out"
              min={1}
              max={durationFrames}
              step={1}
              value={outFrame}
              disabled={pending}
              aria-describedby="trim-help"
              aria-invalid={!valid}
              onChange={(event) => onOutFrameChange(event.currentTarget.valueAsNumber)}
            />
            <span>frame</span>
          </span>
        </label>
      </div>
      <p id="trim-help" className={valid ? "field-help" : "field-help is-error"}>
        {validationMessage}
      </p>

      {operation.phase === "error" ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Could not save the edit</strong>
            <p>The committed range is unchanged. Your draft values are still available.</p>
          </div>
        </div>
      ) : null}

      <button
        className="primary-button apply-trim-button"
        type="button"
        disabled={!valid || !changed || pending}
        onClick={onApply}
      >
        {pending ? (
          <span className="button-spinner" aria-hidden />
        ) : (
          <Scissors size={17} aria-hidden />
        )}
        {pending ? "Saving trim" : "Apply trim"}
      </button>
    </section>
  );
}
