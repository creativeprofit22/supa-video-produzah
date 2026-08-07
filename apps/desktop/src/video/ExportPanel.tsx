import { VideoDomainError, type VideoErrorCode } from "@supa-video/contracts";
import type { MediaJobRecord } from "@supa-video/media";
import { AlertCircle, CheckCircle2, Download, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { RenderState } from "../use-video-project";
import { formatDuration, formatFileSize } from "./format-video";
import { isMediaJobActive, isMediaJobSettled, MediaJobStatus } from "./MediaJobStatus";
import type { ReadinessState } from "./VideoProjectOpener";

const renderErrorMessages: Partial<Record<VideoErrorCode, string>> = {
  tool_unavailable: "FFmpeg or FFprobe is unavailable. Check the media tools, then try again.",
  process_failed: "FFmpeg could not finish this export. Check disk space, then try again.",
  process_timeout: "The export took too long. Try again with a shorter range.",
  process_cancelled: "The export was interrupted. Start it again when you are ready.",
  process_output_limit: "FFmpeg returned more output than the app can safely process.",
  invalid_media: "The exported video could not be validated. Try exporting again.",
  invalid_path: "That export destination is no longer valid. Choose another destination.",
  path_not_granted: "Access to that destination expired. Choose it again.",
  project_io: "The export could not be written. Check disk space and folder access.",
  invalid_render_plan: "The project changed. Retry export from the current saved revision.",
};

function safeRenderError(error: Error): string {
  if (
    error instanceof VideoDomainError &&
    error.code === "invalid_render_plan" &&
    error.details["category"] === "unsupported_composition"
  )
    return error.message;
  return error instanceof VideoDomainError
    ? (renderErrorMessages[error.code] ?? "The export could not be completed. Try again.")
    : "The desktop service returned an unexpected response. Restart the app and try again.";
}

interface ExportPanelProps {
  readonly render: RenderState;
  readonly renderJob: MediaJobRecord | null;
  readonly readiness: ReadinessState;
  readonly destinationPending: boolean;
  readonly destinationError: Error | null;
  readonly ineligibilityReason?: string | null;
  readonly disabled: boolean;
  readonly onExport: () => void;
  readonly onCancel: () => void;
  readonly onConfirmOverwrite: () => void;
  readonly onOpenJobCenter: (jobId: string) => void;
}

export function ExportPanel({
  render,
  renderJob,
  readiness,
  destinationPending,
  destinationError,
  ineligibilityReason = null,
  disabled,
  onExport,
  onCancel,
  onConfirmOverwrite,
  onOpenJobCenter,
}: ExportPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelDialogButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const collision = renderJob === null && render.phase === "failed" && render.canOverwrite;
  const toolsReady = readiness.phase === "loaded" && readiness.value.ready;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (collision && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      cancelDialogButtonRef.current?.focus();
    } else if (!collision && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [collision]);

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    exportButtonRef.current?.focus();
  };

  const confirmOverwrite = () => {
    closeDialog();
    onConfirmOverwrite();
  };

  const compatibilityActive = render.phase === "starting" || render.phase === "running";
  const active = renderJob === null ? compatibilityActive : !isMediaJobSettled(renderJob);
  const busy = renderJob === null ? compatibilityActive : isMediaJobActive(renderJob);
  const cancellationPending =
    (render.phase === "running" && render.cancellationPending) ||
    renderJob?.cancellationRequested === true;
  const showCancel =
    render.phase === "running" && (renderJob === null || !isMediaJobSettled(renderJob));
  const verifiedCompletion = renderJob === null || renderJob.state === "complete";
  return (
    <section
      className="panel export-panel"
      aria-labelledby="export-title"
      aria-busy={busy || destinationPending}
    >
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Master</p>
          <h2 id="export-title">Export MP4</h2>
        </div>
        {showCancel ? (
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={cancellationPending}
            onClick={onCancel}
          >
            <X size={16} aria-hidden />
            {cancellationPending ? "Cancelling" : "Cancel export"}
          </button>
        ) : (
          <button
            ref={exportButtonRef}
            className="primary-button"
            type="button"
            disabled={!toolsReady || disabled || destinationPending || active}
            aria-describedby={
              ineligibilityReason === null ? undefined : "export-ineligibility-reason"
            }
            onClick={onExport}
          >
            {destinationPending || (renderJob === null && render.phase === "starting") ? (
              <span className="button-spinner" aria-hidden />
            ) : (
              <Download size={17} aria-hidden />
            )}
            {destinationPending
              ? "Choosing destination"
              : renderJob === null && render.phase === "starting"
                ? "Starting export"
                : verifiedCompletion &&
                    (render.phase === "completed" || render.phase === "completed_with_warning")
                  ? "Export another"
                  : "Export MP4"}
          </button>
        )}
      </div>

      {ineligibilityReason !== null ? (
        <div className="neutral-status" role="status">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Export unavailable for this composition</strong>
            <p id="export-ineligibility-reason">{ineligibilityReason}</p>
          </div>
        </div>
      ) : null}

      {renderJob !== null ? (
        <MediaJobStatus
          job={renderJob}
          label="Final export"
          subject="Final export"
          onOpenJobCenter={onOpenJobCenter}
        />
      ) : render.phase === "idle" ? (
        <p className="panel-guidance">
          Export uses the current saved revision and exact half-open frame range.
        </p>
      ) : render.phase === "starting" ? (
        <div className="neutral-status" role="status">
          <span className="spinner" aria-hidden />
          <div>
            <strong>Starting export</strong>
            <p>Validating the immutable render plan.</p>
          </div>
        </div>
      ) : render.phase === "running" ? (
        <div className="render-progress" role="status">
          <div className="progress-heading">
            <div>
              <strong>
                {render.cancellationPending ? "Cancelling export" : "Exporting video"}
              </strong>
              <p>Keep the app open until the output is verified.</p>
            </div>
            <span>{render.progress}%</span>
          </div>
          <progress aria-label="Video export progress" max={100} value={render.progress} />
        </div>
      ) : null}
      {render.phase === "running" && render.cancellationError !== null ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Could not cancel the export</strong>
            <p>{safeRenderError(render.cancellationError)}</p>
          </div>
        </div>
      ) : null}
      {render.phase === "completed" && verifiedCompletion ? (
        <div className="output-report" role="status">
          <div className="output-report-heading">
            <CheckCircle2 size={20} aria-hidden />
            <div>
              <strong>Export complete</strong>
              <p>The saved MP4 passed native verification.</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(render.output.probe.durationMicroseconds)}</dd>
            </div>
            <div>
              <dt>Dimensions</dt>
              <dd>
                {render.output.probe.width} × {render.output.probe.height}
              </dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd>{render.output.probe.videoCodecName.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{render.output.probe.audio?.codecName.toUpperCase() ?? "None"}</dd>
            </div>
            <div>
              <dt>File size</dt>
              <dd>{formatFileSize(render.output.probe.fileSizeBytes)}</dd>
            </div>
            <div className="output-path">
              <dt>Destination</dt>
              <dd>{render.output.outputPath}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      {render.phase === "completed_with_warning" && verifiedCompletion ? (
        <div className="neutral-status" role="status">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Export saved, preview unavailable</strong>
            <p className="output-path">Saved to {render.outputPath}</p>
          </div>
        </div>
      ) : null}
      {renderJob === null && render.phase === "cancelled" ? (
        <div className="neutral-status" role="status">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Export cancelled</strong>
            <p>No finished output was written.</p>
          </div>
        </div>
      ) : null}
      {renderJob === null && render.phase === "failed" && !render.canOverwrite ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Could not export the video</strong>
            <p>{safeRenderError(render.error)}</p>
          </div>
        </div>
      ) : null}
      {destinationError !== null ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Could not choose that destination</strong>
            <p>{safeRenderError(destinationError)}</p>
          </div>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        className="overwrite-dialog"
        aria-labelledby="overwrite-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => exportButtonRef.current?.focus()}
      >
        <AlertCircle size={22} aria-hidden />
        <h2 id="overwrite-title">Replace the existing file?</h2>
        <p>A file already exists at this destination. Replacing it cannot be undone.</p>
        <div className="dialog-actions">
          <button
            ref={cancelDialogButtonRef}
            className="secondary-button"
            type="button"
            onClick={closeDialog}
          >
            Keep existing file
          </button>
          <button className="danger-button" type="button" onClick={confirmOverwrite}>
            Replace existing file
          </button>
        </div>
      </dialog>
    </section>
  );
}
