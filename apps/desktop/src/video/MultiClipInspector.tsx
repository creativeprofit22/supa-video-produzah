import { useEffect, useId, useRef, useState } from "react";
import { clipSpeedPercent, parseClipSpeedPercent, type ClipSpeed } from "@supa-video/contracts";
import type { BulkClipAction } from "./bulk-clip-edit";
import { validClipAudio, type ClipAudioEdit } from "./clip-audio";
export interface BulkAudioTarget extends ClipAudioEdit {
  duration: number;
  locked: boolean;
  hasAudio: boolean;
  isVideo?: boolean;
  speed?: ClipSpeed;
}
export function commonValue(values: readonly number[]): string {
  return values.length > 0 && values.every((value) => value === values[0]) ? String(values[0]) : "";
}
export function MultiClipInspector({
  targets,
  revisionKey,
  disabled,
  error,
  onApply,
  onBulk,
}: {
  targets: readonly BulkAudioTarget[];
  revisionKey?: string;
  disabled: boolean;
  error: Error | null;
  onApply: (edits: readonly ClipAudioEdit[]) => void | Promise<boolean>;
  onBulk?: (action: BulkClipAction, keyboard: boolean) => Promise<boolean>;
}) {
  const [gain, setGain] = useState(() =>
    commonValue(targets.map((t) => t.gainMilliDecibels / 1000)),
  );
  const [fadeIn, setFadeIn] = useState(() => commonValue(targets.map((t) => t.fades.inFrames)));
  const [fadeOut, setFadeOut] = useState(() => commonValue(targets.map((t) => t.fades.outFrames)));
  const [speedText, setSpeedText] = useState(() =>
    commonValue(targets.map((t) => clipSpeedPercent(t.speed))),
  );
  const [delta, setDelta] = useState("0");
  const pending = useRef(false);
  const focus = useRef<HTMLInputElement | null>(null);
  const gainInput = useRef<HTMLInputElement>(null);
  const speedInput = useRef<HTMLInputElement>(null);
  const moveInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const selectionKey = targets.map((t) => `${t.sequenceId}:${t.trackId}:${t.clipId}`).join(",");
  useEffect(() => {
    setGain(commonValue(targets.map((t) => t.gainMilliDecibels / 1000)));
    setFadeIn(commonValue(targets.map((t) => t.fades.inFrames)));
    setFadeOut(commonValue(targets.map((t) => t.fades.outFrames)));
    setSpeedText(commonValue(targets.map((t) => clipSpeedPercent(t.speed))));
    setDelta("0");
  }, [selectionKey, revisionKey]);
  useEffect(() => {
    focus.current = null;
  }, [selectionKey]);
  useEffect(() => {
    if (!saving && !disabled && focus.current) {
      if (
        document.activeElement === document.body ||
        document.activeElement?.closest('[aria-label="Multiple clip controls"]')
      )
        focus.current.focus();
      focus.current = null;
    }
  }, [saving, disabled, revisionKey, error]);
  const locked = targets.some((t) => t.locked);
  const unavailable = disabled || saving || locked || targets.length === 0 || targets.length > 100;
  const blocked = targets.some((t) => !t.hasAudio);
  const speedUnsupported = targets.some((t) => !t.isVideo);
  const duration = Math.min(...targets.map((t) => t.duration));
  let speed: ClipSpeed | null = null;
  try {
    speed = parseClipSpeedPercent(speedText);
  } catch {
    /* Mixed or invalid draft. */
  }
  const speedValid =
    speed !== null &&
    targets.every(
      (t) =>
        Math.floor((t.duration * clipSpeedPercent(t.speed)) / Number(speedText)) >=
        t.fades.inFrames + t.fades.outFrames,
    );
  const edits = targets.map((t) => ({
    sequenceId: t.sequenceId,
    trackId: t.trackId,
    clipId: t.clipId,
    gainMilliDecibels: gain === "" ? t.gainMilliDecibels : Math.round(Number(gain) * 1000),
    fades: {
      inFrames: fadeIn === "" ? t.fades.inFrames : Number(fadeIn),
      outFrames: fadeOut === "" ? t.fades.outFrames : Number(fadeOut),
    },
  }));
  const valid = edits.every((edit, i) => validClipAudio(edit, targets[i]!.duration));
  const moveValid =
    delta.trim() !== "" && Number.isSafeInteger(Number(delta)) && Number(delta) !== 0;
  const commit = async (
    run: () => void | Promise<boolean>,
    keyboard: boolean,
    input: HTMLInputElement | null,
  ) => {
    if (pending.current || unavailable) return;
    pending.current = true;
    focus.current = keyboard ? input : null;
    setSaving(true);
    try {
      await run();
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <section
      className="panel clip-inspector-panel multi-clip-inspector"
      aria-label="Multiple clip controls"
      aria-busy={saving || disabled}
    >
      <h3>{targets.length} media clips selected</h3>
      <p id={`${id}-help`}>
        Blank mixed fields preserve each clip's value. Apply changes all selected clips in one
        history group (maximum 100).
      </p>
      {locked ? <p role="alert">Unlock every selected track before applying changes.</p> : null}
      {onBulk ? (
        <fieldset disabled={unavailable} aria-describedby={`${id}-help`}>
          <legend>Selected media</legend>
          {speedUnsupported ? <p>Speed requires direct video clips only.</p> : null}
          <label>
            Common speed (%)
            <input
              ref={speedInput}
              type="number"
              min={50}
              max={200}
              step={1}
              placeholder="Mixed"
              value={speedText}
              disabled={speedUnsupported}
              aria-invalid={speedText !== "" && !speedValid}
              aria-describedby={`${id}-speed`}
              onChange={(e) => setSpeedText(e.target.value)}
            />
          </label>
          <p id={`${id}-speed`}>
            Use 50–200%. Existing fades must fit each resulting clip duration.
          </p>
          <button type="button" disabled={speedUnsupported} onClick={() => setSpeedText("100")}>
            Reset speed draft
          </button>
          <button
            type="button"
            disabled={speedUnsupported || !speedValid}
            onClick={(e) => {
              if (speed)
                void commit(
                  () => onBulk({ type: "speed", speed }, e.detail === 0),
                  e.detail === 0,
                  speedInput.current,
                );
            }}
          >
            Apply common speed
          </button>
          <label>
            Relative move (sequence frames)
            <input
              ref={moveInput}
              type="number"
              step={1}
              value={delta}
              aria-invalid={delta !== "0" && !moveValid}
              aria-describedby={`${id}-move`}
              onChange={(e) => setDelta(e.target.value)}
            />
          </label>
          <p id={`${id}-move`}>
            Use signed whole sequence frames. Relative positions are preserved without snapping.
            Unsupported timing contexts reject the entire edit.
          </p>
          <button
            type="button"
            disabled={!moveValid}
            onClick={(e) =>
              void commit(
                () => onBulk({ type: "move", deltaFrames: Number(delta) }, e.detail === 0),
                e.detail === 0,
                moveInput.current,
              )
            }
          >
            Move selected clips
          </button>
          <p>Delete removes timeline clips only, not source files. Undo restores the clips.</p>
          <button
            type="button"
            className="danger-button"
            onClick={(e) =>
              void commit(
                () => onBulk({ type: "delete" }, e.detail === 0),
                e.detail === 0,
                moveInput.current,
              )
            }
          >
            Delete {targets.length} clips (undoable)
          </button>
        </fieldset>
      ) : null}
      {blocked ? <p role="alert">All selected clips must be unlocked and contain audio.</p> : null}
      <fieldset disabled={unavailable || blocked} aria-describedby={`${id}-help ${id}-audio`}>
        <legend>Volume and fades</legend>
        <label>
          Common volume (dB)
          <input
            ref={gainInput}
            type="number"
            min={-96}
            max={24}
            step={0.001}
            placeholder="Mixed / unchanged"
            value={gain}
            aria-invalid={!valid}
            onChange={(e) => setGain(e.target.value)}
          />
        </label>
        <label>
          Common fade in (frames)
          <input
            type="number"
            min={0}
            max={duration}
            step={1}
            placeholder="Mixed / unchanged"
            value={fadeIn}
            aria-invalid={!valid}
            onChange={(e) => setFadeIn(e.target.value)}
          />
        </label>
        <label>
          Common fade out (frames)
          <input
            type="number"
            min={0}
            max={duration}
            step={1}
            placeholder="Mixed / unchanged"
            value={fadeOut}
            aria-invalid={!valid}
            onChange={(e) => setFadeOut(e.target.value)}
          />
        </label>
        <p id={`${id}-audio`} role={!valid ? "alert" : undefined}>
          Volume must be −96 to +24 dB. Whole-frame fades must fit together within every selected
          clip ({duration} frames shortest).
        </p>
        <button
          type="button"
          disabled={!valid}
          onClick={(e) => {
            if (valid && !blocked)
              void commit(() => onApply(edits), e.detail === 0, gainInput.current);
          }}
        >
          Apply to selected clips
        </button>
      </fieldset>
      {error ? <p role="alert">{error.message}</p> : null}
    </section>
  );
}
