import { useEffect, useRef, useState } from "react";
import { validClipAudio, type ClipAudioEdit } from "./clip-audio";

export function ClipAudioInspector({
  selection,
  revisionKey,
  disabled,
  saving,
  error,
  onCommit,
}: {
  selection: (ClipAudioEdit & { duration: number; locked: boolean; label: string }) | null;
  revisionKey: string;
  disabled: boolean;
  saving: boolean;
  error: Error | null;
  onCommit: (edit: ClipAudioEdit) => void;
}) {
  const [values, setValues] = useState(["0", "0", "0"]);
  const submitted = useRef(false);
  const focus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const key = selection ? `${selection.sequenceId}:${selection.trackId}:${selection.clipId}` : "";
  useEffect(() => {
    setValues(
      selection
        ? [
            String(selection.gainMilliDecibels / 1000),
            String(selection.fades.inFrames),
            String(selection.fades.outFrames),
          ]
        : ["0", "0", "0"],
    );
    submitted.current = false;
  }, [key, revisionKey]);
  useEffect(() => {
    focus.current = false;
  }, [key]);
  useEffect(() => {
    if (!saving && focus.current && input.current && document.activeElement === document.body) {
      input.current.focus();
      focus.current = false;
    }
    if (!saving) submitted.current = false;
  }, [saving, revisionKey, error]);
  if (!selection) return null;
  const edit = {
    ...selection,
    gainMilliDecibels: Math.round(Number(values[0]) * 1000),
    fades: { inFrames: Number(values[1]), outFrames: Number(values[2]) },
  };
  const valid =
    values.every((value) => value.trim() !== "") && validClipAudio(edit, selection.duration);
  const changed =
    edit.gainMilliDecibels !== selection.gainMilliDecibels ||
    edit.fades.inFrames !== selection.fades.inFrames ||
    edit.fades.outFrames !== selection.fades.outFrames;
  return (
    <section
      className="panel clip-inspector-panel"
      aria-label="Clip audio inspector"
      aria-busy={saving}
    >
      <h2>Clip audio</h2>
      <p>{selection.label}</p>
      <fieldset disabled={disabled || saving || selection.locked}>
        <legend>Volume and fades</legend>
        {["Volume (dB)", "Fade in (sequence frames)", "Fade out (sequence frames)"].map(
          (label, index) => (
            <label key={label}>
              {label}
              <input
                ref={index === 0 ? input : undefined}
                type="number"
                min={index === 0 ? -96 : 0}
                max={index === 0 ? 24 : selection.duration}
                step={index === 0 ? 0.001 : 1}
                value={values[index]}
                onChange={(event) =>
                  setValues((current) =>
                    current.map((value, at) => (at === index ? event.target.value : value)),
                  )
                }
              />
            </label>
          ),
        )}
        <button type="button" onClick={() => setValues(["0", "0", "0"])}>
          Reset audio
        </button>
        <button
          type="button"
          disabled={!valid || !changed}
          onClick={(event) => {
            if (submitted.current) return;
            submitted.current = true;
            focus.current = event.detail === 0;
            onCommit({
              sequenceId: selection.sequenceId,
              trackId: selection.trackId,
              clipId: selection.clipId,
              gainMilliDecibels: edit.gainMilliDecibels,
              fades: edit.fades,
            });
          }}
        >
          Apply audio
        </button>
      </fieldset>
      {selection.locked ? <p>Track is locked.</p> : null}
      {!valid ? (
        <p role="alert">
          Volume must be −96 to +24 dB; whole-frame fades must fit within {selection.duration}{" "}
          output frames.
        </p>
      ) : null}
      {error ? <p role="alert">{error.message}</p> : null}
    </section>
  );
}
