import type { VideoToolInfo, VideoToolProblem, VideoToolStatus } from "@supa-video/contracts";
import { AlertCircle, CheckCircle2, FilePlus2, FolderOpen, RefreshCw } from "lucide-react";

export type ReadinessState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "loaded"; readonly value: VideoToolStatus };

interface VideoProjectOpenerProps {
  readonly readiness: ReadinessState;
  readonly projectPending: boolean;
  readonly projectError: Error | null;
  readonly onCheckTools: () => void;
  readonly onNewProject: () => void;
  readonly onOpenProject: () => void;
}

type VideoToolName = "FFmpeg" | "FFprobe";

const videoToolProblemLabels: Record<VideoToolProblem, (toolName: VideoToolName) => string> = {
  not_found: (toolName) => `${toolName} was not found. Install ${toolName}, then check again.`,
  timed_out: (toolName) => `${toolName} check timed out. Check again.`,
  failed: (toolName) => `${toolName} could not run. Repair or reinstall it, then check again.`,
  invalid_version: (toolName) =>
    `${toolName} was not recognized. Replace it with a compatible ${toolName} binary, then check again.`,
};

export function getVideoToolProblemLabel(
  toolName: VideoToolName,
  problem: VideoToolProblem,
): string {
  return videoToolProblemLabels[problem](toolName);
}

function VideoToolResult({
  name,
  tool,
}: {
  readonly name: VideoToolName;
  readonly tool: VideoToolInfo;
}) {
  let detail = "Unavailable. Check the installation, then check again.";
  if (tool.available && tool.version !== undefined) {
    detail = tool.version;
  } else if (tool.problem !== undefined) {
    detail = getVideoToolProblemLabel(name, tool.problem);
  }

  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span>{tool.available ? "Available" : "Unavailable"}</span>
        <span className="tool-detail">{detail}</span>
      </dd>
    </div>
  );
}
export function VideoProjectOpener({
  readiness,
  projectPending,
  projectError,
  onCheckTools,
  onNewProject,
  onOpenProject,
}: VideoProjectOpenerProps) {
  const toolsReady = readiness.phase === "loaded" && readiness.value.ready;
  return (
    <main className="opener shared-rail" id="workspace">
      <section className="opener-intro" aria-labelledby="opener-title">
        <p className="state-kicker">Single-clip workspace</p>
        <h1 id="opener-title">Shorten one local video and export a verified MP4.</h1>
        <p>
          Projects save every committed trim. Preview media stays inside the controlled app cache.
        </p>
      </section>

      <section className="opener-panel" aria-labelledby="project-start-title">
        <div className="section-heading">
          <div>
            <p className="state-kicker">Project</p>
            <h2 id="project-start-title">Start or continue</h2>
          </div>
        </div>
        <div className="opener-actions">
          <button
            className="primary-button"
            type="button"
            disabled={projectPending}
            onClick={onNewProject}
          >
            {projectPending ? (
              <span className="button-spinner" aria-hidden />
            ) : (
              <FilePlus2 size={17} aria-hidden />
            )}
            New project
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={projectPending}
            onClick={onOpenProject}
          >
            <FolderOpen size={17} aria-hidden />
            Open project
          </button>
        </div>
        {projectError !== null ? (
          <div className="inline-error" role="alert">
            <AlertCircle size={18} aria-hidden />
            <div>
              <strong>Could not finish the project operation</strong>
              <p>
                Your current project was not changed. Check the selected location and try again.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="tool-panel" aria-labelledby="tool-title" aria-live="polite">
        {readiness.phase === "loading" ? (
          <div className="state-heading">
            <span className="spinner" aria-hidden />
            <div>
              <p className="state-kicker">Media tools</p>
              <h2 id="tool-title">Checking FFmpeg and FFprobe</h2>
              <p>Project files remain available while the local tools are checked.</p>
            </div>
          </div>
        ) : null}
        {readiness.phase === "error" ? (
          <>
            <div className="state-heading">
              <AlertCircle className="state-icon is-error" size={22} aria-hidden />
              <div>
                <p className="state-kicker">Media tools</p>
                <h2 id="tool-title">Could not check the media tools</h2>
                <p>Check again before preparing or exporting video.</p>
              </div>
            </div>
            <button className="secondary-button" type="button" onClick={onCheckTools}>
              <RefreshCw size={16} aria-hidden />
              Check again
            </button>
          </>
        ) : null}
        {readiness.phase === "loaded" ? (
          <>
            <div className="state-heading">
              {toolsReady ? (
                <CheckCircle2 className="state-icon is-ready" size={22} aria-hidden />
              ) : (
                <AlertCircle className="state-icon is-error" size={22} aria-hidden />
              )}
              <div>
                <p className="state-kicker">Media tools</p>
                <h2 id="tool-title">
                  {toolsReady ? "Ready for video work" : "FFmpeg setup required"}
                </h2>
                <p>
                  {toolsReady
                    ? "FFmpeg and FFprobe are available."
                    : "Projects can open, but preview preparation and export stay unavailable."}
                </p>
              </div>
            </div>
            <dl className="tool-results">
              <VideoToolResult name="FFmpeg" tool={readiness.value.ffmpeg} />
              <VideoToolResult name="FFprobe" tool={readiness.value.ffprobe} />
            </dl>
            {!toolsReady ? (
              <button className="secondary-button" type="button" onClick={onCheckTools}>
                <RefreshCw size={16} aria-hidden />
                Check again
              </button>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
