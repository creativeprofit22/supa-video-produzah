import type { VideoProjectFileV1 } from "@supa-video/contracts";
import type { MediaJobRecord } from "@supa-video/media";
import { AlertCircle, AlertTriangle, FilePlus2, FolderOpen, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type useVideoProject } from "../use-video-project";
import { AssetPanel } from "./AssetPanel";
import { ClipTrimRanges } from "./ClipTrimRanges";
import { ExportPanel } from "./ExportPanel";
import { formatProjectName } from "./format-video";
import { MultitrackTimeline } from "./MultitrackTimeline";
import { ProgramMonitor } from "./ProgramMonitor";
import { ProjectInspector } from "./ProjectInspector";
import { TrimInspector } from "./TrimInspector";
import type { ReadinessState } from "./VideoProjectOpener";

interface VideoWorkspaceProps {
  readonly controller: ReturnType<typeof useVideoProject>;
  readonly mediaJobs: readonly MediaJobRecord[];
  readonly project: Readonly<VideoProjectFileV1>;
  readonly readiness: ReadinessState;
  readonly onCheckTools: () => void;
  readonly onOpenJobCenter: (jobId: string) => void;
  readonly onNewProject: () => void;
  readonly onOpenProject: () => void;
}

export function findAssetPreparationJob(
  jobs: readonly MediaJobRecord[],
  projectId: string | undefined,
  assetId: string | undefined,
): MediaJobRecord | null {
  if (projectId === undefined || assetId === undefined) return null;
  return (
    jobs
      .filter(
        (job) =>
          job.parentId === null &&
          job.kind === "asset_preparation" &&
          job.projectId === projectId &&
          job.assetId === assetId,
      )
      .sort((left, right) => {
        const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return created === 0 ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt) : created;
      })[0] ?? null
  );
}

function editableOwnsShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "VIDEO", "A"].includes(target.tagName)
  );
}

function selectableClipIds(
  sequence:
    | NonNullable<ReturnType<typeof useVideoProject>["projection"]>["state"]["sequences"][number]
    | undefined,
): readonly string[] {
  if (sequence === undefined) return [];
  return sequence.tracks.flatMap((track) =>
    track.kind === "caption" ? [] : track.clips.map((clip) => clip.id),
  );
}

export function VideoWorkspace({
  controller,
  mediaJobs,
  project,
  readiness,
  onCheckTools,
  onOpenJobCenter,
  onNewProject,
  onOpenProject,
}: VideoWorkspaceProps) {
  const [playhead, setPlayhead] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);
  const reconciledPreparationJobs = useRef(new Set<string>());
  const revision = project.revisions[0]!;
  const asset = revision.state.asset;
  const sourceHasAudio = asset !== null && asset.probe.audio !== null;
  const sequence = revision.state.sequence;
  const clip = sequence?.videoTracks[0]?.clips[0];
  const canonicalSequence = controller.projection?.state.sequences.find(
    (candidate) => candidate.id === controller.projection?.state.activeSequenceId,
  );
  const draft = controller.trimDraft;
  const durationFrames = controller.sourceFrameCount ?? 1;
  const editPending = controller.editOperation.phase === "saving";
  const projectPending = controller.projectOperation.phase === "pending";
  const preparationJob = useMemo(
    () =>
      findAssetPreparationJob(
        mediaJobs,
        controller.projection?.projectId,
        asset?.id ?? controller.source?.assetId,
      ),
    [asset?.id, controller.projection?.projectId, controller.source?.assetId, mediaJobs],
  );
  const renderJobId = "jobId" in controller.render ? controller.render.jobId : null;
  const currentRevisionId = controller.projection?.revision.id ?? null;
  const renderJob = useMemo(() => {
    if (renderJobId !== null)
      return mediaJobs.find((job) => job.id === renderJobId && job.parentId === null) ?? null;
    if (currentRevisionId === null) return null;
    return (
      mediaJobs
        .filter(
          (job) =>
            job.parentId === null &&
            job.kind === "final_render" &&
            job.revisionId === currentRevisionId,
        )
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null
    );
  }, [currentRevisionId, mediaJobs, renderJobId]);
  const finalPreviewPath =
    controller.render.phase === "completed" &&
    (renderJob === null || renderJob.state === "complete")
      ? controller.render.output.previewPath
      : null;
  const projectName = formatProjectName(controller.projectPath, project.name);

  useEffect(() => {
    if (draft !== null && (playhead < draft.inFrame || playhead >= draft.outFrame)) {
      setPlayhead(draft.inFrame);
    }
  }, [draft, playhead]);

  useEffect(() => {
    const clipIds = selectableClipIds(canonicalSequence);
    setSelectedClipId((current) =>
      current !== null && clipIds.includes(current) ? current : (clipIds[0] ?? null),
    );
  }, [canonicalSequence]);

  useEffect(() => {
    if (preparationJob?.state !== "complete" || controller.preparation.phase === "success") return;
    const reconciliationKey = `${preparationJob.id}:${preparationJob.updatedAt}`;
    if (reconciledPreparationJobs.current.has(reconciliationKey)) return;
    reconciledPreparationJobs.current.add(reconciliationKey);
    void controller.retryPreparation();
  }, [controller.preparation.phase, controller.retryPreparation, preparationJob]);

  const handleWorkspaceShortcut = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "target" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "preventDefault"
      >,
    ) => {
      if (editableOwnsShortcut(event.target) || (!event.ctrlKey && !event.metaKey)) return;
      if (event.altKey && event.code === "KeyD") {
        event.preventDefault();
        inspectorReturnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setInspectorOpen((open) => !open);
        return;
      }
      if (event.altKey || event.code !== "KeyZ") return;
      event.preventDefault();
      if (event.shiftKey) void controller.redoEdit();
      else void controller.undoEdit();
    },
    [controller],
  );

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleWorkspaceShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [handleWorkspaceShortcut]);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    queueMicrotask(() => inspectorReturnFocus.current?.focus());
  }, []);

  const sourceStatus = useMemo(() => {
    if (controller.source === null) return "No source";
    if (controller.source.status === "resolved") return "Source ready";
    if (controller.source.status === "missing") return "Source missing";
    return "Relink required";
  }, [controller.source]);

  return (
    <main className="video-workspace shared-rail" id="workspace" tabIndex={-1}>
      <header className="project-bar">
        <div className="project-identity">
          <p className="state-kicker">Active project</p>
          <h1>{projectName}</h1>
          <p className="project-status">
            <span>{sourceStatus}</span>
            <span aria-hidden>•</span>
            <span>Revision {controller.projection?.revision.number ?? 0}</span>
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

      {readiness.phase !== "loaded" || !readiness.value.ready ? (
        <div
          className={`workspace-alert workspace-tool-status ${readiness.phase === "loading" ? "neutral-status" : "inline-error"}`}
          role={readiness.phase === "loading" ? "status" : "alert"}
          aria-live={readiness.phase === "loading" ? "polite" : undefined}
        >
          {readiness.phase === "loading" ? (
            <span className="spinner" aria-hidden />
          ) : (
            <AlertCircle size={18} aria-hidden />
          )}
          <div>
            <strong>
              {readiness.phase === "loading"
                ? "Checking media tools"
                : readiness.phase === "error"
                  ? "Could not check media tools"
                  : "Media tools unavailable"}
            </strong>
            <p>
              {readiness.phase === "loading"
                ? "Preview preparation and export are paused. Project actions remain available."
                : "Repair or reinstall the application, then check again. Project actions remain available."}
            </p>
          </div>
          {readiness.phase !== "loading" ? (
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={onCheckTools}
            >
              <RefreshCw size={16} aria-hidden />
              Check again
            </button>
          ) : null}
        </div>
      ) : null}

      <button
        className="sr-only"
        type="button"
        aria-keyshortcuts="Control+Alt+D Meta+Alt+D"
        onClick={(event) => {
          inspectorReturnFocus.current = event.currentTarget;
          setInspectorOpen((open) => !open);
        }}
      >
        Toggle project inspector
      </button>

      {inspectorOpen && controller.projection !== null ? (
        <ProjectInspector
          projection={controller.projection}
          recovery={controller.recovery}
          onClose={closeInspector}
        />
      ) : null}

      {controller.checkpointWarning !== null ? (
        <div className="workspace-alert inline-warning" role="status">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>
              Revision {controller.checkpointWarning.revision} is saved. Checkpoint pending.
            </strong>
            <p>
              Your edit is durable in the project journal, but snapshot checkpointing is pending. A
              later healthy checkpoint or clean reopen will clear this warning.
            </p>
          </div>
        </div>
      ) : null}

      {controller.recovery?.legacyHistoryReset ? (
        <div className="workspace-alert inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Legacy undo history was permanently reset</strong>
            <p>
              This cannot be undone. Your current project content was migrated to the Phase 2
              format.
            </p>
          </div>
        </div>
      ) : null}

      {controller.projection?.recoveryStatus === "degraded" ? (
        <div className="workspace-alert inline-error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <div>
            <strong>Project recovered with possible lost edits</strong>
            <p>
              Recovery stopped at revision {controller.projection.revision.number}, the last
              verified journal record.
            </p>
          </div>
        </div>
      ) : null}

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
          {controller.projection !== null && canonicalSequence !== undefined ? (
            <MultitrackTimeline
              projection={controller.projection}
              preparedAsset={controller.preparedAsset}
              convertCachePath={controller.convertCachePath}
              selectedClipId={selectedClipId}
              playheadFrame={playhead}
              editPending={editPending}
              editError={
                controller.editOperation.phase === "error" ? controller.editOperation.error : null
              }
              onSelectClip={setSelectedClipId}
              onSplitClip={(clipId, sourceFrame) =>
                void controller.splitTimelineClip({ clipId, sourceFrame })
              }
              onMoveClip={(clipId, timelineStartFrame) =>
                void controller.moveTimelineClip({ clipId, timelineStartFrame })
              }
              onTrimClip={(clipId, sourceInFrame, sourceOutFrame, timelineStartFrame) =>
                void controller.trimTimelineClip({
                  clipId,
                  sourceInFrame,
                  sourceOutFrame,
                  timelineStartFrame,
                })
              }
            />
          ) : null}
          {sequence !== null && clip !== undefined && draft !== null ? (
            <ClipTrimRanges
              durationFrames={durationFrames}
              trimIn={draft.inFrame}
              trimOut={draft.outFrame}
              disabled={editPending}
              onTrimInChange={(inFrame) => controller.updateTrimDraft({ inFrame })}
              onTrimOutChange={(outFrame) => controller.updateTrimDraft({ outFrame })}
            />
          ) : null}
        </div>

        <aside className="inspector-column" aria-label="Project controls">
          <AssetPanel
            probe={asset?.probe ?? null}
            source={controller.source}
            preparation={controller.preparation}
            preparationJob={preparationJob}
            projectOperation={controller.projectOperation}
            readiness={readiness}
            onChooseSource={() => void controller.chooseSource()}
            onOpenJobCenter={onOpenJobCenter}
            onRetryPreparation={() => void controller.retryPreparation()}
            onRelinkSource={() => void controller.regrantSourceAccess()}
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
            renderJob={renderJob}
            readiness={readiness}
            destinationPending={controller.destinationPending}
            destinationError={controller.destinationError}
            disabled={!controller.renderReady || controller.trimChanged || editPending}
            onExport={() => void controller.exportVideo()}
            onCancel={() => void controller.cancelRender()}
            onConfirmOverwrite={() => void controller.confirmOverwrite()}
            onOpenJobCenter={onOpenJobCenter}
          />
        </aside>
      </div>
    </main>
  );
}
