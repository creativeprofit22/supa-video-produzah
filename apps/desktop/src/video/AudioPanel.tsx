import {
  VideoDomainError,
  loudnessReportSchema,
  type LoudnessReport,
  type SequenceLoudnessTarget,
  type TrackAudioRole,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { AudioLines } from "lucide-react";
import { useId, useState } from "react";

interface AudioPanelProps {
  readonly sequence: VideoSequenceV2 | null;
  readonly disabled: boolean;
  readonly lastReport: LoudnessReport | null;
  /** `null` removes the track's role. */
  readonly onSetRole: (trackId: string, role: TrackAudioRole | null) => Promise<boolean>;
  /** `null` turns normalization, ducking and dialogue cleanup off. */
  readonly onSetTarget: (target: SequenceLoudnessTarget | null) => Promise<boolean>;
}

const roleLabels: Record<TrackAudioRole, string> = {
  dialogue: "Dialogue",
  music: "Music",
  sfx: "Sound effects",
};

const targets = [
  { value: -14, label: "-14 LUFS (streaming)" },
  { value: -16, label: "-16 LUFS (podcast)" },
  { value: -23, label: "-23 LUFS (broadcast)" },
] as const;

const modeLabels: Record<LoudnessReport["normalizationMode"], string> = {
  measured: "Even gain (measured)",
  dynamic: "Dynamic (range was too wide for even gain)",
  none: "Not normalized",
};

const findingLabels: Record<string, string> = {
  output_loudness_could_not_be_measured: "The export's loudness could not be measured.",
  integrated_loudness_out_of_tolerance: "Loudness is more than 1 LU from the target.",
  true_peak_above_ceiling: "Peaks go above the -1 dBTP ceiling.",
  audio_not_normalized: "Audio was silent or unmeasurable, so it was left unchanged.",
  dynamic_normalization_used:
    "Dynamic normalization was needed; quiet and loud parts were evened out.",
  source_mix_clipped: "The mix already clipped before normalization. Lower clip gain.",
};

/** The loudness report from a render result or a loudness-validation failure. */
export function loudnessReportFrom(output: unknown): LoudnessReport | null {
  if (output instanceof VideoDomainError) {
    if (output.details["category"] !== "loudness_out_of_tolerance") return null;
    const parsed = loudnessReportSchema.safeParse(output.details["report"]);
    return parsed.success ? parsed.data : null;
  }
  if (typeof output === "object" && output !== null && "loudnessReport" in output) {
    const parsed = loudnessReportSchema.safeParse(output.loudnessReport);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function formatDb(value: number | undefined, unit: string): string {
  return value === undefined ? "—" : `${value.toFixed(1)} ${unit}`;
}

export function AudioPanel({
  sequence,
  disabled,
  lastReport,
  onSetRole,
  onSetTarget,
}: AudioPanelProps) {
  const headingId = useId();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = disabled || pending || sequence === null;
  const target = sequence?.loudnessTarget;
  const audioTracks = (sequence?.tracks ?? []).filter((track) => track.kind !== "caption");
  const hasDialogue = audioTracks.some((track) => track.audioRole === "dialogue");
  const hasAudibleDialogue = audioTracks.some(
    (track) => track.audioRole === "dialogue" && track.muted !== true,
  );
  const duckingWarningId = useId();
  const duckingWithoutDialogue = target?.ducking === true && !hasAudibleDialogue;

  const run = async (action: () => Promise<boolean>) => {
    setPending(true);
    setMessage(null);
    try {
      if (!(await action())) setMessage("The audio setting could not be saved. Try again.");
    } finally {
      setPending(false);
    }
  };

  const updateTarget = (change: Partial<SequenceLoudnessTarget>) => {
    const next: SequenceLoudnessTarget = {
      integratedLufs: target?.integratedLufs ?? -16,
      truePeakCeilingDbtp: -1,
      ducking: target?.ducking ?? false,
      dialogueCleanup: target?.dialogueCleanup ?? false,
      ...change,
    };
    if (next.ducking && !hasDialogue) {
      setMessage("Mark a track as Dialogue before turning on ducking.");
      return;
    }
    void run(() => onSetTarget(next));
  };

  return (
    <section className="export-panel audio-panel" aria-labelledby={headingId}>
      <div className="export-panel-header">
        <div>
          <p className="eyebrow">
            <AudioLines aria-hidden="true" size={14} /> Audio
          </p>
          <h3 id={headingId}>Audio mix</h3>
        </div>
      </div>
      {sequence === null ? (
        <p className="muted-copy">Open a sequence to set up its audio mix.</p>
      ) : (
        <>
          <fieldset className="audio-fieldset">
            <legend>Track roles</legend>
            {audioTracks.length === 0 ? (
              <p className="muted-copy">This sequence has no tracks with audio.</p>
            ) : (
              audioTracks.map((track) => (
                <label key={track.id} className="audio-row">
                  <span>{track.name}</span>
                  <select
                    value={track.audioRole ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      if (event.target.value === "") {
                        void run(() => onSetRole(track.id, null));
                        return;
                      }
                      const role = (["dialogue", "music", "sfx"] as const).find(
                        (candidate) => candidate === event.target.value,
                      );
                      if (role) void run(() => onSetRole(track.id, role));
                    }}
                  >
                    <option value="">No role</option>
                    {(Object.keys(roleLabels) as TrackAudioRole[]).map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </label>
              ))
            )}
          </fieldset>
          <fieldset className="audio-fieldset">
            <legend>Loudness</legend>
            <label className="audio-row">
              <span>Target</span>
              <select
                value={target?.integratedLufs ?? ""}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value === "") {
                    void run(() => onSetTarget(null));
                    return;
                  }
                  const value = targets.find(
                    (candidate) => String(candidate.value) === event.target.value,
                  )?.value;
                  if (value !== undefined) updateTarget({ integratedLufs: value });
                }}
              >
                <option value="">Not normalized</option>
                {targets.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted-copy">Peaks are limited to -1 dBTP.</p>
            <label className="captions-checkbox">
              <input
                type="checkbox"
                checked={target?.ducking ?? false}
                disabled={busy}
                aria-describedby={duckingWithoutDialogue ? duckingWarningId : undefined}
                onChange={(event) => updateTarget({ ducking: event.target.checked })}
              />
              Lower music while dialogue plays
            </label>
            {duckingWithoutDialogue ? (
              <p id={duckingWarningId} className="inline-error" role="status">
                Ducking is on, but no unmuted track is marked Dialogue. Export will fail until you
                mark one as Dialogue or turn ducking off.
              </p>
            ) : null}
            <label className="captions-checkbox">
              <input
                type="checkbox"
                checked={target?.dialogueCleanup ?? false}
                disabled={busy}
                onChange={(event) => updateTarget({ dialogueCleanup: event.target.checked })}
              />
              Clean up dialogue (rumble and hiss)
            </label>
          </fieldset>
          <section aria-label="Last export loudness" className="audio-report">
            <h4 className="captions-subheading">Last export</h4>
            {lastReport === null ? (
              <p className="muted-copy">Export with a loudness target to see a report.</p>
            ) : (
              <>
                <p role="status" className={lastReport.passed ? "muted-copy" : "inline-error"}>
                  {lastReport.passed ? "Met the loudness target." : "Missed the loudness target."}
                </p>
                <dl className="audio-report-list">
                  <dt>Target</dt>
                  <dd>{lastReport.targetIntegratedLufs} LUFS</dd>
                  <dt>Measured</dt>
                  <dd>{formatDb(lastReport.outputIntegratedLufs, "LUFS")}</dd>
                  <dt>True peak</dt>
                  <dd>{formatDb(lastReport.outputTruePeakDbtp, "dBTP")}</dd>
                  <dt>Normalization</dt>
                  <dd>{modeLabels[lastReport.normalizationMode]}</dd>
                </dl>
                {lastReport.findings.length === 0 ? null : (
                  <ul className="audio-findings">
                    {lastReport.findings.map((finding) => (
                      <li key={finding}>{findingLabels[finding] ?? finding}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </>
      )}
      {message === null ? null : (
        <p className="inline-error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
