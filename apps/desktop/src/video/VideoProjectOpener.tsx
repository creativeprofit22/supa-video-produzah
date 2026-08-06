import type { VideoToolInfo, VideoToolProblem, VideoToolStatus } from "@supa-video/contracts";
import { AlertCircle, CheckCircle2, FilePlus2, FolderOpen, RefreshCw } from "lucide-react";

import { useCommand } from "../commands/CommandProvider";
export type ReadinessState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "loaded"; readonly value: VideoToolStatus };

interface VideoProjectOpenerProps {
  readonly readiness: ReadinessState;
  readonly projectPending: boolean;
  readonly projectError: Error | null;
  readonly onCheckTools: () => void;
}

type VideoToolName = "FFmpeg" | "FFprobe";

const videoToolProblemLabels: Record<VideoToolProblem, (toolName: VideoToolName) => string> = {
  not_found: (toolName) =>
    `${toolName} is missing from the application. Repair or reinstall the application, then check again.`,
  timed_out: (toolName) => `${toolName} verification timed out. Check again.`,
  failed: (toolName) =>
    `${toolName} could not be verified. Repair or reinstall the application, then check again.`,
  invalid_version: (toolName) =>
    `${toolName} was not recognized. Repair or reinstall the application, then check again.`,
  integrity_failed: (toolName) =>
    `${toolName} is damaged. Repair or reinstall the application, then check again.`,
  incompatible_build: (toolName) =>
    `${toolName} is incompatible with this application. Repair or reinstall the application, then check again.`,
};

function unavailableToolHeading(status: VideoToolStatus): string {
  const unavailableTools = [
    ["FFmpeg", status.ffmpeg] as const,
    ["FFprobe", status.ffprobe] as const,
  ].filter(([, tool]) => !tool.available);
  if (unavailableTools.length === 1) {
    const [toolName, tool] = unavailableTools[0]!;
    if (tool.problem === "integrity_failed") return `${toolName} is damaged`;
    if (tool.problem === "incompatible_build" || tool.problem === "invalid_version")
      return `${toolName} is incompatible`;
    if (tool.problem === "not_found") return `${toolName} is missing`;
    if (tool.problem === "timed_out") return `${toolName} check timed out`;
    return `Could not verify ${toolName}`;
  }

  const problems = [status.ffmpeg.problem, status.ffprobe.problem];
  if (problems.includes("integrity_failed")) return "Bundled media tools are damaged";
  if (problems.includes("incompatible_build") || problems.includes("invalid_version"))
    return "Bundled media tools are incompatible";
  if (problems.includes("not_found")) return "Bundled media tools are missing";
  if (problems.includes("timed_out")) return "Media tool check timed out";
  return "Could not verify bundled media tools";
}

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
}: VideoProjectOpenerProps) {
  const newProjectCommand = useCommand("project.new");
  const openProjectCommand = useCommand("project.open");
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
            disabled={!newProjectCommand.canExecute}
            aria-keyshortcuts={newProjectCommand.ariaKeyShortcuts}
            onClick={newProjectCommand.execute}
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
            disabled={!openProjectCommand.canExecute}
            aria-keyshortcuts={openProjectCommand.ariaKeyShortcuts}
            onClick={openProjectCommand.execute}
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
              <h2 id="tool-title">Checking bundled media tools</h2>
              <p>Project files remain available while FFmpeg and FFprobe are verified.</p>
            </div>
          </div>
        ) : null}
        {readiness.phase === "error" ? (
          <>
            <div className="state-heading">
              <AlertCircle className="state-icon is-error" size={22} aria-hidden />
              <div>
                <p className="state-kicker">Media tools</p>
                <h2 id="tool-title">Could not check the bundled media tools</h2>
                <p>Check again. If this continues, repair or reinstall the application.</p>
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
                  {toolsReady ? "Ready for video work" : unavailableToolHeading(readiness.value)}
                </h2>
                <p>
                  {toolsReady
                    ? "The packaged FFmpeg and FFprobe build passed integrity and capability checks."
                    : "Projects can still open. Repair or reinstall the application to restore preview preparation and export."}
                </p>
              </div>
            </div>
            <dl className="tool-results">
              <VideoToolResult name="FFmpeg" tool={readiness.value.ffmpeg} />
              <VideoToolResult name="FFprobe" tool={readiness.value.ffprobe} />
            </dl>
            {toolsReady ? (
              <p className="toolchain-identity">
                <span>Bundled toolchain</span>
                <code>{readiness.value.toolchainId}</code>
              </p>
            ) : null}
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
