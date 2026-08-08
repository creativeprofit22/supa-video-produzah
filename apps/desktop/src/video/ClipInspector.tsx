import { AlertCircle, LockKeyhole } from "lucide-react";
import { useEffect, useRef } from "react";

export interface ClipOpacityTarget {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
}

export interface SelectedVideoClip extends ClipOpacityTarget {
  readonly clipLabel: string;
  readonly trackLabel: string;
  readonly opacityPermille: number;
  readonly locked: boolean;
}

export interface ClipOpacityDraft extends ClipOpacityTarget {
  readonly opacityPermille: number;
}

interface ClipInspectorProps {
  readonly selection: SelectedVideoClip | null;
  readonly opacityPermille: number | null;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly onDraftChange: (draft: ClipOpacityDraft) => void;
  readonly onCommit: (draft: ClipOpacityDraft) => void;
}

function percentageForPermille(opacityPermille: number): string {
  return `${(opacityPermille / 10).toFixed(1)}%`;
}

function draftFor(selection: SelectedVideoClip, opacityPermille: number): ClipOpacityDraft {
  return {
    sequenceId: selection.sequenceId,
    trackId: selection.trackId,
    clipId: selection.clipId,
    opacityPermille,
  };
}

export function ClipInspector({
  selection,
  opacityPermille,
  disabled,
  saving,
  error,
  onDraftChange,
  onCommit,
}: ClipInspectorProps) {
  const dirtyRef = useRef(false);
  const draftValueRef = useRef(opacityPermille);
  const selectionKey =
    selection === null ? null : `${selection.sequenceId}:${selection.trackId}:${selection.clipId}`;

  useEffect(() => {
    dirtyRef.current = false;
    draftValueRef.current = opacityPermille;
  }, [selectionKey]);

  useEffect(() => {
    if (!dirtyRef.current) draftValueRef.current = opacityPermille;
  }, [opacityPermille]);

  const commit = () => {
    const value = draftValueRef.current;
    if (selection === null || value === null || !dirtyRef.current) return;
    dirtyRef.current = false;
    onCommit(draftFor(selection, value));
  };

  return (
    <section
      className="panel clip-inspector-panel"
      aria-labelledby="clip-inspector-title"
      aria-busy={saving}
    >
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Video</p>
          <h2 id="clip-inspector-title">Clip inspector</h2>
        </div>
      </div>

      {selection === null || opacityPermille === null ? (
        <p className="clip-inspector-empty">Select a video clip to edit its appearance.</p>
      ) : (
        <>
          <dl className="clip-inspector-identity">
            <div>
              <dt>Clip</dt>
              <dd>{selection.clipLabel}</dd>
            </div>
            <div>
              <dt>Track</dt>
              <dd>{selection.trackLabel}</dd>
            </div>
          </dl>

          <div className="opacity-control">
            <div className="opacity-control-heading">
              <label htmlFor="clip-opacity">Opacity</label>
              <output htmlFor="clip-opacity">{percentageForPermille(opacityPermille)}</output>
            </div>
            <input
              id="clip-opacity"
              type="range"
              min={0}
              max={1_000}
              step={1}
              value={opacityPermille}
              disabled={disabled || selection.locked}
              aria-valuetext={percentageForPermille(opacityPermille)}
              aria-describedby={selection.locked ? "clip-opacity-locked" : undefined}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isInteger(value) || value < 0 || value > 1_000) return;
                dirtyRef.current = true;
                draftValueRef.current = value;
                onDraftChange(draftFor(selection, value));
              }}
              onPointerUp={commit}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commit();
              }}
              onBlur={commit}
            />
          </div>

          {selection.locked ? (
            <p className="clip-inspector-guidance" id="clip-opacity-locked">
              <LockKeyhole size={16} aria-hidden />
              Unlock this track to change clip opacity.
            </p>
          ) : null}

          {saving ? (
            <p className="clip-inspector-saving" role="status" aria-live="polite">
              <span className="spinner" aria-hidden />
              Saving opacity
            </p>
          ) : null}

          {error !== null ? (
            <div className="inline-error clip-inspector-error" role="alert">
              <AlertCircle size={18} aria-hidden />
              <div>
                <strong>Could not save opacity</strong>
                <p>{error.message}</p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
