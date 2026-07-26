import type { VideoProjectFileV1 } from "@supa-video/contracts";
import { currentRevision } from "@supa-video/project";
import { AlertCircle, FilePlus2, FolderOpen, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { type useVideoProject } from "../use-video-project";
import { AssetPanel } from "./AssetPanel";
import { ExportPanel } from "./ExportPanel";
import { formatProjectName } from "./format-video";
import { ProgramMonitor } from "./ProgramMonitor";
import { SingleClipTimeline } from "./SingleClipTimeline";
import { TrimInspector } from "./TrimInspector";

interface VideoWorkspaceProps {
  readonly controller: ReturnType<typeof useVideoProject>;
  readonly project: Readonly<VideoProjectFileV1>;
  readonly toolsReady: boolean;
  readonly onNewProject: () => void;
  readonly onOpenProject: () => void;
}

function editableOwnsShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "VIDEO", "A"].includes(target.tagName)
  );
}

export function VideoWorkspace({
  controller,
  project,
  toolsReady,
  onNewProject,
  onOpenProject,
}: VideoWorkspaceProps) {
  const [playhead, setPlayhead] = useState(0);
  const revision = currentRevision(project);
  const asset = revision.state.asset;
  const sourceHasAudio = asset !== null && asset.probe.audio !== null;
  const sequence = revision.state.sequence;
  const clip = sequence?.videoTracks[0]?.clips[0];
  const draft = controller.trimDraft;
  const durationFrames = controller.sourceFrameCount ?? 1;
  const editPending = controller.editOperation.phase === "saving";
  const projectPending = controller.projectOperation.phase === "pending";
  const finalPreviewPath =
    controller.render.phase === "completed" ? controller.render.output.previewPath : null;
  const projectName = formatProjectName(controller.projectPath, project.name);

  useEffect(() => {
    if (draft !== null && (playhead < draft.inFrame || playhead >= draft.outFrame)) {
      setPlayhead(draft.inFrame);
    }
  }, [draft, playhead]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (
        editableOwnsShortcut(event.target) ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey
      ) {
        return;
      }
      if (event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) void controller.redoEdit();
      else void controller.undoEdit();
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [controller]);

  const sourceStatus = useMemo(() => {
    if (controller.source === null) return "No source";
    if (controller.source.status === "resolved") return "Source ready";
    if (controller.source.status === "missing") return "Source missing";
    return "Relink required";
  }, [controller.source]);

  return (
    <main className="video-workspace shared-rail" id="workspace">
      <header className="project-bar">
        <div className="project-identity">
          <p className="state-kicker">Active project</p>
          <h1>{projectName}</h1>
          <p className="project-status">
            <span>{sourceStatus}</span>
            <span aria-hidden>•</span>
            <span>{revision.id.slice(0, 8)} revision</span>
          </p>
        </div>
        <div className="project-actions">
          <span className="save-state" role="status">
            <Save size={15} aria-hidden />
            {editPending || projectPending
              ? "Saving"
              : controller.trimChanged
                ? "Unsaved trim"
                : "Saved"}
          </span>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={projectPending || editPending}
            onClick={onNewProject}
          >
            <FilePlus2 size={16} aria-hidden />
            New
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={projectPending || editPending}
            onClick={onOpenProject}
          >
            <FolderOpen size={16} aria-hidden />
            Open
          </button>
        </div>
      </header>

      {controller.projectOperation.phase === "error" ? (
        <div className="workspace-alert inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Project operation did not finish</strong>
            <p>The saved project and current revision were preserved.</p>
          </div>
        </div>
      ) : null}

      <div className="workbench-grid">
        <div className="monitor-column">
          {sequence !== null && clip !== undefined && draft !== null ? (
            <ProgramMonitor
              proxyPath={controller.preparedAsset?.proxyPath ?? null}
              finalPreviewPath={finalPreviewPath}
              hasAudio={sourceHasAudio}
              convertCachePath={controller.convertCachePath}
              rate={sequence.rate}
              trimIn={draft.inFrame}
              trimOut={draft.outFrame}
              playhead={playhead}
              onPlayheadChange={setPlayhead}
            />
          ) : (
            <section className="panel monitor-panel" aria-labelledby="monitor-empty-title">
              <div className="panel-heading">
                <div>
                  <p className="state-kicker">Program monitor</p>
                  <h2 id="monitor-empty-title">Waiting for a source</h2>
                </div>
              </div>
              <div className="monitor-stage">
                <div className="monitor-fallback">
                  <strong>No prepared proxy</strong>
                  <p>Choose one source video to build the editing workspace.</p>
                </div>
              </div>
            </section>
          )}
          {sequence !== null && clip !== undefined && draft !== null ? (
            <SingleClipTimeline
              thumbnailPath={controller.preparedAsset?.thumbnailPath ?? null}
              convertCachePath={controller.convertCachePath}
              durationFrames={durationFrames}
              trimIn={draft.inFrame}
              trimOut={draft.outFrame}
              playhead={playhead}
              disabled={editPending}
              onTrimInChange={(inFrame) => controller.updateTrimDraft({ inFrame })}
              onTrimOutChange={(outFrame) => controller.updateTrimDraft({ outFrame })}
              onSeek={setPlayhead}
            />
          ) : null}
        </div>

        <aside className="inspector-column" aria-label="Project controls">
          <AssetPanel
            probe={asset?.probe ?? null}
            source={controller.source}
            preparation={controller.preparation}
            projectOperation={controller.projectOperation}
            toolsReady={toolsReady}
            onChooseSource={() => void controller.chooseSource()}
            onRetryPreparation={() => void controller.retryPreparation()}
            onRegrantSourceAccess={() => void controller.regrantSourceAccess()}
            onReopenProject={onOpenProject}
          />
          {draft !== null ? (
            <TrimInspector
              inFrame={draft.inFrame}
              outFrame={draft.outFrame}
              durationFrames={durationFrames}
              valid={controller.trimValid}
              changed={controller.trimChanged}
              canUndo={controller.canUndo}
              canRedo={controller.canRedo}
              operation={controller.editOperation}
              onInFrameChange={(inFrame) => controller.updateTrimDraft({ inFrame })}
              onOutFrameChange={(outFrame) => controller.updateTrimDraft({ outFrame })}
              onApply={() => void controller.applyTrim()}
              onUndo={() => void controller.undoEdit()}
              onRedo={() => void controller.redoEdit()}
            />
          ) : null}
          <ExportPanel
            render={controller.render}
            destinationPending={controller.destinationPending}
            destinationError={controller.destinationError}
            disabled={
              !toolsReady || !controller.renderReady || controller.trimChanged || editPending
            }
            onExport={() => void controller.exportVideo()}
            onCancel={() => void controller.cancelRender()}
            onConfirmOverwrite={() => void controller.confirmOverwrite()}
          />
        </aside>
      </div>
    </main>
  );
}
