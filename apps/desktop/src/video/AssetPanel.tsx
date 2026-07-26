import type { PreparationState, ProjectOperationState } from "../use-video-project";
import type { MediaProbe, VideoSourceRecord } from "@supa-video/contracts";
import { AlertCircle, CheckCircle2, Film, FolderOpen, RefreshCw } from "lucide-react";

import { formatDuration, formatFileSize, formatFrameRate } from "./format-video";

interface AssetPanelProps {
  readonly probe: MediaProbe | null;
  readonly source: VideoSourceRecord | null;
  readonly preparation: PreparationState;
  readonly projectOperation: ProjectOperationState;
  readonly toolsReady: boolean;
  readonly onChooseSource: () => void;
  readonly onRetryPreparation: () => void;
  readonly onRelinkSource: () => void;
}

export function AssetPanel({
  probe,
  source,
  preparation,
  projectOperation,
  toolsReady,
  onChooseSource,
  onRetryPreparation,
  onRelinkSource,
}: AssetPanelProps) {
  const pending = projectOperation.phase === "pending" || preparation.phase === "pending";
  const unresolved = source?.status === "missing" || source?.status === "relink_required";
  return (
    <section className="panel asset-panel" aria-labelledby="asset-title" aria-busy={pending}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Source</p>
          <h2 id="asset-title">Project media</h2>
        </div>
        {probe === null ? (
          <button
            className="primary-button compact-button"
            type="button"
            disabled={!toolsReady || pending}
            onClick={onChooseSource}
          >
            {pending ? (
              <span className="button-spinner" aria-hidden />
            ) : (
              <FolderOpen size={16} aria-hidden />
            )}
            Choose video
          </button>
        ) : null}
      </div>

      {probe === null ? (
        <div className="empty-state">
          <Film size={26} strokeWidth={1.5} aria-hidden />
          <strong>No source in this project</strong>
          <p>Choose one local video. The original file never becomes a webview media URL.</p>
        </div>
      ) : (
        <>
          <dl className="media-facts">
            <div>
              <dt>Resolution</dt>
              <dd>
                {probe.width} × {probe.height}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(probe.durationMicroseconds)}</dd>
            </div>
            <div>
              <dt>Frame rate</dt>
              <dd>{formatFrameRate(probe.averageFrameRate)} fps</dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd>{probe.videoCodecName.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{probe.audio === null ? "None" : probe.audio.codecName.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatFileSize(probe.fileSizeBytes)}</dd>
            </div>
          </dl>
          {source?.status === "resolved" ? (
            <div className="neutral-status" role="status">
              <CheckCircle2 size={18} aria-hidden />
              <div>
                <strong>Source resolved</strong>
                <p>The native app granted this project access to its source.</p>
              </div>
            </div>
          ) : null}
        </>
      )}

      {unresolved ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>
              {source.status === "missing"
                ? "Source file is missing"
                : "Source access must be restored"}
            </strong>
            <p>
              {source.status === "missing"
                ? "Choose the source file at its new location to continue working."
                : "Choose the original source file to restore access without changing the saved locator."}
            </p>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={pending}
              onClick={onRelinkSource}
            >
              {pending ? (
                <span className="button-spinner" aria-hidden />
              ) : (
                <FolderOpen size={16} aria-hidden />
              )}
              {source.status === "missing" ? "Choose replacement" : "Restore source access"}
            </button>
          </div>
        </div>
      ) : null}

      {preparation.phase === "pending" ? (
        <div className="neutral-status" role="status">
          <span className="spinner" aria-hidden />
          <div>
            <strong>Preparing controlled preview</strong>
            <p>Creating and validating the cache proxy and thumbnail.</p>
          </div>
        </div>
      ) : null}
      {preparation.phase === "error" ? (
        <div className="inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Could not prepare the preview</strong>
            <p>The source remains saved in the project. Check the media tools, then retry.</p>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={!toolsReady}
              onClick={onRetryPreparation}
            >
              <RefreshCw size={16} aria-hidden />
              Retry preview
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
