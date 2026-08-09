import {
  canToggleTrackVisibility,
  clipTransformSchema,
  createRationalTime,
  isTrackHidden,
  isTrackLocked,
  isTrackMuted,
  microsecondsToSourceFrames,
  VideoDomainError,
  type ClipTransform,
  type CommandResult,
  type ProjectCommandV2,
  type ProjectProjection,
  type RecoveryReport,
  type RenderPlan,
  type VerifiedRenderOutput,
  type VideoProjectFileV1,
  type VideoSourceRecord,
  videoProjectFileV1Schema,
} from "@supa-video/contracts";
import type {
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  TranscriptArtifactV1,
} from "@supa-video/media";
import {
  assertTranscriptEditProposalCurrent,
  buildCommandGroup,
  buildProjectCommand,
  prepareSplitClipCaptionLifecycleV1,
  prepareTrimClipCaptionLifecycleV1,
  type TranscriptEditProposal,
} from "@supa-video/project";
import {
  compileActiveSequenceRenderPlan,
  getActiveSequenceRenderEligibility,
} from "@supa-video/render";
import { useCallback, useEffect, useRef, useState } from "react";

import { tauriVideoBackend, type VideoBackend, type VideoRenderNotification } from "./video-ipc";

export type PreparationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending" }
  | { readonly phase: "error"; readonly error: Error }
  | { readonly phase: "success"; readonly value: PreparedVideoAsset };
export type ProjectOperation = "new" | "open" | "import" | "regrant";
export type ProjectOperationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly operation: ProjectOperation }
  | { readonly phase: "error"; readonly operation: ProjectOperation; readonly error: Error };
export interface TrimDraft {
  readonly inFrame: number;
  readonly outFrame: number;
}
export type TimelineEditOperation =
  | "split"
  | "move"
  | "trim"
  | "ripple-delete"
  | "transcript-edit"
  | "clip-opacity"
  | "clip-transform"
  | "track-lock"
  | "track-mute"
  | "track-visibility";
export interface SplitTimelineClipInput {
  readonly clipId: string;
  readonly sourceFrame: number;
  readonly transcriptArtifact?: TranscriptArtifactV1;
}
export interface MoveTimelineClipInput {
  readonly clipId: string;
  readonly timelineStartFrame: number;
}
export interface TrimCaptionContext {
  readonly captionTrackId: string;
  readonly transcript: TranscriptArtifactV1;
}
export interface TrimTimelineClipInput {
  readonly clipId: string;
  readonly sourceInFrame: number;
  readonly sourceOutFrame: number;
  readonly timelineStartFrame: number;
  readonly captionContext?: TrimCaptionContext;
}
export interface RippleDeleteTimelineClipInput {
  readonly clipId: string;
}
export interface SetTimelineClipOpacityInput {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly opacityPermille: number;
}
export interface SetTimelineClipTransformInput {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly transform: ClipTransform;
}
export interface SetTimelineTrackLockedInput {
  readonly trackId: string;
  readonly locked: boolean;
}
export interface SetTimelineTrackMutedInput {
  readonly trackId: string;
  readonly muted: boolean;
}
export interface SetTimelineTrackHiddenInput {
  readonly trackId: string;
  readonly hidden: boolean;
}
export type EditOperationState =
  | { readonly phase: "idle" }
  | { readonly phase: "saving"; readonly operation: TimelineEditOperation | "undo" | "redo" }
  | {
      readonly phase: "error";
      readonly operation: TimelineEditOperation | "undo" | "redo";
      readonly error: Error;
    };

interface RenderIdentity {
  readonly jobId: string;
  readonly planId: string;
  readonly revisionId: string;
}
interface PendingRenderIdentity {
  readonly jobId: string | null;
  readonly planId: string;
  readonly revisionId: string;
  readonly outputPath: string;
}
export type RenderState =
  | { readonly phase: "idle" }
  | ({ readonly phase: "starting" } & PendingRenderIdentity)
  | ({
      readonly phase: "running";
      readonly progress: number;
      readonly cancellationPending: boolean;
      readonly cancellationError: Error | null;
    } & RenderIdentity &
      Pick<PendingRenderIdentity, "outputPath">)
  | ({ readonly phase: "completed"; readonly output: VerifiedRenderOutput } & RenderIdentity)
  | ({
      readonly phase: "completed_with_warning";
      readonly outputPath: string;
      readonly error: Error;
    } & RenderIdentity)
  | ({
      readonly phase: "failed";
      readonly error: Error;
      readonly canOverwrite: boolean;
    } & PendingRenderIdentity)
  | ({ readonly phase: "cancelled" } & RenderIdentity & Pick<PendingRenderIdentity, "outputPath">);

interface ProjectionHistoryCompat {
  readonly document: Readonly<VideoProjectFileV1>;
  readonly cursor: number;
}
export interface SnapshotCheckpointWarning {
  readonly type: "snapshot_pending";
  readonly revision: number;
}
interface VideoProjectControllerState {
  readonly projectPath: string | null;
  readonly projection: ProjectProjection | null;
  readonly source: VideoSourceRecord | null;
  readonly sourcePath: string | null;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly preparedAssetsById: Readonly<Record<string, PreparedVideoAsset>>;
  readonly preparation: PreparationState;
  readonly projectOperation: ProjectOperationState;
  readonly recovery: RecoveryReport | null;
  readonly checkpointWarning: SnapshotCheckpointWarning | null;
}
const initialControllerState: VideoProjectControllerState = {
  projectPath: null,
  projection: null,
  source: null,
  sourcePath: null,
  preparedAsset: null,
  preparedAssetsById: {},
  preparation: { phase: "idle" },
  projectOperation: { phase: "idle" },
  recovery: null,
  checkpointWarning: null,
};

function newId(): string {
  return globalThis.crypto.randomUUID();
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The desktop operation failed unexpectedly");
}
function checkpointWarningFromProjection(
  projection: ProjectProjection,
): SnapshotCheckpointWarning | null {
  return projection.journalHealth === "snapshot_pending"
    ? { type: "snapshot_pending", revision: projection.revision.number }
    : null;
}
function checkpointWarningFromResult(result: CommandResult): SnapshotCheckpointWarning | null {
  const hasSnapshotWarning = result.events.some((event) => event.type === "snapshot_warning");
  return hasSnapshotWarning || result.projection.journalHealth === "snapshot_pending"
    ? { type: "snapshot_pending", revision: result.newRevision.number }
    : null;
}
function projectNameFromPath(path: string): string {
  const fileName = path.split(/[\\/]/).at(-1)?.trim() ?? "";
  const name = fileName.replace(/\.svpvideo$/i, "").trim();
  return (name.length === 0 ? "Untitled project" : name).slice(0, 512);
}
function sourceDisplayName(path: string): string {
  const candidate = path.split(/[\\/]/).at(-1)?.trim();
  return candidate === undefined || candidate.length === 0
    ? "Selected video"
    : candidate.slice(0, 512);
}
function activeSequence(projection: ProjectProjection | null) {
  return (
    projection?.state.sequences.find(
      (sequence) => sequence.id === projection.state.activeSequenceId,
    ) ?? null
  );
}
function timelineClip(projection: ProjectProjection | null, clipId: string) {
  const sequence = activeSequence(projection);
  if (sequence === null) return null;
  for (const track of sequence.tracks) {
    if (track.kind === "caption") continue;
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return { sequence, track, clip };
  }
  return null;
}
function activeClip(projection: ProjectProjection | null) {
  const sequence = activeSequence(projection);
  if (sequence === null) return null;
  for (const track of sequence.tracks) {
    if (track.kind === "video" && track.clips[0] !== undefined)
      return { sequence, track, clip: track.clips[0] };
  }
  return null;
}
function projectionToLegacyProject(projection: ProjectProjection): Readonly<VideoProjectFileV1> {
  const selection = activeClip(projection);
  const assetId = selection?.clip.source.kind === "asset" ? selection.clip.source.assetId : null;
  const asset =
    assetId === null ? null : (projection.state.assets.find((item) => item.id === assetId) ?? null);
  const sequence =
    selection === null
      ? null
      : {
          id: selection.sequence.id,
          rate: selection.sequence.rate,
          width: selection.sequence.width,
          height: selection.sequence.height,
          audioSampleRate: 48_000 as const,
          videoTracks: [
            {
              id: selection.track.id,
              clips:
                selection.clip.source.kind === "asset"
                  ? [
                      {
                        id: selection.clip.id,
                        assetId: selection.clip.source.assetId,
                        timelineStart: { ...selection.clip.timelineStart, value: 0 },
                        sourceIn: selection.clip.sourceIn,
                        sourceOut: selection.clip.sourceOut,
                      },
                    ]
                  : [],
            },
          ],
        };
  const revision = {
    id: projection.revision.id,
    parentRevisionId: null,
    sequenceNumber: 0,
    committedAt: projection.revision.committedAt,
    commandSummary: projection.lastCommand?.summary ?? "Canonical project state",
    state: { asset, sequence },
  };
  return videoProjectFileV1Schema.parse({
    schemaVersion: 1,
    id: projection.projectId,
    name: projection.name,
    createdAt: projection.revision.committedAt,
    updatedAt: projection.revision.committedAt,
    currentRevisionId: revision.id,
    revisions: [revision],
  });
}
function projectionHistory(projection: ProjectProjection | null): ProjectionHistoryCompat | null {
  return projection === null
    ? null
    : { document: projectionToLegacyProject(projection), cursor: projection.revision.number };
}
function sourceForProjection(projection: ProjectProjection): VideoSourceRecord | null {
  const selection = activeClip(projection);
  const source = selection?.clip.source;
  const assetId = source?.kind === "asset" ? source.assetId : projection.state.assets[0]?.id;
  return (
    projection.sources.find((record) => record.assetId === assetId) ?? projection.sources[0] ?? null
  );
}
function videoSourcesForProjection(projection: ProjectProjection): readonly VideoSourceRecord[] {
  const sequence = activeSequence(projection);
  if (sequence === null) return [];
  const assetIds = new Set(
    sequence.tracks.flatMap((track) =>
      track.kind === "video"
        ? track.clips.flatMap((clip) => (clip.source.kind === "asset" ? [clip.source.assetId] : []))
        : [],
    ),
  );
  return projection.sources.filter(
    (source) => assetIds.has(source.assetId) && source.status === "resolved",
  );
}
function trimDraftForProjection(projection: ProjectProjection | null): TrimDraft | null {
  const clip = activeClip(projection)?.clip;
  return clip === undefined || clip === null
    ? null
    : { inFrame: clip.sourceIn.value, outFrame: clip.sourceOut.value };
}
function sourceDurationFrames(projection: ProjectProjection | null): number | null {
  const selection = activeClip(projection);
  const source = selection?.clip.source;
  if (source?.kind !== "asset") return null;
  const asset = projection?.state.assets.find((item) => item.id === source.assetId);
  return asset === undefined
    ? null
    : microsecondsToSourceFrames(asset.probe.durationMicroseconds, asset.probe.averageFrameRate)
        .value;
}
function renderInputPaths(
  projection: ProjectProjection | null,
): Readonly<Record<string, string>> | null {
  if (projection === null) return null;
  const sequence = activeSequence(projection);
  if (sequence === null) return null;
  const videoTracks = sequence.tracks.filter((track) => track.kind === "video");
  if (videoTracks.length === 0 || videoTracks.length > 16) return null;
  const paths: Record<string, string> = {};
  for (const track of videoTracks) {
    const clip = track.clips[0];
    if (track.clips.length !== 1 || clip === undefined || clip.source.kind !== "asset") return null;
    const assetId = clip.source.assetId;
    const source = projection.sources.find((candidate) => candidate.assetId === assetId);
    if (source?.status !== "resolved") return null;
    paths[assetId] = source.resolvedPath;
  }
  return paths;
}
function unsupportedCompositionError(reason: string): VideoDomainError {
  return new VideoDomainError("invalid_render_plan", reason, {
    category: "unsupported_composition",
  });
}
function contentIdentityMatches(
  expected: { digest: string; byteLength: number },
  actual: { digest: string; byteLength: number } | undefined,
): boolean {
  return (
    actual !== undefined &&
    actual.digest === expected.digest &&
    actual.byteLength === expected.byteLength
  );
}
function preparationRequest(
  projection: ProjectProjection,
  source: VideoSourceRecord,
): PrepareVideoAssetRequest | null {
  if (source.status !== "resolved") return null;
  const asset = projection.state.assets.find((item) => item.id === source.assetId);
  return asset === undefined
    ? null
    : {
        projectId: projection.projectId,
        assetId: asset.id,
        path: source.resolvedPath,
        sequenceRate: asset.probe.averageFrameRate,
      };
}
function exportDisplayName(projection: ProjectProjection): string {
  const stem = (projection.state.assets[0]?.displayName ?? "export").replace(/\.[^.]+$/, "").trim();
  return `${stem.length === 0 ? "export" : stem}-export.mp4`;
}
function eventMatchesIdentity(event: VideoRenderNotification, identity: RenderIdentity): boolean {
  return (
    event.jobId === identity.jobId &&
    event.planId === identity.planId &&
    event.revisionId === identity.revisionId
  );
}

export function useVideoProject(backend: VideoBackend = tauriVideoBackend) {
  const [state, setState] = useState(initialControllerState);
  const [render, setRender] = useState<RenderState>({ phase: "idle" });
  const [destinationPending, setDestinationPending] = useState(false);
  const [destinationError, setDestinationError] = useState<Error | null>(null);
  const [trimDraft, setTrimDraft] = useState<TrimDraft | null>(null);
  const [editOperation, setEditOperation] = useState<EditOperationState>({ phase: "idle" });
  const stateRef = useRef(state);
  const renderRef = useRef(render);
  const renderListenerRef = useRef<(() => void) | null>(null);
  const projectOperationRef = useRef(0);
  const editOperationRef = useRef(0);
  const editOperationPendingRef = useRef(false);
  const renderOperationRef = useRef(0);
  const invalidatedRenderRef = useRef<RenderIdentity | null>(null);
  const invalidatedStartingRenderRef = useRef<
    ({ readonly operation: number } & Omit<PendingRenderIdentity, "jobId">) | null
  >(null);
  const destinationOperationRef = useRef(0);
  const destinationPendingRef = useRef(false);
  const overwritePlanRef = useRef<Readonly<RenderPlan> | null>(null);

  const replaceState = useCallback((next: VideoProjectControllerState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const patchState = useCallback(
    (patch: Partial<VideoProjectControllerState>) =>
      replaceState({ ...stateRef.current, ...patch }),
    [replaceState],
  );
  const replaceRender = useCallback((next: RenderState) => {
    renderRef.current = next;
    setRender(next);
  }, []);
  const disposeRenderListener = useCallback(() => {
    renderListenerRef.current?.();
    renderListenerRef.current = null;
  }, []);
  const resetRender = useCallback(() => {
    renderOperationRef.current += 1;
    invalidatedRenderRef.current = null;
    invalidatedStartingRenderRef.current = null;
    destinationOperationRef.current += 1;
    disposeRenderListener();
    overwritePlanRef.current = null;
    destinationPendingRef.current = false;
    setDestinationPending(false);
    setDestinationError(null);
    replaceRender({ phase: "idle" });
  }, [disposeRenderListener, replaceRender]);
  const cancelRenderForProjectSwitch = useCallback(() => {
    const active = renderRef.current;
    if (active.phase === "starting") {
      const invalidatedStarting = invalidatedStartingRenderRef.current;
      if (
        invalidatedStarting?.planId === active.planId &&
        invalidatedStarting.revisionId === active.revisionId
      )
        return;
      invalidatedStartingRenderRef.current = {
        operation: renderOperationRef.current,
        planId: active.planId,
        revisionId: active.revisionId,
        outputPath: active.outputPath,
      };
      renderOperationRef.current += 1;
      destinationOperationRef.current += 1;
      overwritePlanRef.current = null;
      destinationPendingRef.current = false;
      setDestinationPending(false);
      setDestinationError(null);
      return;
    }
    if (active.phase !== "running") {
      resetRender();
      return;
    }
    if (invalidatedRenderRef.current?.jobId === active.jobId) return;
    const invalidated: RenderIdentity = {
      jobId: active.jobId,
      planId: active.planId,
      revisionId: active.revisionId,
    };
    invalidatedRenderRef.current = invalidated;
    renderOperationRef.current += 1;
    replaceRender({ ...active, cancellationPending: true, cancellationError: null });
    void backend.cancelVideoRender(active.jobId).then(
      () => {
        if (
          invalidatedRenderRef.current?.jobId === invalidated.jobId &&
          renderRef.current.phase === "running" &&
          renderRef.current.jobId === invalidated.jobId
        )
          resetRender();
      },
      (error: unknown) => {
        if (
          invalidatedRenderRef.current?.jobId === invalidated.jobId &&
          renderRef.current.phase === "running" &&
          renderRef.current.jobId === invalidated.jobId
        )
          replaceRender({
            ...renderRef.current,
            cancellationPending: false,
            cancellationError: asError(error),
          });
      },
    );
  }, [backend, replaceRender, resetRender]);
  const activateProjection = useCallback(
    (projection: ProjectProjection, patch: Partial<VideoProjectControllerState> = {}) => {
      cancelRenderForProjectSwitch();
      editOperationRef.current += 1;
      editOperationPendingRef.current = false;
      setEditOperation({ phase: "idle" });
      setTrimDraft(trimDraftForProjection(projection));
      const source = sourceForProjection(projection);
      replaceState({
        ...initialControllerState,
        projectPath: stateRef.current.projectPath,
        projection,
        source,
        sourcePath: source?.status === "resolved" ? source.resolvedPath : null,
        checkpointWarning: checkpointWarningFromProjection(projection),
        ...patch,
      });
    },
    [cancelRenderForProjectSwitch, replaceState],
  );
  const closeCurrent = useCallback(async () => {
    const projectId = stateRef.current.projection?.projectId;
    if (projectId !== undefined) await backend.closeVideoProject(projectId).catch(() => undefined);
  }, [backend]);

  useEffect(
    () => () => {
      projectOperationRef.current += 1;
      editOperationRef.current += 1;
      renderOperationRef.current += 1;
      destinationOperationRef.current += 1;
      disposeRenderListener();
      const active = renderRef.current;
      if (active.phase === "running")
        void backend.cancelVideoRender(active.jobId).catch(() => undefined);
      const projectId = stateRef.current.projection?.projectId;
      if (projectId !== undefined) void backend.closeVideoProject(projectId).catch(() => undefined);
    },
    [backend, disposeRenderListener],
  );

  const handleRenderEvent = useCallback(
    (operation: number, plan: Readonly<RenderPlan>, event: VideoRenderNotification) => {
      if (
        operation !== renderOperationRef.current ||
        event.planId !== plan.planId ||
        event.revisionId !== plan.revisionId ||
        (invalidatedRenderRef.current !== null &&
          eventMatchesIdentity(event, invalidatedRenderRef.current))
      )
        return;
      const active = renderRef.current;
      if (event.type === "started") {
        if (active.phase === "starting" && active.jobId === null)
          replaceRender({
            phase: "running",
            jobId: event.jobId,
            planId: event.planId,
            revisionId: event.revisionId,
            outputPath: active.outputPath,
            progress: 0,
            cancellationPending: false,
            cancellationError: null,
          });
        return;
      }
      if (active.phase !== "running" || !eventMatchesIdentity(event, active)) return;
      if (event.type === "progress") {
        const progress = Math.min(
          100,
          Math.floor((event.completedMicroseconds / event.durationMicroseconds) * 100),
        );
        if (progress > active.progress) replaceRender({ ...active, progress });
        return;
      }
      disposeRenderListener();
      overwritePlanRef.current = null;
      if (event.type === "completed")
        replaceRender({
          phase: "completed",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          output: event.output,
        });
      else if (event.type === "cancelled")
        replaceRender({
          phase: "cancelled",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          outputPath: active.outputPath,
        });
      else if (event.type === "failed") {
        const warning =
          event.error.code === "project_io" && event.error.details.outputExists === true;
        if (warning)
          replaceRender({
            phase: "completed_with_warning",
            jobId: event.jobId,
            planId: event.planId,
            revisionId: event.revisionId,
            outputPath: active.outputPath,
            error: event.error,
          });
        else {
          const canOverwrite = event.error.code === "output_exists";
          overwritePlanRef.current = canOverwrite ? plan : null;
          replaceRender({
            phase: "failed",
            jobId: event.jobId,
            planId: event.planId,
            revisionId: event.revisionId,
            outputPath: active.outputPath,
            error: event.error,
            canOverwrite,
          });
        }
      }
    },
    [disposeRenderListener, replaceRender],
  );

  const startRenderPlan = useCallback(
    async (plan: Readonly<RenderPlan>, overwrite: boolean) => {
      const operation = ++renderOperationRef.current;
      disposeRenderListener();
      overwritePlanRef.current = null;
      replaceRender({
        phase: "starting",
        jobId: null,
        planId: plan.planId,
        revisionId: plan.revisionId,
        outputPath: plan.outputPath,
      });
      try {
        const unlisten = await backend.listenVideoRenderEvents((event) =>
          handleRenderEvent(operation, plan, event),
        );
        if (operation !== renderOperationRef.current) {
          unlisten();
          if (invalidatedStartingRenderRef.current?.operation === operation) resetRender();
          return;
        }
        renderListenerRef.current = unlisten;
        const started = await backend.startVideoRender(plan, overwrite);
        if (operation !== renderOperationRef.current) {
          disposeRenderListener();
          const invalidatedStarting = invalidatedStartingRenderRef.current;
          const invalidated: RenderIdentity = {
            jobId: started.jobId,
            planId: started.planId,
            revisionId: started.revisionId,
          };
          if (
            invalidatedRenderRef.current?.jobId === invalidated.jobId &&
            invalidatedRenderRef.current.planId === invalidated.planId &&
            invalidatedRenderRef.current.revisionId === invalidated.revisionId
          )
            return;
          if (
            invalidatedStarting?.operation !== operation ||
            invalidatedStarting.planId !== plan.planId ||
            invalidatedStarting.revisionId !== plan.revisionId
          ) {
            void backend.cancelVideoRender(started.jobId).catch(() => undefined);
            return;
          }
          invalidatedStartingRenderRef.current = null;
          invalidatedRenderRef.current = invalidated;
          replaceRender({
            phase: "running",
            ...started,
            outputPath: invalidatedStarting.outputPath,
            progress: 0,
            cancellationPending: true,
            cancellationError: null,
          });
          try {
            await backend.cancelVideoRender(started.jobId);
            if (
              invalidatedRenderRef.current?.jobId === started.jobId &&
              renderRef.current.phase === "running" &&
              renderRef.current.jobId === started.jobId
            )
              resetRender();
          } catch (error) {
            if (
              invalidatedRenderRef.current?.jobId === started.jobId &&
              renderRef.current.phase === "running" &&
              renderRef.current.jobId === started.jobId
            )
              replaceRender({
                ...renderRef.current,
                cancellationPending: false,
                cancellationError: asError(error),
              });
          }
          return;
        }
        if (started.planId !== plan.planId || started.revisionId !== plan.revisionId)
          throw new Error("The desktop service returned a mismatched export job");
        if (renderRef.current.phase === "starting")
          replaceRender({
            phase: "running",
            ...started,
            outputPath: plan.outputPath,
            progress: 0,
            cancellationPending: false,
            cancellationError: null,
          });
      } catch (error) {
        if (operation !== renderOperationRef.current) {
          if (invalidatedStartingRenderRef.current?.operation === operation) resetRender();
          return;
        }
        disposeRenderListener();
        const normalized = asError(error);
        const canOverwrite = "code" in normalized && normalized.code === "output_exists";
        overwritePlanRef.current = canOverwrite ? plan : null;
        replaceRender({
          phase: "failed",
          jobId: null,
          planId: plan.planId,
          revisionId: plan.revisionId,
          outputPath: plan.outputPath,
          error: normalized,
          canOverwrite,
        });
      }
    },
    [backend, disposeRenderListener, handleRenderEvent, replaceRender, resetRender],
  );

  const prepareOpenedSources = useCallback(
    async (
      operation: number,
      projection: ProjectProjection,
      sources: readonly VideoSourceRecord[],
    ) => {
      const requests = sources.flatMap((source) => {
        const request = preparationRequest(projection, source);
        return request === null ? [] : [request];
      });
      if (requests.length === 0) return;
      patchState({
        preparation: { phase: "pending" },
        preparedAsset: null,
        preparedAssetsById: {},
      });
      try {
        const preparedEntries = await Promise.all(
          requests.map(async (request) => {
            const prepared = await backend.prepareVideoAsset(request);
            const asset = projection.state.assets.find((item) => item.id === request.assetId);
            if (
              asset?.contentIdentity !== undefined &&
              !contentIdentityMatches(prepared.sourceIdentity, asset.contentIdentity)
            )
              throw new Error("The prepared source does not match the committed project asset");
            return [request.assetId, prepared] as const;
          }),
        );
        if (
          operation === projectOperationRef.current &&
          stateRef.current.projection?.projectId === projection.projectId &&
          stateRef.current.projection.revision.number === projection.revision.number
        ) {
          const preparedAssetsById = Object.fromEntries(preparedEntries);
          const primaryAssetId = activeClip(projection)?.clip.source;
          const preparedAsset =
            primaryAssetId?.kind === "asset"
              ? (preparedAssetsById[primaryAssetId.assetId] ?? null)
              : null;
          patchState({
            preparedAsset,
            preparedAssetsById,
            preparation:
              preparedAsset === null
                ? { phase: "idle" }
                : { phase: "success", value: preparedAsset },
          });
        }
      } catch (error) {
        if (operation === projectOperationRef.current)
          patchState({
            preparedAsset: null,
            preparedAssetsById: {},
            preparation: { phase: "error", error: asError(error) },
          });
      }
    },
    [backend, patchState],
  );

  const newProject = useCallback(async () => {
    const operation = ++projectOperationRef.current;
    const previous = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "new" } });
    try {
      const path = await backend.pickNewVideoProjectPath("Untitled.svpvideo");
      if (operation !== projectOperationRef.current) return;
      if (path === null) {
        replaceState({ ...previous, projectOperation: { phase: "idle" } });
        return;
      }
      const projection = await backend.createVideoProject(path, projectNameFromPath(path));
      if (operation !== projectOperationRef.current) {
        await backend.closeVideoProject(projection.projectId);
        return;
      }
      await closeCurrent();
      stateRef.current = { ...stateRef.current, projectPath: path };
      activateProjection(projection, { projectPath: path, projectOperation: { phase: "idle" } });
    } catch (error) {
      if (operation === projectOperationRef.current)
        replaceState({
          ...previous,
          projectOperation: { phase: "error", operation: "new", error: asError(error) },
        });
    }
  }, [activateProjection, backend, closeCurrent, patchState, replaceState]);

  const openProject = useCallback(async () => {
    const operation = ++projectOperationRef.current;
    const previous = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "open" } });
    try {
      const opened = await backend.openVideoProject();
      if (operation !== projectOperationRef.current) {
        if (opened !== null) await backend.closeVideoProject(opened.projection.projectId);
        return;
      }
      if (opened === null) {
        replaceState({ ...previous, projectOperation: { phase: "idle" } });
        return;
      }
      await closeCurrent();
      activateProjection(opened.projection, {
        projectPath: null,
        recovery: opened.recovery,
        projectOperation: { phase: "idle" },
      });
      const sources = videoSourcesForProjection(opened.projection);
      if (sources.length > 0) await prepareOpenedSources(operation, opened.projection, sources);
    } catch (error) {
      if (operation === projectOperationRef.current)
        replaceState({
          ...previous,
          projectOperation: { phase: "error", operation: "open", error: asError(error) },
        });
    }
  }, [activateProjection, backend, closeCurrent, patchState, prepareOpenedSources, replaceState]);

  const persistImportedSource = useCallback(
    async (operation: number, path: string) => {
      const base = stateRef.current.projection;
      if (base === null) throw new Error("Create or open a project before choosing a source video");
      const assetId = newId();
      const sequenceId = newId();
      const trackId = newId();
      const clipId = newId();
      const prepareRequest: PrepareVideoAssetRequest = {
        projectId: base.projectId,
        assetId,
        path,
      };
      const prepared = await backend.prepareVideoAsset(prepareRequest);
      if (operation !== projectOperationRef.current) return;
      const rate = prepared.sequenceRate;
      const sourceProbe = prepared.sourceProbe;
      const request = buildCommandGroup({
        groupId: newId(),
        projectId: base.projectId,
        baseRevision: base.revision.number,
        commands: [
          {
            type: "ImportAsset",
            commandId: newId(),
            asset: {
              id: assetId,
              displayName: sourceDisplayName(path),
              locator: { absolutePath: path },
              probe: sourceProbe,
              contentIdentity: prepared.sourceIdentity,
            },
          },
          {
            type: "CreateSequence",
            commandId: newId(),
            sequence: {
              id: sequenceId,
              name: "Sequence 1",
              rate,
              width: prepared.proxyProbe.width,
              height: prepared.proxyProbe.height,
              audioSampleRate: 48_000,
              tracks: [{ id: trackId, name: "Video 1", kind: "video", clips: [] }],
              markers: [],
            },
          },
          {
            type: "InsertClip",
            commandId: newId(),
            sequenceId,
            trackId,
            clip: {
              id: clipId,
              source: { kind: "asset", assetId },
              timelineStart: createRationalTime(0, rate),
              sourceIn: createRationalTime(0, rate),
              sourceOut: microsecondsToSourceFrames(sourceProbe.durationMicroseconds, rate),
              transform: {
                positionXPermille: 0,
                positionYPermille: 0,
                scaleXPermille: 1_000,
                scaleYPermille: 1_000,
                rotationMilliDegrees: 0,
                opacityPermille: 1_000,
              },
              gainMilliDecibels: 0,
            },
          },
        ],
      });
      const result = await backend.executeVideoProjectGroup(request);
      if (
        operation !== projectOperationRef.current ||
        stateRef.current.projection !== base ||
        result.projectId !== base.projectId ||
        result.priorRevision.number !== base.revision.number ||
        result.newRevision.number !== base.revision.number + 1 ||
        result.groupId !== request.groupId
      )
        return;
      const committedAsset = result.projection.state.assets.find((asset) => asset.id === assetId);
      if (!contentIdentityMatches(prepared.sourceIdentity, committedAsset?.contentIdentity))
        throw new Error("The committed source identity does not match the prepared media");
      activateProjection(result.projection, {
        projectPath: stateRef.current.projectPath,
        preparedAsset: prepared,
        preparedAssetsById: { [assetId]: prepared },
        preparation: { phase: "success", value: prepared },
        projectOperation: { phase: "idle" },
        checkpointWarning: checkpointWarningFromResult(result),
      });
    },
    [activateProjection, backend],
  );

  const chooseSource = useCallback(async () => {
    const operation = ++projectOperationRef.current;
    const previous = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "import" } });
    try {
      const path = await backend.pickVideoSource();
      if (operation !== projectOperationRef.current) return;
      if (path === null) {
        replaceState({ ...previous, projectOperation: { phase: "idle" } });
        return;
      }
      patchState({ preparation: { phase: "pending" } });
      await persistImportedSource(operation, path);
    } catch (error) {
      if (operation === projectOperationRef.current)
        replaceState({
          ...previous,
          projectOperation: { phase: "error", operation: "import", error: asError(error) },
          preparation: { phase: "error", error: asError(error) },
        });
    }
  }, [backend, patchState, persistImportedSource, replaceState]);
  const prepareImportedSource = useCallback(
    async (path: string) => {
      const operation = ++projectOperationRef.current;
      patchState({
        projectOperation: { phase: "pending", operation: "import" },
        preparation: { phase: "pending" },
      });
      try {
        await persistImportedSource(operation, path);
      } catch (error) {
        if (operation === projectOperationRef.current)
          patchState({
            projectOperation: { phase: "error", operation: "import", error: asError(error) },
            preparation: { phase: "error", error: asError(error) },
          });
      }
    },
    [patchState, persistImportedSource],
  );

  const regrantSourceAccess = useCallback(async () => {
    const projection = stateRef.current.projection;
    const source = stateRef.current.source;
    if (projection === null || source === null || source.status === "resolved") return;
    const operation = ++projectOperationRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "regrant" } });
    try {
      const relinked = await backend.relinkVideoProjectAsset(projection.projectId, source.assetId);
      if (operation !== projectOperationRef.current) return;
      if (relinked === null) {
        patchState({ projectOperation: { phase: "idle" } });
        return;
      }
      if (
        relinked.projectId !== projection.projectId ||
        relinked.priorRevision.number !== projection.revision.number
      )
        throw new Error("The desktop service returned a mismatched relink operation");
      activateProjection(relinked.projection, {
        projectPath: stateRef.current.projectPath,
        projectOperation: { phase: "idle" },
        checkpointWarning: checkpointWarningFromResult(relinked),
      });
      const resolved = sourceForProjection(relinked.projection);
      if (resolved !== null)
        await prepareOpenedSources(
          operation,
          relinked.projection,
          videoSourcesForProjection(relinked.projection),
        );
    } catch (error) {
      if (operation === projectOperationRef.current)
        patchState({
          projectOperation: { phase: "error", operation: "regrant", error: asError(error) },
        });
    }
  }, [activateProjection, backend, patchState, prepareOpenedSources]);
  const retryPreparation = useCallback(async () => {
    const projection = stateRef.current.projection;
    if (projection !== null)
      await prepareOpenedSources(
        ++projectOperationRef.current,
        projection,
        videoSourcesForProjection(projection),
      );
  }, [prepareOpenedSources]);
  const updateTrimDraft = useCallback((patch: Partial<TrimDraft>) => {
    setTrimDraft((current) => (current === null ? null : { ...current, ...patch }));
    setEditOperation({ phase: "idle" });
  }, []);

  const activateEditResult = useCallback(
    (base: ProjectProjection, result: CommandResult, operation: number) => {
      if (
        operation !== editOperationRef.current ||
        stateRef.current.projection !== base ||
        result.projectId !== base.projectId ||
        result.priorRevision.number !== base.revision.number ||
        result.newRevision.number !== base.revision.number + 1
      )
        return false;
      cancelRenderForProjectSwitch();
      const sourceInvalidated = result.cacheInvalidations.includes("asset_source");
      activateProjection(result.projection, {
        projectPath: stateRef.current.projectPath,
        ...(sourceInvalidated
          ? {}
          : {
              preparedAsset: stateRef.current.preparedAsset,
              preparedAssetsById: stateRef.current.preparedAssetsById,
              preparation: stateRef.current.preparation,
            }),
        checkpointWarning: checkpointWarningFromResult(result),
      });
      return true;
    },
    [activateProjection, cancelRenderForProjectSwitch],
  );
  const executeTimelineCommandGroup = useCallback(
    async (
      base: ProjectProjection,
      operationKind: TimelineEditOperation,
      commands: readonly ProjectCommandV2[],
      groupId = newId(),
    ) => {
      const operation = ++editOperationRef.current;
      editOperationPendingRef.current = true;
      setEditOperation({ phase: "saving", operation: operationKind });
      const request = buildCommandGroup({
        groupId,
        projectId: base.projectId,
        baseRevision: base.revision.number,
        commands: commands.map((command) => buildProjectCommand(command)),
      });
      try {
        const result = await backend.executeVideoProjectGroup(request);
        if (result.groupId !== request.groupId)
          throw new Error("The desktop service returned a mismatched edit");
        const activated = activateEditResult(base, result, operation);
        if (activated) setEditOperation({ phase: "idle" });
        return activated;
      } catch (error) {
        if (operation === editOperationRef.current)
          setEditOperation({ phase: "error", operation: operationKind, error: asError(error) });
        return false;
      } finally {
        if (operation === editOperationRef.current) editOperationPendingRef.current = false;
      }
    },
    [activateEditResult, backend],
  );
  const applyTranscriptEditProposal = useCallback(
    async (proposal: TranscriptEditProposal, artifact: TranscriptArtifactV1): Promise<boolean> => {
      const base = stateRef.current.projection;
      if (base === null || editOperationPendingRef.current) return false;
      try {
        assertTranscriptEditProposalCurrent({ proposal, artifact, projection: base });
      } catch (error) {
        setEditOperation({ phase: "error", operation: "transcript-edit", error: asError(error) });
        return false;
      }

      const operation = ++editOperationRef.current;
      editOperationPendingRef.current = true;
      setEditOperation({ phase: "saving", operation: "transcript-edit" });
      const request = proposal.commandGroup;
      try {
        const result = await backend.executeVideoProjectGroup(request);
        if (result.groupId !== request.groupId)
          throw new Error("The desktop service returned a mismatched transcript edit");
        const activated = activateEditResult(base, result, operation);
        if (activated) setEditOperation({ phase: "idle" });
        return activated;
      } catch (error) {
        if (operation === editOperationRef.current)
          setEditOperation({ phase: "error", operation: "transcript-edit", error: asError(error) });
        return false;
      } finally {
        if (operation === editOperationRef.current) editOperationPendingRef.current = false;
      }
    },
    [activateEditResult, backend],
  );
  const splitTimelineClip = useCallback(
    async ({ clipId, sourceFrame, transcriptArtifact }: SplitTimelineClipInput) => {
      const base = stateRef.current.projection;
      const selection = timelineClip(base, clipId);
      if (
        base === null ||
        selection === null ||
        !Number.isSafeInteger(sourceFrame) ||
        sourceFrame <= selection.clip.sourceIn.value ||
        sourceFrame >= selection.clip.sourceOut.value
      )
        return false;
      const command: Extract<ProjectCommandV2, { readonly type: "SplitClip" }> = {
        type: "SplitClip",
        commandId: newId(),
        sequenceId: selection.sequence.id,
        trackId: selection.track.id,
        clipId: selection.clip.id,
        splitAt: createRationalTime(sourceFrame, {
          numerator: selection.clip.sourceIn.rateNumerator,
          denominator: selection.clip.sourceIn.rateDenominator,
        }),
        rightClipId: newId(),
      };
      try {
        const commands = prepareSplitClipCaptionLifecycleV1({
          projection: base,
          ...(transcriptArtifact === undefined ? {} : { transcriptArtifact }),
          command,
        });
        return await executeTimelineCommandGroup(base, "split", commands);
      } catch (error) {
        setEditOperation({ phase: "error", operation: "split", error: asError(error) });
        return false;
      }
    },
    [executeTimelineCommandGroup],
  );
  const moveTimelineClip = useCallback(
    async ({ clipId, timelineStartFrame }: MoveTimelineClipInput) => {
      const base = stateRef.current.projection;
      const selection = timelineClip(base, clipId);
      if (
        base === null ||
        selection === null ||
        !Number.isSafeInteger(timelineStartFrame) ||
        timelineStartFrame < 0 ||
        timelineStartFrame === selection.clip.timelineStart.value
      )
        return;
      await executeTimelineCommandGroup(base, "move", [
        {
          type: "MoveClip",
          commandId: newId(),
          sequenceId: selection.sequence.id,
          trackId: selection.track.id,
          clipId: selection.clip.id,
          timelineStart: createRationalTime(timelineStartFrame, {
            numerator: selection.clip.timelineStart.rateNumerator,
            denominator: selection.clip.timelineStart.rateDenominator,
          }),
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const trimTimelineClip = useCallback(
    async ({
      clipId,
      sourceInFrame,
      sourceOutFrame,
      timelineStartFrame,
      captionContext,
    }: TrimTimelineClipInput) => {
      const base = stateRef.current.projection;
      const selection = timelineClip(base, clipId);
      if (
        base === null ||
        selection === null ||
        !Number.isSafeInteger(sourceInFrame) ||
        !Number.isSafeInteger(sourceOutFrame) ||
        !Number.isSafeInteger(timelineStartFrame) ||
        sourceInFrame < 0 ||
        sourceInFrame >= sourceOutFrame ||
        timelineStartFrame < 0 ||
        (sourceInFrame === selection.clip.sourceIn.value &&
          sourceOutFrame === selection.clip.sourceOut.value &&
          timelineStartFrame === selection.clip.timelineStart.value)
      )
        return false;
      const trimCommand: Extract<ProjectCommandV2, { readonly type: "TrimClip" }> = {
        type: "TrimClip",
        commandId: newId(),
        sequenceId: selection.sequence.id,
        trackId: selection.track.id,
        clipId: selection.clip.id,
        sourceIn: createRationalTime(sourceInFrame, {
          numerator: selection.clip.sourceIn.rateNumerator,
          denominator: selection.clip.sourceIn.rateDenominator,
        }),
        sourceOut: createRationalTime(sourceOutFrame, {
          numerator: selection.clip.sourceOut.rateNumerator,
          denominator: selection.clip.sourceOut.rateDenominator,
        }),
      };
      const moveCommand: Extract<ProjectCommandV2, { readonly type: "MoveClip" }> | undefined =
        timelineStartFrame === selection.clip.timelineStart.value
          ? undefined
          : {
              type: "MoveClip",
              commandId: newId(),
              sequenceId: selection.sequence.id,
              trackId: selection.track.id,
              clipId: selection.clip.id,
              timelineStart: createRationalTime(timelineStartFrame, {
                numerator: selection.clip.timelineStart.rateNumerator,
                denominator: selection.clip.timelineStart.rateDenominator,
              }),
            };
      const commands: ProjectCommandV2[] = [
        trimCommand,
        ...(moveCommand === undefined ? [] : [moveCommand]),
      ];
      const activeCaptionTracks = selection.sequence.tracks.filter(
        (track) => track.kind === "caption" && track.activeCaptionArtifact !== undefined,
      );
      if (activeCaptionTracks.length === 0)
        return executeTimelineCommandGroup(base, "trim", commands);

      try {
        if (activeCaptionTracks.length !== 1)
          throw new VideoDomainError(
            "invalid_project",
            "Trim cannot update multiple active caption artifacts from one transcript context",
            {
              reason: "trim_caption_context_ambiguous",
              captionTrackCount: activeCaptionTracks.length,
            },
          );
        const activeCaptionTrack = activeCaptionTracks[0]!;
        if (captionContext === undefined)
          throw new VideoDomainError(
            "invalid_project",
            "Trim requires transcript context while captions are active",
            { reason: "trim_caption_context_missing", captionTrackId: activeCaptionTrack.id },
          );
        if (captionContext.captionTrackId !== activeCaptionTrack.id)
          throw new VideoDomainError(
            "invalid_project",
            "Trim transcript context does not identify the active caption track",
            {
              reason: "trim_caption_context_mismatch",
              activeCaptionTrackId: activeCaptionTrack.id,
              contextCaptionTrackId: captionContext.captionTrackId,
            },
          );
        const groupId = newId();
        const prepared = prepareTrimClipCaptionLifecycleV1({
          projection: base,
          transcript: captionContext.transcript,
          trimCommand,
          ...(moveCommand === undefined ? {} : { moveCommand }),
          captionTrackId: activeCaptionTrack.id,
          groupId,
          applyCaptionArtifactCommandId: newId(),
        });
        return executeTimelineCommandGroup(base, "trim", prepared.commandGroup.commands, groupId);
      } catch (error) {
        setEditOperation({ phase: "error", operation: "trim", error: asError(error) });
        return false;
      }
    },
    [executeTimelineCommandGroup],
  );
  const rippleDeleteTimelineClip = useCallback(
    async ({ clipId }: RippleDeleteTimelineClipInput) => {
      const base = stateRef.current.projection;
      const selection = timelineClip(base, clipId);
      if (base === null || selection === null) return;
      await executeTimelineCommandGroup(base, "ripple-delete", [
        {
          type: "RippleDeleteClip",
          commandId: newId(),
          sequenceId: selection.sequence.id,
          trackId: selection.track.id,
          clipId: selection.clip.id,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const setTimelineClipOpacity = useCallback(
    async ({
      sequenceId,
      trackId,
      clipId,
      opacityPermille,
    }: SetTimelineClipOpacityInput): Promise<boolean> => {
      const base = stateRef.current.projection;
      const sequence = activeSequence(base);
      const track = sequence?.tracks.find((candidate) => candidate.id === trackId);
      if (
        base === null ||
        sequence === null ||
        sequence.id !== sequenceId ||
        track?.kind !== "video" ||
        isTrackLocked(track) ||
        !Number.isSafeInteger(opacityPermille) ||
        opacityPermille < 0 ||
        opacityPermille > 1_000 ||
        editOperationPendingRef.current
      )
        return false;
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip === undefined || clip.transform.opacityPermille === opacityPermille) return false;
      return executeTimelineCommandGroup(base, "clip-opacity", [
        {
          type: "SetClipOpacity",
          commandId: newId(),
          sequenceId: sequence.id,
          trackId: track.id,
          clipId: clip.id,
          opacityPermille,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const setTimelineClipTransform = useCallback(
    async ({
      sequenceId,
      trackId,
      clipId,
      transform,
    }: SetTimelineClipTransformInput): Promise<boolean> => {
      const base = stateRef.current.projection;
      const sequence = activeSequence(base);
      const track = sequence?.tracks.find((candidate) => candidate.id === trackId);
      if (
        base === null ||
        sequence === null ||
        sequence.id !== sequenceId ||
        track?.kind !== "video" ||
        isTrackLocked(track) ||
        !clipTransformSchema.safeParse(transform).success ||
        editOperationPendingRef.current
      )
        return false;
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip === undefined) return false;
      if (
        clip.transform.positionXPermille === transform.positionXPermille &&
        clip.transform.positionYPermille === transform.positionYPermille &&
        clip.transform.scaleXPermille === transform.scaleXPermille &&
        clip.transform.scaleYPermille === transform.scaleYPermille &&
        clip.transform.rotationMilliDegrees === transform.rotationMilliDegrees &&
        clip.transform.opacityPermille === transform.opacityPermille
      )
        return false;
      return executeTimelineCommandGroup(base, "clip-transform", [
        {
          type: "SetClipTransform",
          commandId: newId(),
          sequenceId: sequence.id,
          trackId: track.id,
          clipId: clip.id,
          transform,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const setTimelineTrackLocked = useCallback(
    async ({ trackId, locked }: SetTimelineTrackLockedInput) => {
      const base = stateRef.current.projection;
      const sequence = activeSequence(base);
      const track = sequence?.tracks.find((candidate) => candidate.id === trackId);
      if (
        base === null ||
        sequence === null ||
        track === undefined ||
        isTrackLocked(track) === locked
      )
        return;
      await executeTimelineCommandGroup(base, "track-lock", [
        {
          type: "SetTrackLocked",
          commandId: newId(),
          sequenceId: sequence.id,
          trackId: track.id,
          locked,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const setTimelineTrackMuted = useCallback(
    async ({ trackId, muted }: SetTimelineTrackMutedInput) => {
      const base = stateRef.current.projection;
      const sequence = activeSequence(base);
      const track = sequence?.tracks.find((candidate) => candidate.id === trackId);
      if (
        base === null ||
        sequence === null ||
        track === undefined ||
        track.kind === "caption" ||
        isTrackMuted(track) === muted
      )
        return;
      await executeTimelineCommandGroup(base, "track-mute", [
        {
          type: "SetTrackMuted",
          commandId: newId(),
          sequenceId: sequence.id,
          trackId: track.id,
          muted,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const setTimelineTrackHidden = useCallback(
    async ({ trackId, hidden }: SetTimelineTrackHiddenInput): Promise<boolean> => {
      const base = stateRef.current.projection;
      const sequence = activeSequence(base);
      const track = sequence?.tracks.find((candidate) => candidate.id === trackId);
      if (
        base === null ||
        sequence === null ||
        track === undefined ||
        !canToggleTrackVisibility(track) ||
        isTrackHidden(track) === hidden ||
        editOperationPendingRef.current
      )
        return false;
      return executeTimelineCommandGroup(base, "track-visibility", [
        {
          type: "SetTrackHidden",
          commandId: newId(),
          sequenceId: sequence.id,
          trackId: track.id,
          hidden,
        },
      ]);
    },
    [executeTimelineCommandGroup],
  );
  const applyTrim = useCallback(async () => {
    const base = stateRef.current.projection;
    const selection = activeClip(base);
    const draft = trimDraft;
    const duration = sourceDurationFrames(base);
    if (
      selection === null ||
      draft === null ||
      duration === null ||
      !Number.isSafeInteger(draft.inFrame) ||
      !Number.isSafeInteger(draft.outFrame) ||
      draft.inFrame < 0 ||
      draft.inFrame >= draft.outFrame ||
      draft.outFrame > duration ||
      (draft.inFrame === selection.clip.sourceIn.value &&
        draft.outFrame === selection.clip.sourceOut.value)
    )
      return;
    await trimTimelineClip({
      clipId: selection.clip.id,
      sourceInFrame: draft.inFrame,
      sourceOutFrame: draft.outFrame,
      timelineStartFrame: selection.clip.timelineStart.value,
    });
  }, [trimDraft, trimTimelineClip]);
  const historyEdit = useCallback(
    async (kind: "undo" | "redo") => {
      const base = stateRef.current.projection;
      if (base === null || (kind === "undo" ? !base.canUndo : !base.canRedo)) return;
      const operation = ++editOperationRef.current;
      editOperationPendingRef.current = true;
      setEditOperation({ phase: "saving", operation: kind });
      const operationId = newId();
      try {
        const result = await (kind === "undo"
          ? backend.undoVideoProject(base.projectId, base.revision.number, operationId)
          : backend.redoVideoProject(base.projectId, base.revision.number, operationId));
        if (result.operationId !== operationId)
          throw new Error("The desktop service returned a mismatched history operation");
        if (activateEditResult(base, result, operation)) {
          setEditOperation({ phase: "idle" });
          if (result.cacheInvalidations.includes("asset_source"))
            await prepareOpenedSources(
              ++projectOperationRef.current,
              result.projection,
              videoSourcesForProjection(result.projection),
            );
        }
      } catch (error) {
        if (operation === editOperationRef.current)
          setEditOperation({ phase: "error", operation: kind, error: asError(error) });
      } finally {
        if (operation === editOperationRef.current) editOperationPendingRef.current = false;
      }
    },
    [activateEditResult, backend, prepareOpenedSources],
  );
  const undoEdit = useCallback(() => historyEdit("undo"), [historyEdit]);
  const redoEdit = useCallback(() => historyEdit("redo"), [historyEdit]);

  const exportVideo = useCallback(async () => {
    const projection = stateRef.current.projection;
    if (
      projection === null ||
      destinationPendingRef.current ||
      renderRef.current.phase === "starting" ||
      renderRef.current.phase === "running"
    )
      return;
    const eligibility = getActiveSequenceRenderEligibility({
      revision: projection.revision,
      state: projection.state,
    });
    if (!eligibility.eligible) {
      setDestinationError(unsupportedCompositionError(eligibility.reason));
      return;
    }
    const initialInputPaths = renderInputPaths(projection);
    if (stateRef.current.preparedAsset === null || initialInputPaths === null) return;

    const operation = ++destinationOperationRef.current;
    destinationPendingRef.current = true;
    setDestinationPending(true);
    setDestinationError(null);
    try {
      const outputPath = await backend.pickVideoExportPath(exportDisplayName(projection));
      if (operation !== destinationOperationRef.current || outputPath === null) return;
      const active = stateRef.current.projection;
      const inputPathsByAssetId = renderInputPaths(active);
      if (active === null || inputPathsByAssetId === null)
        throw new Error("The project changed before export could start");
      const activeEligibility = getActiveSequenceRenderEligibility({
        revision: active.revision,
        state: active.state,
      });
      if (!activeEligibility.eligible) {
        throw unsupportedCompositionError(activeEligibility.reason);
      }
      const plan = compileActiveSequenceRenderPlan({
        planId: newId(),
        revision: { revision: active.revision, state: active.state },
        inputPathsByAssetId,
        outputPath,
      });
      await startRenderPlan(plan, false);
    } catch (error) {
      if (operation === destinationOperationRef.current) setDestinationError(asError(error));
    } finally {
      if (operation === destinationOperationRef.current) {
        destinationPendingRef.current = false;
        setDestinationPending(false);
      }
    }
  }, [backend, startRenderPlan]);
  const confirmOverwrite = useCallback(async () => {
    const plan = overwritePlanRef.current;
    if (plan !== null && renderRef.current.phase === "failed") await startRenderPlan(plan, true);
  }, [startRenderPlan]);
  const cancelRender = useCallback(async () => {
    const active = renderRef.current;
    if (active.phase !== "running" || active.cancellationPending) return;
    const invalidated = invalidatedRenderRef.current?.jobId === active.jobId;
    replaceRender({ ...active, cancellationPending: true, cancellationError: null });
    try {
      await backend.cancelVideoRender(active.jobId);
      if (
        invalidated &&
        invalidatedRenderRef.current?.jobId === active.jobId &&
        renderRef.current.phase === "running" &&
        renderRef.current.jobId === active.jobId
      )
        resetRender();
    } catch (error) {
      if (renderRef.current.phase === "running" && renderRef.current.jobId === active.jobId)
        replaceRender({
          ...renderRef.current,
          cancellationPending: false,
          cancellationError: asError(error),
        });
    }
  }, [backend, replaceRender, resetRender]);

  const project = state.projection === null ? null : projectionToLegacyProject(state.projection);
  const history = projectionHistory(state.projection);
  const committedTrim = trimDraftForProjection(state.projection);
  const sourceFrameCount = sourceDurationFrames(state.projection);
  const trimValid =
    trimDraft !== null &&
    sourceFrameCount !== null &&
    Number.isSafeInteger(trimDraft.inFrame) &&
    Number.isSafeInteger(trimDraft.outFrame) &&
    trimDraft.inFrame >= 0 &&
    trimDraft.inFrame < trimDraft.outFrame &&
    trimDraft.outFrame <= sourceFrameCount;
  const trimChanged =
    trimDraft !== null &&
    committedTrim !== null &&
    (trimDraft.inFrame !== committedTrim.inFrame || trimDraft.outFrame !== committedTrim.outFrame);
  const renderEligibility =
    state.projection === null
      ? null
      : getActiveSequenceRenderEligibility({
          revision: state.projection.revision,
          state: state.projection.state,
        });
  const renderIneligibilityReason =
    renderEligibility !== null && !renderEligibility.eligible ? renderEligibility.reason : null;
  return {
    projectPath: state.projectPath,
    projection: state.projection,
    recovery: state.recovery,
    checkpointWarning: state.checkpointWarning,
    history,
    project,
    source: state.source,
    sources: state.projection?.sources ?? [],
    sourcePath: state.sourcePath,
    preparedAsset: state.preparedAsset,
    preparedAssetsById: state.preparedAssetsById,
    preparation: state.preparation,
    projectOperation: state.projectOperation,
    render,
    destinationPending,
    destinationError,
    trimDraft,
    committedTrim,
    sourceFrameCount,
    trimValid,
    trimChanged,
    editOperation,
    canUndo: state.projection?.canUndo ?? false,
    canRedo: state.projection?.canRedo ?? false,
    renderIneligibilityReason,
    renderReady:
      renderEligibility?.eligible === true &&
      renderInputPaths(state.projection) !== null &&
      state.preparedAsset !== null,
    newProject,
    openProject,
    chooseSource,
    prepareImportedSource,
    regrantSourceAccess,
    retryPreparation,
    updateTrimDraft,
    applyTrim,
    splitTimelineClip,
    moveTimelineClip,
    trimTimelineClip,
    rippleDeleteTimelineClip,
    applyTranscriptEditProposal,
    setTimelineClipOpacity,
    setTimelineClipTransform,
    setTimelineTrackLocked,
    setTimelineTrackMuted,
    setTimelineTrackHidden,
    undoEdit,
    redoEdit,
    convertCachePath: backend.convertFileSrc,
    exportVideo,
    confirmOverwrite,
    cancelRender,
  } as const;
}
