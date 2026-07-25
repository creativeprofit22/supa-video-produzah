import { VideoDomainError } from "@supa-video/contracts";
import type {
  MediaProbe,
  VideoErrorCode,
  VideoToolInfo,
  VideoToolProblem,
  VideoToolStatus,
} from "@supa-video/contracts";
import { AlertCircle, CheckCircle2, Download, Film, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./App.css";
import { useVideoProject } from "./use-video-project";
import { getVideoToolStatus, pickVideoSource, probeVideoSource } from "./video-ipc";

type ReadinessState =
  { phase: "loading" } | { phase: "error" } | { phase: "loaded"; value: VideoToolStatus };

const sourceErrorMessages: Partial<Record<VideoErrorCode, string>> = {
  tool_unavailable: "FFprobe is unavailable. Recheck the media tools, then choose the video again.",
  process_failed: "FFprobe could not inspect this video. Try another supported video file.",
  process_timeout: "Video inspection took too long. Try the file again or choose a smaller video.",
  process_cancelled: "Video inspection was cancelled. Choose the video again when you are ready.",
  process_output_limit: "This video contains more metadata than the app can safely process.",
  invalid_media: "This file is not a supported video or its media data is damaged.",
  invalid_path: "That file location is not valid. Choose a local video file.",
  path_not_granted: "Access to that file expired. Choose it again to restore access.",
};

const preparationErrorMessages: Partial<Record<VideoErrorCode, string>> = {
  tool_unavailable:
    "FFmpeg or FFprobe became unavailable. Recheck the media tools, then try again.",
  process_failed: "FFmpeg could not create a safe preview for this video. Try another video file.",
  process_timeout: "Preview preparation took too long. Try the video again.",
  process_cancelled:
    "Preview preparation was cancelled. Choose the video again when you are ready.",
  process_output_limit: "The media tools returned more output than the app can safely process.",
  invalid_media: "A safe preview could not be created from this video. Try another supported file.",
  invalid_path: "That file location is no longer valid. Choose the video again.",
  path_not_granted: "Access to that file expired. Choose it again to restore access.",
  invalid_project: "The project media settings are invalid. Choose the video again.",
  invalid_rate: "The video frame rate is not supported. Try another video file.",
  project_io: "The preview cache could not be written. Check available disk space, then try again.",
};

const renderErrorMessages: Partial<Record<VideoErrorCode, string>> = {
  tool_unavailable:
    "FFmpeg or FFprobe became unavailable. Recheck the media tools, then try again.",
  process_failed:
    "FFmpeg could not finish this export. Check available disk space, then try again.",
  process_timeout: "The export took too long. Try again or choose a shorter source video.",
  process_cancelled: "The export was interrupted. Start it again when you are ready.",
  process_output_limit: "FFmpeg returned more output than the app can safely process.",
  invalid_media: "The exported video could not be validated. Try exporting again.",
  invalid_path: "That export destination is no longer valid. Choose another destination.",
  path_not_granted: "Access to that destination expired. Choose it again to restore access.",
  project_io: "The export could not be written. Check available disk space and folder access.",
  invalid_render_plan:
    "The prepared project changed. Choose the source video again before exporting.",
};

const toolProblemMessages: Record<VideoToolProblem, string> = {
  not_found: "Install it and add it to your system PATH, then check again.",
  timed_out: "The version check timed out. Check security software, then try again.",
  failed: "The version check failed. Repair the installation, then try again.",
  invalid_version: "The installed build returned an unrecognized version. Install a current build.",
};

function sourceErrorMessage(error: Error): string {
  if (error instanceof VideoDomainError) {
    return sourceErrorMessages[error.code] ?? "The video could not be opened. Choose it again.";
  }
  return "The desktop service returned an unexpected response. Restart the app and try again.";
}

function preparationErrorMessage(error: Error): string {
  if (error instanceof VideoDomainError) {
    return (
      preparationErrorMessages[error.code] ??
      "The preview could not be prepared. Choose the video again."
    );
  }
  return "The desktop service returned an unexpected response. Restart the app and try again.";
}

function renderErrorMessage(error: Error): string {
  if (error instanceof VideoDomainError) {
    return renderErrorMessages[error.code] ?? "The export could not be completed. Try again.";
  }
  return "The desktop service returned an unexpected response. Restart the app and try again.";
}

function formatDuration(microseconds: number): string {
  const totalSeconds = Math.round(microseconds / 1_000_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: megabytes < 10 ? 1 : 0 }).format(megabytes)} MB`;
}

interface ToolRowProps {
  readonly label: string;
  readonly tool: VideoToolInfo;
}

function ToolRow({ label, tool }: ToolRowProps) {
  return (
    <li className="tool-row">
      <span
        className={`tool-indicator ${tool.available ? "is-ready" : "is-blocked"}`}
        aria-hidden
      />
      <span className="tool-name">{label}</span>
      <span className="tool-result">{tool.available ? "Available" : "Needs attention"}</span>
      {!tool.available && tool.problem !== undefined ? (
        <p className="tool-guidance">{toolProblemMessages[tool.problem]}</p>
      ) : null}
    </li>
  );
}

interface SourceSummaryProps {
  readonly probe: MediaProbe;
}

function SourceSummary({ probe }: SourceSummaryProps) {
  const frameRate = probe.averageFrameRate.numerator / probe.averageFrameRate.denominator;
  return (
    <div className="source-summary">
      <div className="source-summary-heading">
        <span className="summary-icon" aria-hidden>
          <Film size={20} strokeWidth={1.8} />
        </span>
        <div>
          <p className="summary-kicker">Source ready</p>
          <h3>Selected video</h3>
        </div>
      </div>
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
          <dd>{frameRate.toFixed(2)} fps</dd>
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
          <dt>File size</dt>
          <dd>{formatFileSize(probe.fileSizeBytes)}</dd>
        </div>
      </dl>
    </div>
  );
}

function App() {
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "loading" });
  const readinessRequest = useRef(0);
  const [sourceProbe, setSourceProbe] = useState<MediaProbe | null>(null);
  const [sourceError, setSourceError] = useState<Error | null>(null);
  const [sourcePending, setSourcePending] = useState(false);
  const {
    preparation,
    render,
    destinationPending,
    destinationError,
    renderReady,
    prepareImportedSource,
    exportVideo,
    confirmOverwrite,
    cancelRender,
  } = useVideoProject();

  const checkReadiness = useCallback(async () => {
    const request = ++readinessRequest.current;
    setReadiness({ phase: "loading" });
    try {
      const value = await getVideoToolStatus();
      if (request === readinessRequest.current) {
        setReadiness({ phase: "loaded", value });
      }
    } catch {
      if (request === readinessRequest.current) {
        setReadiness({ phase: "error" });
      }
    }
  }, []);

  useEffect(() => {
    void checkReadiness();
    return () => {
      readinessRequest.current += 1;
    };
  }, [checkReadiness]);

  const toolsReady = readiness.phase === "loaded" && readiness.value.ready;
  const preparationPending = preparation.phase === "pending";
  const renderActive = render.phase === "starting" || render.phase === "running";
  const sourceOperationPending = sourcePending || preparationPending;

  const chooseSource = async () => {
    if (!toolsReady || sourceOperationPending || renderActive) {
      return;
    }
    setSourceError(null);
    setSourcePending(true);
    try {
      const path = await pickVideoSource();
      if (path !== null) {
        const probe = await probeVideoSource(path);
        setSourceProbe(probe);
        await prepareImportedSource(path, probe);
      }
    } catch (error) {
      setSourceError(error instanceof Error ? error : new Error());
    } finally {
      setSourcePending(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#workspace" aria-label="Supa Video Producer home">
          <span className="brand-mark" aria-hidden>
            <Film size={18} strokeWidth={2} />
          </span>
          <span>Supa Video Producer</span>
        </a>
        <span className="phase-label">Phase 1</span>
      </header>

      <main className="workspace" id="workspace">
        <div className="workspace-intro">
          <p className="eyebrow">New project</p>
          <h1>Start with one source video</h1>
          <p>Check the local media tools, prepare one clip, then export a finished MP4.</p>
        </div>

        <section className="readiness-panel" aria-labelledby="readiness-title" aria-live="polite">
          {readiness.phase === "loading" ? (
            <div className="state-heading">
              <span className="spinner" aria-hidden />
              <div>
                <p className="state-kicker">Media tools</p>
                <h2 id="readiness-title">Checking FFmpeg and FFprobe</h2>
                <p>This usually takes a few seconds.</p>
              </div>
            </div>
          ) : null}

          {readiness.phase === "error" ? (
            <>
              <div className="state-heading">
                <AlertCircle className="state-icon is-error" size={24} aria-hidden />
                <div>
                  <p className="state-kicker">Media tools</p>
                  <h2 id="readiness-title">Could not check the media tools</h2>
                  <p>Restart the app or check again before choosing a source.</p>
                </div>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void checkReadiness()}
              >
                <RefreshCw size={16} aria-hidden />
                Check again
              </button>
            </>
          ) : null}

          {readiness.phase === "loaded" ? (
            <>
              <div className="state-heading">
                {readiness.value.ready ? (
                  <CheckCircle2 className="state-icon is-ready" size={24} aria-hidden />
                ) : (
                  <AlertCircle className="state-icon is-error" size={24} aria-hidden />
                )}
                <div>
                  <p className="state-kicker">Media tools</p>
                  <h2 id="readiness-title">
                    {readiness.value.ready ? "Ready for video work" : "FFmpeg setup required"}
                  </h2>
                  <p>
                    {readiness.value.ready
                      ? "Both local tools are available."
                      : "Install or repair the tools marked below before continuing."}
                  </p>
                </div>
              </div>
              <ul className="tool-list" aria-label="Media tool readiness">
                <ToolRow label="FFmpeg" tool={readiness.value.ffmpeg} />
                <ToolRow label="FFprobe" tool={readiness.value.ffprobe} />
              </ul>
              {!readiness.value.ready ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void checkReadiness()}
                >
                  <RefreshCw size={16} aria-hidden />
                  Check again
                </button>
              ) : null}
            </>
          ) : null}
        </section>

        <section
          className="source-panel"
          aria-labelledby="source-title"
          aria-busy={sourceOperationPending}
          aria-live="polite"
        >
          <div className="section-heading">
            <div>
              <p className="state-kicker">Project source</p>
              <h2 id="source-title">Source video</h2>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!toolsReady || sourceOperationPending || renderActive}
              onClick={() => void chooseSource()}
              aria-describedby={!toolsReady ? "source-prerequisite" : undefined}
            >
              {sourceOperationPending ? (
                <span className="button-spinner" aria-hidden />
              ) : (
                <FolderOpen size={17} aria-hidden />
              )}
              {preparationPending
                ? "Preparing preview"
                : sourcePending
                  ? "Inspecting video"
                  : sourceProbe === null
                    ? "Choose video"
                    : "Choose another"}
            </button>
          </div>

          {!toolsReady ? (
            <p className="source-prerequisite" id="source-prerequisite">
              Source selection unlocks when FFmpeg and FFprobe are ready.
            </p>
          ) : null}

          {sourceError !== null ? (
            <div className="inline-error" role="alert">
              <AlertCircle size={18} aria-hidden />
              <div>
                <strong>Could not open that video</strong>
                <p>{sourceErrorMessage(sourceError)}</p>
              </div>
            </div>
          ) : null}

          {sourceProbe === null ? (
            <div className="empty-source">
              <Film size={28} strokeWidth={1.5} aria-hidden />
              <h3>No source selected</h3>
              <p>Choose a local MP4, MOV, MKV, WebM, AVI, M4V, MPEG, or MPG file.</p>
            </div>
          ) : (
            <SourceSummary probe={sourceProbe} />
          )}

          {preparation.phase === "pending" ? (
            <div className="preparation-status" role="status">
              <span className="spinner" aria-hidden />
              <div>
                <strong>Preparing preview</strong>
                <p>Creating a controlled proxy and thumbnail in the app cache.</p>
              </div>
            </div>
          ) : null}

          {preparation.phase === "success" ? (
            <div className="preparation-status is-success" role="status">
              <CheckCircle2 size={20} aria-hidden />
              <div>
                <strong>Preview prepared</strong>
                <p>The proxy and thumbnail are validated and ready for the editor.</p>
              </div>
            </div>
          ) : null}

          {preparation.phase === "error" ? (
            <div className="inline-error" role="alert">
              <AlertCircle size={18} aria-hidden />
              <div>
                <strong>Could not prepare the preview</strong>
                <p>{preparationErrorMessage(preparation.error)}</p>
              </div>
            </div>
          ) : null}
        </section>

        {toolsReady && renderReady ? (
          <section
            className="export-panel"
            aria-labelledby="export-title"
            aria-busy={destinationPending || renderActive}
          >
            <div className="section-heading">
              <div>
                <p className="state-kicker">Finished video</p>
                <h2 id="export-title">Export video</h2>
              </div>
              {render.phase === "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={render.cancellationPending}
                  onClick={() => void cancelRender()}
                >
                  {render.cancellationPending ? "Cancelling export" : "Cancel export"}
                </button>
              ) : render.phase === "starting" ? null : (
                <button
                  className="primary-button"
                  type="button"
                  disabled={destinationPending}
                  onClick={() => void exportVideo()}
                >
                  {destinationPending ? (
                    <span className="button-spinner" aria-hidden />
                  ) : (
                    <Download size={17} aria-hidden />
                  )}
                  {destinationPending
                    ? "Choosing destination"
                    : render.phase === "failed" && render.canOverwrite
                      ? "Choose another destination"
                      : render.phase === "completed" || render.phase === "completed_with_warning"
                        ? "Export another"
                        : "Export MP4"}
                </button>
              )}
            </div>

            {render.phase === "idle" ? (
              <div className="export-guidance">
                <p>Choose a destination to export the prepared clip as an MP4 video.</p>
              </div>
            ) : null}

            {render.phase === "starting" ? (
              <div className="render-status" role="status">
                <span className="spinner" aria-hidden />
                <div>
                  <strong>Starting export</strong>
                  <p>Validating the project and preparing FFmpeg.</p>
                </div>
              </div>
            ) : null}

            {render.phase === "running" ? (
              <div className="render-progress" role="status">
                <div className="progress-heading">
                  <div>
                    <strong>
                      {render.cancellationPending ? "Cancelling export" : "Exporting video"}
                    </strong>
                    <p>Keep the app open until the finished video is verified.</p>
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
                  <p>{renderErrorMessage(render.cancellationError)}</p>
                </div>
              </div>
            ) : null}

            {render.phase === "completed" ? (
              <div className="render-status is-success" role="status">
                <CheckCircle2 size={20} aria-hidden />
                <div>
                  <strong>Export complete</strong>
                  <p className="output-destination">
                    Saved to <span>{render.output.outputPath}</span>
                  </p>
                </div>
              </div>
            ) : null}

            {render.phase === "completed_with_warning" ? (
              <div className="render-status" role="status">
                <AlertCircle size={20} aria-hidden />
                <div>
                  <strong>Export saved, preview unavailable</strong>
                  <p>The final MP4 was saved, but its editor preview could not be prepared.</p>
                  <p className="output-destination">
                    Saved to <span>{render.outputPath}</span>
                  </p>
                </div>
              </div>
            ) : null}

            {render.phase === "cancelled" ? (
              <div className="render-status" role="status">
                <AlertCircle size={20} aria-hidden />
                <div>
                  <strong>Export cancelled</strong>
                  <p>No finished video was written. You can start the export again.</p>
                </div>
              </div>
            ) : null}

            {render.phase === "failed" && render.canOverwrite ? (
              <div
                className="overwrite-confirmation"
                role="alert"
                aria-labelledby="overwrite-title"
              >
                <AlertCircle size={20} aria-hidden />
                <div>
                  <strong id="overwrite-title">Replace the existing file?</strong>
                  <p>
                    A file already exists at the selected destination. Replacing it cannot be
                    undone.
                  </p>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => void confirmOverwrite()}
                  >
                    Replace existing file
                  </button>
                </div>
              </div>
            ) : null}

            {render.phase === "failed" && !render.canOverwrite ? (
              <div className="inline-error" role="alert">
                <AlertCircle size={18} aria-hidden />
                <div>
                  <strong>Could not export the video</strong>
                  <p>{renderErrorMessage(render.error)}</p>
                </div>
              </div>
            ) : null}

            {destinationError !== null ? (
              <div className="inline-error" role="alert">
                <AlertCircle size={18} aria-hidden />
                <div>
                  <strong>Could not choose that destination</strong>
                  <p>{renderErrorMessage(destinationError)}</p>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
