import { selectClips, pruneSelection, type ClipSelection } from "./clip-selection";
import { MultiClipInspector } from "./MultiClipInspector";
import { ClipAudioInspector } from "./ClipAudioInspector";
import { ClipSourceRangeInspector } from "./ClipSourceRangeInspector";
import type { SelectedMediaClip } from "./clip-source-range";
import {
  clipTimelineDuration,
  microsecondsToSourceFrames,
  createRationalTime,
  rateOf,
  timelineOffsetToSource,
  isTrackHidden,
  isTrackLocked,
  isTrackMuted,
  rescaleRationalTime,
  type ProjectClip,
  type ProjectTrack,
  type VideoClip,
  type VideoProjectFileV1,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import type { MediaJobRecord } from "@supa-video/media";
import { AlertCircle, AlertTriangle, FilePlus2, FolderOpen, RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCommand, useCommandHandler } from "../commands/CommandProvider";
import { type useVideoProject } from "../use-video-project";
import { AssetPanel } from "./AssetPanel";
import { TwoPaneWorkspace } from "./TwoPaneWorkspace";
import {
  ClipInspector,
  type ClipOpacityDraft,
  type ClipTransformDraft,
  type SelectedVideoClip,
} from "./ClipInspector";
import { ClipTrimRanges } from "./ClipTrimRanges";
import { ExportPanel } from "./ExportPanel";
import { formatProjectName } from "./format-video";
import { MultitrackTimeline } from "./MultitrackTimeline";
import {
  ProgramMonitor,
  type ProgramMonitorCaption,
  type ProgramMonitorLayer,
} from "./ProgramMonitor";
import { timelineFrameForClipSourceFrame } from "./timeline-move-snap";
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

function sameRationalTime(left: VideoClip["sourceIn"], right: ProjectClip["sourceIn"]): boolean {
  return (
    left.value === right.value &&
    left.rateNumerator === right.rateNumerator &&
    left.rateDenominator === right.rateDenominator
  );
}

type CanonicalVideoTrack = Extract<ProjectTrack, { kind: "video" }>;

interface CanonicalPreviewClip {
  readonly clip: ProjectClip;
  readonly track: CanonicalVideoTrack;
}

function findCanonicalPreviewClip(
  sequence: VideoSequenceV2 | null,
  previewClip: VideoClip | null,
): CanonicalPreviewClip | null {
  if (sequence === null || previewClip === null) return null;
  const videoClips = sequence.tracks.flatMap((track) =>
    track.kind === "video" ? track.clips.map((clip) => ({ clip, track })) : [],
  );
  const idMatch = videoClips.find((candidate) => candidate.clip.id === previewClip.id);
  if (idMatch !== undefined) return idMatch;

  const sourceMatches = videoClips.filter(
    ({ clip: candidate }) =>
      candidate.source.kind === "asset" &&
      candidate.source.assetId === previewClip.assetId &&
      sameRationalTime(previewClip.sourceIn, candidate.sourceIn) &&
      sameRationalTime(previewClip.sourceOut, candidate.sourceOut),
  );
  return sourceMatches.length === 1 ? sourceMatches[0]! : null;
}

/** Resolves the legacy monitor source to its canonical clip before deriving sequence time. */
export function timelineFrameForPreviewSourceFrame(
  sequence: VideoSequenceV2 | null,
  previewClip: VideoClip | null,
  sourceFrame: number,
): number | null {
  const canonicalPreview = findCanonicalPreviewClip(sequence, previewClip);
  return canonicalPreview === null
    ? null
    : timelineFrameForClipSourceFrame(canonicalPreview.clip, sourceFrame);
}

export function activeCaptionCuesForTimelineFrame(
  sequence: VideoSequenceV2 | null,
  timelineFrame: number | null,
): readonly ProgramMonitorCaption[] {
  if (sequence === null || timelineFrame === null) return [];
  return sequence.tracks.flatMap((track) => {
    if (track.kind !== "caption" || isTrackHidden(track)) return [];
    return track.captions.flatMap((caption) => {
      const startFrame = rescaleRationalTime(caption.start, sequence.rate, "floor").value;
      const endFrameExclusive = rescaleRationalTime(caption.end, sequence.rate, "ceil").value;
      return startFrame <= timelineFrame && timelineFrame < endFrameExclusive
        ? [{ captionId: caption.id, text: caption.text }]
        : [];
    });
  });
}

export function VideoWorkspace({
  controller,
  mediaJobs,
  project,
  readiness,
  onCheckTools,
  onOpenJobCenter,
}: VideoWorkspaceProps) {
  const [playhead, setPlayhead] = useState(0);
  const [compositionPlayhead, setCompositionPlayhead] = useState<number | null>(null);
  const [selection, setSelection] = useState<ClipSelection>({ ids: [], primary: null });
  const selectedClipId = selection.primary;
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionProject = useRef<string | null>(null);
  const previousClipCount = useRef(0);
  const deleteFocus = useRef<{ ids: string; succeeded: boolean } | null>(null);
  const undoFallback = useRef<HTMLButtonElement>(null);
  const redoFocus = useRef<HTMLButtonElement>(null);
  const historyFocus = useRef<{
    action: "undo" | "redo";
    projectId: string | undefined;
    revision: number | undefined;
    pending: boolean;
  } | null>(null);
  useEffect(() => {
    const request = historyFocus.current;
    if (!request) return;
    if (request.projectId !== controller.projection?.projectId) {
      historyFocus.current = null;
      return;
    }
    if (controller.editOperation.phase === "saving") {
      request.pending = true;
      return;
    }
    if (
      !request.pending &&
      request.revision === controller.projection?.revision.number &&
      controller.editOperation.phase !== "error"
    )
      return;
    if (
      document.activeElement !== document.body &&
      document.activeElement !== undoFallback.current &&
      document.activeElement !== redoFocus.current
    ) {
      historyFocus.current = null;
      return;
    }
    const preferred = request.action === "undo" ? undoFallback.current : redoFocus.current;
    const alternative = request.action === "undo" ? redoFocus.current : undoFallback.current;
    if (preferred && !preferred.disabled) {
      historyFocus.current = null;
      preferred.focus();
    } else if (alternative && !alternative.disabled) {
      historyFocus.current = null;
      alternative.focus();
    }
  });
  const [, refreshDeleteFocus] = useState(0);
  useEffect(() => {
    const pending = deleteFocus.current;
    if (!pending) return;
    if (selection.ids.length && selection.ids.join(",") !== pending.ids) deleteFocus.current = null;
    else if (
      !selection.ids.length &&
      pending.succeeded &&
      undoFallback.current &&
      !undoFallback.current.disabled
    ) {
      undoFallback.current.focus();
      deleteFocus.current = null;
    }
  });
  const setSelectedClipId = (id: string) => {
    setSelection({ ids: [id], primary: id });
    setSelectionError(null);
  };
  const [selectedClipOpacityDraft, setSelectedClipOpacityDraft] = useState<ClipOpacityDraft | null>(
    null,
  );
  const [selectedClipTransformDraft, setSelectedClipTransformDraft] =
    useState<ClipTransformDraft | null>(null);
  const opacityCommitPending = useRef(false);
  const transformCommitPending = useRef(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const reconciledPreparationJobs = useRef(new Set<string>());
  const undoCommand = useCommand("history.undo");
  const redoCommand = useCommand("history.redo");
  const newProjectCommand = useCommand("project.new");
  const openProjectCommand = useCommand("project.open");
  const revision = project.revisions[0]!;
  const asset = revision.state.asset;
  const sequence = revision.state.sequence;
  const clip = sequence?.videoTracks[0]?.clips[0];
  const canonicalSequence =
    controller.projection?.state.sequences.find(
      (candidate) => candidate.id === controller.projection?.state.activeSequenceId,
    ) ?? null;
  const orderedMediaIds =
    canonicalSequence?.tracks.flatMap((track) =>
      track.kind === "caption"
        ? []
        : [...track.clips]
            .sort((a, b) => a.timelineStart.value - b.timelineStart.value)
            .filter((clip) => clip.source.kind === "asset")
            .map((clip) => clip.id),
    ) ?? [];
  const bulkTargets =
    canonicalSequence?.tracks.flatMap((track) =>
      track.kind === "caption"
        ? []
        : track.clips
            .filter((clip) => selection.ids.includes(clip.id) && clip.source.kind === "asset")
            .map((clip) => ({
              sequenceId: canonicalSequence.id,
              trackId: track.id,
              clipId: clip.id,
              duration: clipTimelineDuration(
                { in: clip.sourceIn, out: clip.sourceOut },
                canonicalSequence.rate,
                clip.speed,
              ).value,
              gainMilliDecibels: clip.gainMilliDecibels,
              fades: clip.fades ?? { inFrames: 0, outFrames: 0 },
              isVideo: track.kind === "video",
              ...(clip.speed ? { speed: clip.speed } : {}),
              locked: isTrackLocked(track),
              hasAudio:
                controller.projection?.state.assets.some(
                  (asset) =>
                    clip.source.kind === "asset" &&
                    asset.id === clip.source.assetId &&
                    !!asset.probe.audio,
                ) ?? false,
            })),
    ) ?? [];
  const multiSelected = selection.ids.length > 1;
  const canonicalPreview = findCanonicalPreviewClip(canonicalSequence, clip ?? null);
  const selectedSourceClip = useMemo(() => {
    if (!canonicalSequence) return null;
    for (const track of canonicalSequence.tracks) {
      if (track.kind === "caption") continue;
      const clip = track.clips.find(({ id }) => id === selectedClipId);
      if (!clip) continue;
      if (clip.source.kind !== "asset") return "nested" as const;
      const asset = controller.projection?.state.assets.find(
        ({ id }) => clip.source.kind === "asset" && id === clip.source.assetId,
      );
      if (!asset) return null;
      return {
        sequenceId: canonicalSequence.id,
        trackId: track.id,
        clipId: clip.id,
        label: asset.displayName,
        locked: isTrackLocked(track),
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
        totalAssetFrames: microsecondsToSourceFrames(
          asset.probe.durationMicroseconds,
          rateOf(clip.sourceIn),
        ).value,
        timelineStartFrame: clip.timelineStart.value,
        sequenceRate: canonicalSequence.rate,
        ...(clip.speed === undefined ? {} : { speed: clip.speed }),
        ...(clip.fades === undefined ? {} : { fades: clip.fades }),
      } satisfies SelectedMediaClip;
    }
    return null;
  }, [canonicalSequence, selectedClipId, controller.projection]);
  const selectedAudioClip = useMemo(() => {
    if (!canonicalSequence) return null;
    for (const track of canonicalSequence.tracks) {
      if (track.kind === "caption") continue;
      const clip = track.clips.find(({ id }) => id === selectedClipId);
      if (!clip || clip.source.kind !== "asset") continue;
      const asset = controller.projection?.state.assets.find(
        ({ id }) => clip.source.kind === "asset" && id === clip.source.assetId,
      );
      if (!asset?.probe.audio) continue;
      return {
        sequenceId: canonicalSequence.id,
        trackId: track.id,
        clipId: clip.id,
        gainMilliDecibels: clip.gainMilliDecibels,
        fades: clip.fades ?? { inFrames: 0, outFrames: 0 },
        duration: clipTimelineDuration(
          { in: clip.sourceIn, out: clip.sourceOut },
          canonicalSequence.rate,
          clip.speed,
        ).value,
        locked: isTrackLocked(track),
        label: asset.displayName,
      };
    }
    return null;
  }, [canonicalSequence, selectedClipId, controller.projection]);
  const selectedVideoClip = useMemo<SelectedVideoClip | null>(() => {
    if (canonicalSequence === null || selectedClipId === null) return null;
    for (const track of canonicalSequence.tracks) {
      if (track.kind !== "video") continue;
      const selectedClip = track.clips.find((candidate) => candidate.id === selectedClipId);
      if (selectedClip === undefined) continue;
      const selectedAssetId =
        selectedClip.source.kind === "asset" ? selectedClip.source.assetId : null;
      const selectedAsset = controller.projection?.state.assets.find(
        (candidate) => candidate.id === selectedAssetId,
      );
      return {
        sequenceId: canonicalSequence.id,
        trackId: track.id,
        clipId: selectedClip.id,
        speedTiming: {
          ...(selectedClip.speed === undefined ? {} : { speed: selectedClip.speed }),
          sourceIn: selectedClip.sourceIn,
          sourceOut: selectedClip.sourceOut,
          sequenceRate: canonicalSequence.rate,
        },
        clipLabel: selectedAsset?.displayName ?? "Video clip",
        trackLabel: track.name,
        transform: selectedClip.transform,
        opacityPermille: selectedClip.transform.opacityPermille,
        locked: isTrackLocked(track),
      };
    }
    return null;
  }, [canonicalSequence, controller.projection?.state.assets, selectedClipId]);
  const inspectedTransform =
    selectedVideoClip !== null &&
    selectedClipTransformDraft?.sequenceId === selectedVideoClip.sequenceId &&
    selectedClipTransformDraft.trackId === selectedVideoClip.trackId &&
    selectedClipTransformDraft.clipId === selectedVideoClip.clipId
      ? selectedClipTransformDraft.transform
      : (selectedVideoClip?.transform ?? null);
  const inspectedOpacityPermille =
    selectedVideoClip !== null &&
    selectedClipOpacityDraft?.sequenceId === selectedVideoClip.sequenceId &&
    selectedClipOpacityDraft.trackId === selectedVideoClip.trackId &&
    selectedClipOpacityDraft.clipId === selectedVideoClip.clipId
      ? selectedClipOpacityDraft.opacityPermille
      : (selectedVideoClip?.opacityPermille ?? null);
  const timelineAudioMuted =
    canonicalPreview === null ? false : isTrackMuted(canonicalPreview.track);
  const timelineVideoHidden =
    canonicalPreview === null ? false : isTrackHidden(canonicalPreview.track);
  const speedPreviewUnsupported = useMemo(
    () =>
      canonicalSequence?.tracks.some(
        (track) =>
          track.kind !== "caption" &&
          track.clips.some(
            (clip) =>
              clip.speed !== undefined &&
              clip.speed.numerator !== clip.speed.denominator &&
              clip.source.kind !== "asset",
          ),
      ) ?? false,
    [canonicalSequence],
  );
  const sourceLayers = useMemo<readonly ProgramMonitorLayer[]>(() => {
    if (canonicalSequence === null || controller.projection === null) return [];
    const assets = new Map(controller.projection.state.assets.map((item) => [item.id, item]));
    return canonicalSequence.tracks.flatMap((track, canonicalTrackIndex) => {
      if (track.kind === "caption") return [];
      return track.clips.flatMap((canonicalClip) => {
        if (canonicalClip.source.kind !== "asset") return [];
        const canonicalAsset = assets.get(canonicalClip.source.assetId);
        const path = controller.preparedAssetsById[canonicalClip.source.assetId]?.proxyPath ?? null;
        if (canonicalAsset === undefined || path === null) return [];
        const transformDraftMatches =
          selectedClipTransformDraft?.sequenceId === canonicalSequence.id &&
          selectedClipTransformDraft.trackId === track.id &&
          selectedClipTransformDraft.clipId === canonicalClip.id;
        const previewTransform = transformDraftMatches
          ? selectedClipTransformDraft.transform
          : canonicalClip.transform;
        return [
          {
            clipId: canonicalClip.id,
            audioOnly: track.kind === "audio",
            path,
            canonicalTrackIndex,
            timelineStartFrame: canonicalClip.timelineStart.value,
            sourceInFrame: canonicalClip.sourceIn.value,
            sourceOutFrame: canonicalClip.sourceOut.value,
            sourceRate: rateOf(canonicalClip.sourceIn),
            ...(canonicalClip.speed === undefined ? {} : { speed: canonicalClip.speed }),
            timelineDurationFrames: clipTimelineDuration(
              { in: canonicalClip.sourceIn, out: canonicalClip.sourceOut },
              canonicalSequence.rate,
              canonicalClip.speed,
            ).value,
            positionXPermille: previewTransform.positionXPermille,
            positionYPermille: previewTransform.positionYPermille,
            scaleXPermille: previewTransform.scaleXPermille,
            scaleYPermille: previewTransform.scaleYPermille,
            rotationMilliDegrees: previewTransform.rotationMilliDegrees,
            opacityPermille:
              selectedClipOpacityDraft?.sequenceId === canonicalSequence.id &&
              selectedClipOpacityDraft.trackId === track.id &&
              selectedClipOpacityDraft.clipId === selectedClipId &&
              selectedClipOpacityDraft.clipId === canonicalClip.id &&
              Number.isInteger(selectedClipOpacityDraft.opacityPermille) &&
              selectedClipOpacityDraft.opacityPermille >= 0 &&
              selectedClipOpacityDraft.opacityPermille <= 1_000
                ? selectedClipOpacityDraft.opacityPermille
                : previewTransform.opacityPermille,
            hidden: isTrackHidden(track),
            muted: isTrackMuted(track),
            hasAudio: canonicalAsset.probe.audio !== null,
            gainMilliDecibels: canonicalClip.gainMilliDecibels,
            fades: canonicalClip.fades ?? { inFrames: 0, outFrames: 0 },
          },
        ];
      });
    });
  }, [
    canonicalSequence,
    controller.preparedAssetsById,
    controller.projection,
    selectedClipId,
    selectedClipOpacityDraft,
    selectedClipTransformDraft,
  ]);
  const sourceHasAudio = sourceLayers.some((layer) => layer.hasAudio && !layer.muted);
  const legacyTimelinePlayheadFrame = timelineFrameForPreviewSourceFrame(
    canonicalSequence,
    clip ?? null,
    playhead,
  );
  const previewClockLayer = sourceLayers.find(
    (layer) => layer.clipId === canonicalPreview?.clip.id,
  );
  const previewClockIsVisible =
    legacyTimelinePlayheadFrame !== null &&
    previewClockLayer !== undefined &&
    !previewClockLayer.hidden &&
    previewClockLayer.timelineStartFrame <= legacyTimelinePlayheadFrame &&
    legacyTimelinePlayheadFrame <
      previewClockLayer.timelineStartFrame +
        (previewClockLayer.timelineDurationFrames ??
          previewClockLayer.sourceOutFrame - previewClockLayer.sourceInFrame);
  // Hidden and logical audio clips still own timeline/seek boundaries.
  const visibleSourceLayers = sourceLayers;
  const visibleTimelineStart =
    visibleSourceLayers.length === 0
      ? null
      : Math.min(...visibleSourceLayers.map((layer) => layer.timelineStartFrame));
  const visibleTimelineEnd =
    visibleSourceLayers.length === 0
      ? null
      : Math.max(
          ...visibleSourceLayers.map(
            (layer) =>
              layer.timelineStartFrame +
              (layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame),
          ),
        );
  const compositionPlayheadIsInRange =
    compositionPlayhead !== null &&
    visibleTimelineStart !== null &&
    visibleTimelineEnd !== null &&
    visibleTimelineStart <= compositionPlayhead &&
    compositionPlayhead < visibleTimelineEnd;
  const timelinePlayheadFrame = compositionPlayheadIsInRange
    ? compositionPlayhead
    : previewClockIsVisible
      ? legacyTimelinePlayheadFrame
      : visibleTimelineStart;
  const hasVisiblePlaybackClock = visibleSourceLayers.some(
    (layer) =>
      timelinePlayheadFrame !== null &&
      layer.timelineStartFrame <= timelinePlayheadFrame &&
      timelinePlayheadFrame <
        layer.timelineStartFrame +
          (layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame),
  );
  const activeCaptions = useMemo(
    () =>
      hasVisiblePlaybackClock
        ? activeCaptionCuesForTimelineFrame(canonicalSequence, timelinePlayheadFrame)
        : [],
    [canonicalSequence, hasVisiblePlaybackClock, timelinePlayheadFrame],
  );
  const draft = controller.trimDraft;
  const durationFrames = controller.sourceFrameCount ?? 1;
  const editPending = controller.editOperation.phase === "saving";
  const appearanceSaving =
    controller.editOperation.phase === "saving" &&
    (controller.editOperation.operation === "clip-opacity" ||
      controller.editOperation.operation === "clip-transform");
  const appearanceError =
    controller.editOperation.phase === "error" &&
    (controller.editOperation.operation === "clip-opacity" ||
      controller.editOperation.operation === "clip-transform")
      ? controller.editOperation.error
      : null;
  const projectPending = controller.projectOperation.phase === "pending";
  useCommandHandler("history.undo", {
    canExecute: controller.projection !== null && controller.canUndo && !editPending,
    execute: () => controller.undoEdit(),
  });
  useCommandHandler("history.redo", {
    canExecute: controller.projection !== null && controller.canRedo && !editPending,
    execute: () => controller.redoEdit(),
  });
  useCommandHandler("view.toggleProjectInspector", {
    canExecute: controller.projection !== null,
    execute: (source) => {
      if (inspectorOpen) {
        setInspectorOpen(false);
        queueMicrotask(() => inspectorReturnFocus.current?.focus());
        return;
      }
      inspectorReturnFocus.current =
        source === "button"
          ? inspectorToggleRef.current
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      setInspectorOpen(true);
    },
  });
  const inspectorCommand = useCommand("view.toggleProjectInspector");
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
    const clipIds = selectableClipIds(canonicalSequence ?? undefined);
    const projectId = controller.projection?.projectId ?? null;
    if (
      selectionProject.current !== projectId ||
      (previousClipCount.current === 0 && clipIds.length > 0)
    ) {
      selectionProject.current = projectId;
      setSelection({ ids: clipIds[0] ? [clipIds[0]] : [], primary: clipIds[0] ?? null });
    } else setSelection((current) => pruneSelection(current, clipIds));
    previousClipCount.current = clipIds.length;
  }, [canonicalSequence]);

  useEffect(() => {
    setSelectedClipOpacityDraft(null);
    setSelectedClipTransformDraft(null);
  }, [
    controller.projection?.revision.id,
    selectedVideoClip?.clipId,
    selectedVideoClip?.opacityPermille,
    selectedVideoClip?.sequenceId,
    selectedVideoClip?.trackId,
  ]);

  const commitClipOpacity = async (opacityDraft: ClipOpacityDraft) => {
    if (opacityCommitPending.current) return;
    opacityCommitPending.current = true;
    try {
      await controller.setTimelineClipOpacity(opacityDraft);
    } finally {
      setSelectedClipOpacityDraft((current) =>
        current?.sequenceId === opacityDraft.sequenceId &&
        current.trackId === opacityDraft.trackId &&
        current.clipId === opacityDraft.clipId
          ? null
          : current,
      );
      opacityCommitPending.current = false;
    }
  };

  const commitClipTransform = async (transformDraft: ClipTransformDraft) => {
    if (transformCommitPending.current) return;
    transformCommitPending.current = true;
    try {
      const committed = await controller.setTimelineClipTransform(transformDraft);
      if (!committed) return;
      setSelectedClipTransformDraft((current) =>
        current?.sequenceId === transformDraft.sequenceId &&
        current.trackId === transformDraft.trackId &&
        current.clipId === transformDraft.clipId
          ? null
          : current,
      );
    } finally {
      transformCommitPending.current = false;
    }
  };

  useEffect(() => {
    if (preparationJob?.state !== "complete" || controller.preparation.phase === "success") return;
    const reconciliationKey = `${preparationJob.id}:${preparationJob.updatedAt}`;
    if (reconciledPreparationJobs.current.has(reconciliationKey)) return;
    reconciledPreparationJobs.current.add(reconciliationKey);
    void controller.retryPreparation();
  }, [controller.preparation.phase, controller.retryPreparation, preparationJob]);

  const sourceStatus = useMemo(() => {
    if (controller.source === null) return "No source";
    if (controller.source.status === "resolved") return "Source ready";
    if (controller.source.status === "missing") return "Source missing";
    return "Relink required";
  }, [controller.source]);

  return (
    <main
      className="video-workspace shared-rail"
      id="workspace"
      tabIndex={-1}
      onPointerDownCapture={() => {
        historyFocus.current = null;
      }}
    >
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
            disabled={!newProjectCommand.canExecute}
            aria-keyshortcuts={newProjectCommand.ariaKeyShortcuts}
            onClick={newProjectCommand.execute}
          >
            <FilePlus2 size={16} aria-hidden />
            New
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={!openProjectCommand.canExecute}
            aria-keyshortcuts={openProjectCommand.ariaKeyShortcuts}
            onClick={openProjectCommand.execute}
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
        ref={inspectorToggleRef}
        className="sr-only inspector-toggle"
        type="button"
        disabled={!inspectorCommand.canExecute}
        aria-keyshortcuts={inspectorCommand.ariaKeyShortcuts}
        onClick={inspectorCommand.execute}
      >
        Toggle project diagnostics
      </button>

      {inspectorOpen && controller.projection !== null ? (
        <ProjectInspector projection={controller.projection} recovery={controller.recovery} />
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

      <TwoPaneWorkspace label="Program and media / editing controls pane width">
        <div className="monitor-column">
          {sequence !== null && clip !== undefined && draft !== null ? (
            <ProgramMonitor
              unsupportedReason={
                speedPreviewUnsupported
                  ? "Retimed nested sequences and dedicated audio tracks are not supported in program preview."
                  : null
              }
              proxyPath={controller.preparedAsset?.proxyPath ?? null}
              finalPreviewPath={finalPreviewPath}
              hasAudio={sourceHasAudio}
              timelineAudioMuted={timelineAudioMuted}
              timelineVideoHidden={timelineVideoHidden}
              sourceLayers={sourceLayers}
              activeCaptions={activeCaptions}
              convertCachePath={controller.convertCachePath}
              rate={sequence.rate}
              trimIn={draft.inFrame}
              trimOut={draft.outFrame}
              playhead={sourceLayers.length > 0 ? (timelinePlayheadFrame ?? 0) : playhead}
              onPlayheadChange={(frame) => {
                if (sourceLayers.length === 0) {
                  setPlayhead(frame);
                  return;
                }
                setCompositionPlayhead(frame);
                if (canonicalPreview === null) return;
                const previewSourceFrame =
                  canonicalPreview.clip.sourceIn.value +
                  timelineOffsetToSource(
                    createRationalTime(
                      Math.max(0, frame - canonicalPreview.clip.timelineStart.value),
                      canonicalSequence!.rate,
                    ),
                    rateOf(canonicalPreview.clip.sourceIn),
                    canonicalPreview.clip.speed,
                    "floor",
                  ).value;
                if (
                  timelineFrameForClipSourceFrame(canonicalPreview.clip, previewSourceFrame) ===
                  frame
                ) {
                  setPlayhead(previewSourceFrame);
                }
              }}
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
          {controller.projection !== null && canonicalSequence !== null ? (
            <MultitrackTimeline
              projection={controller.projection}
              preparedAsset={controller.preparedAsset}
              convertCachePath={controller.convertCachePath}
              selectedClipId={multiSelected ? null : selectedClipId}
              selectedClipIds={selection.ids}
              onSelectMediaClip={(id, mode) => {
                try {
                  deleteFocus.current = null;
                  setSelection(selectClips(selection, id, orderedMediaIds, mode));
                  setSelectionError(null);
                } catch (error) {
                  setSelectionError((error as Error).message);
                }
              }}
              previewSourceFrame={playhead}
              timelinePlayheadFrame={timelinePlayheadFrame}
              editPending={editPending}
              editError={
                controller.editOperation.phase === "error" ? controller.editOperation.error : null
              }
              onSelectClip={setSelectedClipId}
              onSetTrackLocked={(trackId, locked) =>
                void controller.setTimelineTrackLocked({ trackId, locked })
              }
              onSetTrackMuted={(trackId, muted) =>
                void controller.setTimelineTrackMuted({ trackId, muted })
              }
              onSetTrackHidden={(trackId, hidden) =>
                void controller.setTimelineTrackHidden({ trackId, hidden })
              }
              onSplitClip={(clipId, sourceFrame) =>
                void controller.splitTimelineClip({ clipId, sourceFrame })
              }
              onRippleDeleteClip={(clipId) => void controller.rippleDeleteTimelineClip({ clipId })}
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

        <aside className="inspector-column" aria-label="Editing controls">
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
          <div className="history-actions" role="group" aria-label="Edit history">
            <button
              type="button"
              ref={undoFallback}
              disabled={!undoCommand.canExecute}
              aria-keyshortcuts={undoCommand.ariaKeyShortcuts}
              onClick={(event) => {
                if (event.detail === 0)
                  historyFocus.current = {
                    action: "undo",
                    projectId: controller.projection?.projectId,
                    revision: controller.projection?.revision.number,
                    pending: false,
                  };
                undoCommand.execute();
              }}
            >
              Undo
            </button>
            <button
              type="button"
              ref={redoFocus}
              disabled={!redoCommand.canExecute}
              aria-keyshortcuts={redoCommand.ariaKeyShortcuts}
              onClick={(event) => {
                if (event.detail === 0)
                  historyFocus.current = {
                    action: "redo",
                    projectId: controller.projection?.projectId,
                    revision: controller.projection?.revision.number,
                    pending: false,
                  };
                redoCommand.execute();
              }}
            >
              Redo
            </button>
          </div>
          <p role="status" aria-live="polite">
            {selection.ids.length} clips selected (maximum 100)
          </p>
          <button
            type="button"
            onClick={() => {
              deleteFocus.current = null;
              setSelection({ ids: [], primary: null });
              setSelectionError(null);
            }}
          >
            Clear selection
          </button>
          {selectionError ? <p role="alert">{selectionError}</p> : null}
          {multiSelected ? (
            <MultiClipInspector
              key={selection.ids.join(",")}
              revisionKey={controller.projection?.revision.id ?? "none"}
              targets={bulkTargets}
              disabled={editPending}
              error={
                controller.editOperation.phase === "error" ? controller.editOperation.error : null
              }
              onBulk={async (action, keyboard) => {
                const record =
                  action.type === "delete" && keyboard
                    ? { ids: selection.ids.join(","), succeeded: false }
                    : null;
                deleteFocus.current = record;
                const success = await controller.editTimelineClips(bulkTargets, action);
                if (deleteFocus.current === record && record) {
                  record.succeeded = success;
                  refreshDeleteFocus((value) => value + 1);
                  if (!success) deleteFocus.current = null;
                }
                return success;
              }}
              onApply={(inputs) => controller.setTimelineClipAudio(inputs)}
            />
          ) : (
            <>
              <ClipAudioInspector
                selection={selectedAudioClip}
                revisionKey={controller.projection?.revision.id ?? "none"}
                disabled={editPending}
                saving={controller.editOperation.phase === "saving"}
                error={
                  controller.editOperation.phase === "error" &&
                  controller.editOperation.operation === "clip-audio"
                    ? controller.editOperation.error
                    : null
                }
                onCommit={(input) => {
                  if (!editPending) void controller.setTimelineClipAudio([input]);
                }}
              />
              <ClipSourceRangeInspector
                selection={selectedSourceClip === "nested" ? null : selectedSourceClip}
                unsupported={selectedSourceClip === "nested"}
                revisionKey={controller.projection?.revision.id ?? "none"}
                disabled={editPending}
                saving={controller.editOperation.phase === "saving"}
                error={
                  controller.editOperation.phase === "error" &&
                  controller.editOperation.operation === "trim"
                    ? controller.editOperation.error
                    : null
                }
                onCommit={(input) => {
                  if (!editPending) void controller.trimTimelineClip(input);
                }}
              />
              <ClipInspector
                revisionKey={controller.projection?.revision.id ?? "none"}
                speedSaving={
                  controller.editOperation.phase === "saving" &&
                  controller.editOperation.operation === "clip-speed"
                }
                speedError={
                  controller.editOperation.phase === "error" &&
                  controller.editOperation.operation === "clip-speed"
                    ? controller.editOperation.error
                    : null
                }
                onSpeedCommit={(input) => {
                  if (!editPending) void controller.setTimelineClipSpeed(input);
                }}
                selection={selectedVideoClip}
                transform={inspectedTransform}
                opacityPermille={inspectedOpacityPermille}
                disabled={editPending}
                saving={appearanceSaving}
                error={appearanceError}
                onDraftChange={setSelectedClipOpacityDraft}
                onCommit={(opacityDraft) => void commitClipOpacity(opacityDraft)}
                onTransformDraftChange={setSelectedClipTransformDraft}
                onTransformCommit={(transformDraft) => void commitClipTransform(transformDraft)}
              />
              {draft !== null && selectedSourceClip === null ? (
                <TrimInspector
                  showHistoryActions={false}
                  inFrame={draft.inFrame}
                  outFrame={draft.outFrame}
                  durationFrames={durationFrames}
                  valid={controller.trimValid}
                  changed={controller.trimChanged}
                  operation={controller.editOperation}
                  onInFrameChange={(inFrame) => controller.updateTrimDraft({ inFrame })}
                  onOutFrameChange={(outFrame) => controller.updateTrimDraft({ outFrame })}
                  onApply={() => void controller.applyTrim()}
                />
              ) : null}
            </>
          )}
          <ExportPanel
            render={controller.render}
            renderJob={renderJob}
            readiness={readiness}
            destinationPending={controller.destinationPending}
            destinationError={controller.destinationError}
            ineligibilityReason={
              controller.renderReady ? null : controller.renderIneligibilityReason
            }
            disabled={!controller.renderReady || controller.trimChanged || editPending}
            onExport={() => void controller.exportVideo()}
            onCancel={() => void controller.cancelRender()}
            onConfirmOverwrite={() => void controller.confirmOverwrite()}
            onOpenJobCenter={onOpenJobCenter}
          />
        </aside>
      </TwoPaneWorkspace>
    </main>
  );
}
