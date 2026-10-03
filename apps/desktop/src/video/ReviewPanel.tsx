import { useId, useState } from "react";

import type { QcFinding } from "@supa-video/contracts";
import { isOverridable, repairProducerFor, repairProgress, type ReviewState } from "@supa-video/qc";

const kindLabels: Readonly<Record<QcFinding["kind"], string>> = {
  black_frames: "Black frames",
  freeze_frames: "Frozen picture",
  silence: "Silence",
  audio_clipping: "Audio clipping",
  loudness_off_target: "Loudness off target",
  subtitle_out_of_bounds: "Caption out of bounds",
  reading_time_short: "Text too quick to read",
  text_outside_safe_area: "Text outside safe area",
  text_overlap: "Overlapping text",
  missing_media: "Missing media",
  repeated_asset: "Repeated shot",
  uncovered_beat: "Beat without picture",
  must_show_missing: "Must-show missing",
  must_not_show_present: "Must-not-show present",
  rights_blocked: "Rights blocked",
  motion_stutter: "Stuttering motion",
  motion_drift: "Slow drift",
  motion_cut_jump: "Motion jumps across a cut",
  cut_off_music_beat: "Cut off the music beat",
  music_fit: "Music fit",
  shot_length_out_of_range: "Shot length outside 1–7 s",
  steady_shot_run: "Steady run of equal shots",
};

const severityLabels: Readonly<Record<QcFinding["severity"], string>> = {
  blocker: "Blocks delivery",
  warning: "Warning",
  info: "Note",
};

function formatSeconds(us: number): string {
  return `${(us / 1_000_000).toFixed(1)} s`;
}

export interface ReviewPanelProps {
  readonly review: ReviewState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly pending: boolean;
  readonly onSeek: (startUs: number) => void;
  readonly onAccept: (findingId: string, reason: string) => void;
  /** Offers a repair through the normal suggestion/approval flow. */
  readonly onProposeRepair: (finding: QcFinding) => void;
  readonly onStopRepair: (findingId: string) => void;
}

function FindingRow({
  finding,
  review,
  pending,
  onSeek,
  onAccept,
  onProposeRepair,
  onStopRepair,
}: Omit<ReviewPanelProps, "loading" | "error" | "review"> & {
  readonly finding: QcFinding;
  readonly review: ReviewState;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const progress = repairProgress(review.decisions, finding.findingId);
  const overridable = isOverridable(finding);
  const canRepair = repairProducerFor(finding.kind) !== null && progress.canAttempt;
  const label = kindLabels[finding.kind];
  return (
    <li className={`qc-finding qc-finding-${finding.severity}`}>
      <div className="qc-finding-heading">
        <strong>{label}</strong>
        <span className="qc-severity">{severityLabels[finding.severity]}</span>
        {progress.accepted ? <span className="qc-accepted">Accepted</span> : null}
      </div>
      <p>{finding.message}</p>
      <button
        className="secondary-button compact-button qc-seek"
        type="button"
        onClick={() => onSeek(finding.range.startUs)}
        aria-label={`Go to ${label} at ${formatSeconds(finding.range.startUs)}`}
      >
        {formatSeconds(finding.range.startUs)}–{formatSeconds(finding.range.endUs)}
      </button>
      {finding.severity !== "info" && !progress.accepted ? (
        <div className="qc-finding-actions">
          {canRepair ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={pending}
              onClick={() => onProposeRepair(finding)}
            >
              Suggest a fix ({progress.attempts}/3)
            </button>
          ) : null}
          {progress.attempts > 0 && !progress.stopped ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={pending}
              onClick={() => onStopRepair(finding.findingId)}
            >
              Stop fixing
            </button>
          ) : null}
          {overridable ? (
            <form
              className="qc-accept-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (reason.trim() !== "") onAccept(finding.findingId, reason.trim());
              }}
            >
              <label htmlFor={reasonId}>Reason to accept anyway</label>
              <input
                id={reasonId}
                value={reason}
                maxLength={480}
                onChange={(event) => setReason(event.target.value)}
              />
              <button
                className="secondary-button compact-button"
                type="submit"
                disabled={pending || reason.trim() === ""}
              >
                Accept anyway
              </button>
            </form>
          ) : (
            <p className="qc-note">
              Rights problems cannot be accepted. Replace or remove the media.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { review, loading, error } = props;
  const findings = review?.manifest.qc.findings ?? [];
  const status = review?.release.status;
  return (
    <section className="panel review-panel" aria-labelledby="review-title" aria-busy={loading}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Quality checks</p>
          <h2 id="review-title">Review</h2>
        </div>
      </div>
      {error !== null ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {review === null ? (
        <p>{loading ? "Loading quality checks…" : "Export the video to run quality checks."}</p>
      ) : (
        <>
          <p role="status">
            {status === "releasable"
              ? findings.length === 0
                ? "No problems found. Ready to deliver."
                : "Ready to deliver."
              : `${review.release.status === "blocked" ? review.release.unresolvedFindingIds.length : 0} problem(s) must be fixed or accepted before delivery.`}
          </p>
          {findings.length > 0 ? (
            <ul className="qc-findings" aria-label="Quality findings">
              {findings.map((finding) => (
                <FindingRow key={finding.findingId} {...props} review={review} finding={finding} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
