import { DEFAULT_CLIP_TRANSFORM_GEOMETRY, type ClipTransform } from "@supa-video/contracts";
import { AlertCircle, LockKeyhole, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ClipSpeedControl, type ClipSpeedSelection } from "./ClipSpeedControl";
import type { ClipSpeedEdit } from "./clip-speed-edit";

export interface ClipOpacityTarget {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
}

export interface SelectedVideoClip extends ClipOpacityTarget {
  readonly speedTiming?: ClipSpeedSelection;
  readonly clipLabel: string;
  readonly trackLabel: string;
  readonly transform: ClipTransform;
  readonly opacityPermille: number;
  readonly locked: boolean;
}

export interface ClipOpacityDraft extends ClipOpacityTarget {
  readonly opacityPermille: number;
}

export interface ClipTransformDraft extends ClipOpacityTarget {
  readonly transform: ClipTransform;
}

interface ClipInspectorProps {
  readonly revisionKey?: string;
  readonly speedSaving?: boolean;
  readonly speedError?: Error | null;
  readonly onSpeedCommit?: (edit: ClipSpeedEdit) => void;
  readonly selection: SelectedVideoClip | null;
  readonly transform: ClipTransform | null;
  readonly opacityPermille: number | null;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly onDraftChange: (draft: ClipOpacityDraft) => void;
  readonly onCommit: (draft: ClipOpacityDraft) => void;
  readonly onTransformDraftChange: (draft: ClipTransformDraft) => void;
  readonly onTransformCommit: (draft: ClipTransformDraft) => void;
}

function percentageForPermille(opacityPermille: number): string {
  return `${(opacityPermille / 10).toFixed(1)}%`;
}

function opacityDraftFor(selection: SelectedVideoClip, opacityPermille: number): ClipOpacityDraft {
  return {
    sequenceId: selection.sequenceId,
    trackId: selection.trackId,
    clipId: selection.clipId,
    opacityPermille,
  };
}

function transformDraftFor(
  selection: SelectedVideoClip,
  transform: ClipTransform,
): ClipTransformDraft {
  return {
    sequenceId: selection.sequenceId,
    trackId: selection.trackId,
    clipId: selection.clipId,
    transform,
  };
}

type GeometryField = keyof typeof DEFAULT_CLIP_TRANSFORM_GEOMETRY;

const geometryFields: readonly {
  readonly field: GeometryField;
  readonly label: string;
  readonly unit: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly fixedPointScale: number;
}[] = [
  {
    field: "positionXPermille",
    label: "X position",
    unit: "%",
    minimum: -100_000,
    maximum: 100_000,
    step: 0.1,
    fixedPointScale: 10,
  },
  {
    field: "positionYPermille",
    label: "Y position",
    unit: "%",
    minimum: -100_000,
    maximum: 100_000,
    step: 0.1,
    fixedPointScale: 10,
  },
  {
    field: "scaleXPermille",
    label: "X scale",
    unit: "%",
    minimum: 0.1,
    maximum: 100_000,
    step: 0.1,
    fixedPointScale: 10,
  },
  {
    field: "scaleYPermille",
    label: "Y scale",
    unit: "%",
    minimum: 0.1,
    maximum: 100_000,
    step: 0.1,
    fixedPointScale: 10,
  },
  {
    field: "rotationMilliDegrees",
    label: "Rotation",
    unit: "°",
    minimum: -360_000,
    maximum: 360_000,
    step: 0.001,
    fixedPointScale: 1_000,
  },
];

function geometryInputValues(transform: ClipTransform | null): Record<GeometryField, string> {
  return Object.fromEntries(
    geometryFields.map(({ field, fixedPointScale }) => [
      field,
      transform === null ? "" : String(transform[field] / fixedPointScale),
    ]),
  ) as Record<GeometryField, string>;
}

export function ClipInspector({
  revisionKey,
  speedSaving = false,
  speedError = null,
  onSpeedCommit,
  selection,
  transform,
  opacityPermille,
  disabled,
  saving,
  error,
  onDraftChange,
  onCommit,
  onTransformDraftChange,
  onTransformCommit,
}: ClipInspectorProps) {
  const speedInputRef = useRef<HTMLInputElement | null>(null);
  const speedReturnFocusRef = useRef<{
    selectionKey: string | null;
    revisionKey: string | undefined;
    sawSaving: boolean;
  } | null>(null);
  const opacityDirtyRef = useRef(false);
  const opacityDraftValueRef = useRef(opacityPermille);
  const transformDirtyRef = useRef(false);
  const transformDraftValueRef = useRef(transform);
  const [transformDirty, setTransformDirty] = useState(false);
  const [transformError, setTransformError] = useState<string | null>(null);
  const [transformInputs, setTransformInputs] = useState(() => geometryInputValues(transform));
  const selectionKey =
    selection === null ? null : `${selection.sequenceId}:${selection.trackId}:${selection.clipId}`;

  useEffect(() => {
    const pending = speedReturnFocusRef.current;
    if (pending === null) return;
    if (pending.selectionKey !== selectionKey) {
      speedReturnFocusRef.current = null;
      return;
    }
    if (speedSaving) pending.sawSaving = true;
    if (speedSaving || saving || disabled || selection?.locked) return;
    if (!pending.sawSaving && pending.revisionKey === revisionKey && speedError === null) return;
    speedReturnFocusRef.current = null;
    const input = speedInputRef.current;
    // Only repair focus lost by our disabled/remounted Apply, not focus moved elsewhere.
    if (input !== null && input.ownerDocument.activeElement === input.ownerDocument.body)
      input.focus();
  }, [selectionKey, revisionKey, speedSaving, saving, disabled, selection?.locked, speedError]);

  useEffect(() => {
    opacityDirtyRef.current = false;
    opacityDraftValueRef.current = opacityPermille;
    transformDirtyRef.current = false;
    transformDraftValueRef.current = transform;
    setTransformDirty(false);
    setTransformError(null);
    setTransformInputs(geometryInputValues(transform));
  }, [selectionKey]);

  useEffect(() => {
    if (!opacityDirtyRef.current) opacityDraftValueRef.current = opacityPermille;
  }, [opacityPermille]);

  useEffect(() => {
    if (transformDirtyRef.current) return;
    transformDraftValueRef.current = transform;
    setTransformInputs(geometryInputValues(transform));
  }, [transform]);

  const commitOpacity = () => {
    const value = opacityDraftValueRef.current;
    if (selection === null || value === null || !opacityDirtyRef.current) return;
    opacityDirtyRef.current = false;
    onCommit(opacityDraftFor(selection, value));
  };

  const commitTransform = () => {
    const value = transformDraftValueRef.current;
    if (
      selection === null ||
      value === null ||
      !transformDirtyRef.current ||
      transformError !== null
    )
      return;
    transformDirtyRef.current = false;
    setTransformDirty(false);
    onTransformCommit(transformDraftFor(selection, value));
  };

  const updateTransform = (field: GeometryField, value: number) => {
    if (selection === null || transform === null) return;
    const nextTransform = { ...transform, [field]: value };
    transformDirtyRef.current = true;
    transformDraftValueRef.current = nextTransform;
    setTransformDirty(true);
    setTransformError(null);
    onTransformDraftChange(transformDraftFor(selection, nextTransform));
  };

  const resetTransform = () => {
    if (selection === null || transform === null) return;
    const nextTransform = { ...transform, ...DEFAULT_CLIP_TRANSFORM_GEOMETRY };
    transformDirtyRef.current = true;
    transformDraftValueRef.current = nextTransform;
    setTransformDirty(true);
    setTransformError(null);
    setTransformInputs(geometryInputValues(nextTransform));
    onTransformDraftChange(transformDraftFor(selection, nextTransform));
  };

  const controlsDisabled = disabled || selection?.locked === true;

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

      {selection === null || opacityPermille === null || transform === null ? (
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

          {selection.speedTiming !== undefined && onSpeedCommit !== undefined ? (
            <ClipSpeedControl
              key={`${selectionKey}:${revisionKey}`}
              selection={{ ...selection, ...selection.speedTiming }}
              disabled={controlsDisabled || saving}
              saving={speedSaving}
              error={speedError}
              inputRef={speedInputRef}
              onCommit={(edit, keyboard) => {
                speedReturnFocusRef.current = keyboard
                  ? { selectionKey, revisionKey, sawSaving: false }
                  : null;
                onSpeedCommit(edit);
              }}
            />
          ) : null}

          <fieldset className="clip-transform-controls" disabled={controlsDisabled}>
            <legend>Transform</legend>
            <div className="clip-transform-grid">
              {geometryFields.map((configuration) => {
                const id = `clip-${configuration.field}`;
                return (
                  <label key={configuration.field} htmlFor={id}>
                    <span>{configuration.label}</span>
                    <span className="clip-transform-input">
                      <input
                        id={id}
                        type="number"
                        min={configuration.minimum}
                        max={configuration.maximum}
                        step={configuration.step}
                        value={transformInputs[configuration.field]}
                        onChange={(event) => {
                          const rawValue = event.currentTarget.value;
                          setTransformInputs((current) => ({
                            ...current,
                            [configuration.field]: rawValue,
                          }));
                          const displayedValue = event.currentTarget.valueAsNumber;
                          const fixedPointValue = Math.round(
                            displayedValue * configuration.fixedPointScale,
                          );
                          if (
                            !Number.isFinite(displayedValue) ||
                            !Number.isSafeInteger(fixedPointValue) ||
                            displayedValue < configuration.minimum ||
                            displayedValue > configuration.maximum
                          ) {
                            transformDirtyRef.current = true;
                            setTransformDirty(true);
                            setTransformError(
                              `${configuration.label} must be between ${configuration.minimum} and ${configuration.maximum}${configuration.unit}.`,
                            );
                            return;
                          }
                          updateTransform(configuration.field, fixedPointValue);
                        }}
                        aria-invalid={transformError !== null}
                        aria-describedby={
                          transformError === null ? undefined : "clip-transform-error"
                        }
                      />
                      <span aria-hidden>{configuration.unit}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {transformError !== null ? (
              <p className="clip-transform-validation" id="clip-transform-error" role="alert">
                {transformError}
              </p>
            ) : null}
            <div className="clip-transform-actions">
              <button
                className="primary-button compact-button"
                type="button"
                disabled={controlsDisabled || !transformDirty || transformError !== null}
                onClick={commitTransform}
              >
                Apply transform
              </button>
              <button
                className="secondary-button compact-button clip-transform-reset"
                type="button"
                disabled={controlsDisabled}
                onClick={resetTransform}
              >
                <RotateCcw size={15} aria-hidden />
                Reset transform
              </button>
            </div>
          </fieldset>

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
              disabled={controlsDisabled}
              aria-valuetext={percentageForPermille(opacityPermille)}
              aria-describedby={selection.locked ? "clip-appearance-locked" : undefined}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isInteger(value) || value < 0 || value > 1_000) return;
                opacityDirtyRef.current = true;
                opacityDraftValueRef.current = value;
                onDraftChange(opacityDraftFor(selection, value));
              }}
              onPointerUp={commitOpacity}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitOpacity();
              }}
              onBlur={commitOpacity}
            />
          </div>

          {selection.locked ? (
            <p className="clip-inspector-guidance" id="clip-appearance-locked">
              <LockKeyhole size={16} aria-hidden />
              Unlock this track to change clip appearance.
            </p>
          ) : null}

          {saving ? (
            <p className="clip-inspector-saving" role="status" aria-live="polite">
              <span className="spinner" aria-hidden />
              Saving clip appearance
            </p>
          ) : null}

          {error !== null ? (
            <div className="inline-error clip-inspector-error" role="alert">
              <AlertCircle size={18} aria-hidden />
              <div>
                <strong>Could not save clip appearance</strong>
                <p>{error.message}</p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
