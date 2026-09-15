import {
  createRationalTime,
  createTimelineViewport,
  frameToPixel,
  pixelToFrame,
  type ProjectClip,
  type ProjectProjection,
  type TimelineViewport,
} from "@supa-video/contracts";
import { deriveActiveTimelineRange, projectVisibleTimeline } from "@supa-video/project";
import type { PreparedVideoAsset } from "@supa-video/media";
import {
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Music2,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";

import { useCommand, useCommandHandler } from "../commands/CommandProvider";
import { minimumTimelineTrimStart, sourceFrameAtTimelineDelta } from "./timeline-trim-mapping";

import {
  createTimelineMoveSnapContext,
  resolveTimelineMoveSnap,
  type TimelineMoveSnapContext,
  type TimelineMoveSnapGuide,
} from "./timeline-move-snap";

interface MultitrackTimelineProps {
  readonly projection: ProjectProjection;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly convertCachePath: (path: string) => string;
  readonly selectedClipId: string | null;
  readonly selectedClipIds?: readonly string[];
  readonly onSelectMediaClip?: (clipId: string, mode: "replace" | "toggle" | "range") => void;
  readonly previewSourceFrame: number;
  readonly timelinePlayheadFrame: number | null;
  readonly editPending: boolean;
  readonly editError: Error | null;
  readonly onSelectClip: (clipId: string) => void;
  readonly onSetTrackLocked: (trackId: string, locked: boolean) => void;
  readonly onSetTrackMuted: (trackId: string, muted: boolean) => void;
  readonly onSetTrackHidden?: (trackId: string, hidden: boolean) => void;
  readonly onSplitClip: (clipId: string, sourceFrame: number) => void;
  readonly onRippleDeleteClip: (clipId: string) => void;
  readonly onMoveClip: (clipId: string, timelineStartFrame: number) => void;
  readonly onTrimClip: (
    clipId: string,
    sourceInFrame: number,
    sourceOutFrame: number,
    timelineStartFrame: number,
  ) => void;
}

interface CanonicalTimelineClip {
  readonly clip: ProjectClip;
  readonly trackId: string;
  readonly trackLocked: boolean;
}

type PointerMode = "move" | "trim-left" | "trim-right";

interface PointerSession {
  readonly originClip: ProjectClip;
  readonly valid: boolean;
  readonly pointerId: number;
  readonly clipId: string;
  readonly destinationTrackId: string;
  readonly mode: PointerMode;
  readonly originClientX: number;
  readonly originStartFrame: number;
  readonly originEndFrameExclusive: number;
  readonly originSourceInFrame: number;
  readonly originSourceOutFrame: number;
  readonly draftStartFrame: number;
  readonly draftEndFrameExclusive: number;
  readonly draftSourceInFrame: number;
  readonly draftSourceOutFrame: number;
  readonly moveSnapContext: TimelineMoveSnapContext | null;
  readonly snapGuide: TimelineMoveSnapGuide | null;
}

const MIN_PIXELS_PER_FRAME = 4;
const MAX_TIMELINE_WIDTH = 2_000_000;
const VIEWPORT_OVERSCAN_PIXELS = 160;
const MOVE_SNAP_DISTANCE_PIXELS = 8;
const MIN_VIEWPORT_WIDTH = 1;

function positiveWidth(width: number): number {
  return Math.max(MIN_VIEWPORT_WIDTH, Math.floor(width));
}

function zoomForRange(frameCount: number) {
  if (frameCount <= 0) return { numerator: MIN_PIXELS_PER_FRAME, denominator: 1 } as const;
  const maximumScale = Math.max(1, Math.floor(MAX_TIMELINE_WIDTH / frameCount));
  return { numerator: Math.min(MIN_PIXELS_PER_FRAME, maximumScale), denominator: 1 } as const;
}

function createGeometryViewport(
  projection: ProjectProjection,
  viewportWidthPixels: number,
  scrollLeftPixels: number,
): TimelineViewport | null {
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) return null;
  const range = deriveActiveTimelineRange(projection);
  const zoomScale = zoomForRange(range.endFrameExclusive - range.startFrame);
  const geometryViewport = createTimelineViewport({
    frameRate: sequence.rate,
    zoomScale,
    scrollOrigin: createRationalTime(0, sequence.rate),
    viewportWidthPixels: positiveWidth(viewportWidthPixels),
    overscanPixels: VIEWPORT_OVERSCAN_PIXELS,
    timelineRange: { start: range.startFrame, endExclusive: range.endFrameExclusive },
  });
  const scrollOriginFrame = Math.max(
    range.startFrame,
    pixelToFrame(Math.max(0, scrollLeftPixels), geometryViewport, "floor"),
  );
  return createTimelineViewport({
    frameRate: sequence.rate,
    zoomScale,
    scrollOrigin: createRationalTime(scrollOriginFrame, sequence.rate),
    viewportWidthPixels: positiveWidth(viewportWidthPixels),
    overscanPixels: VIEWPORT_OVERSCAN_PIXELS,
    timelineRange: { start: range.startFrame, endExclusive: range.endFrameExclusive },
  });
}

function canonicalTimelineClip(
  projection: ProjectProjection,
  clipId: string | null,
): CanonicalTimelineClip | null {
  if (clipId === null) return null;
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) return null;
  for (const track of sequence.tracks) {
    if (track.kind === "caption") continue;
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) {
      return { clip, trackId: track.id, trackLocked: track.locked ?? false };
    }
  }
  return null;
}

function pointerCaptureTarget(element: HTMLElement) {
  return element as HTMLElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
}

function supportsTimelineFrameDeltaTrim(clip: ProjectClip): boolean {
  return (
    (clip.sourceIn.rateNumerator === clip.timelineStart.rateNumerator &&
      clip.sourceIn.rateDenominator === clip.timelineStart.rateDenominator) ||
    (clip.speed !== undefined && clip.speed.numerator !== clip.speed.denominator)
  );
}

export function MultitrackTimeline({
  projection,
  preparedAsset,
  convertCachePath,
  selectedClipId,
  selectedClipIds,
  onSelectMediaClip,
  previewSourceFrame,
  timelinePlayheadFrame,
  editPending,
  editError,
  onSelectClip,
  onSetTrackLocked,
  onSetTrackMuted,
  onSetTrackHidden,
  onSplitClip,
  onRippleDeleteClip,
  onMoveClip,
  onTrimClip,
}: MultitrackTimelineProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const restoreFocusAfterRippleDeleteRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(960);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pointerSession, setPointerSession] = useState<PointerSession | null>(null);
  const [pointerEditError, setPointerEditError] = useState<string | null>(null);

  const updatePointerSession = useCallback((next: PointerSession | null) => {
    pointerSessionRef.current = next;
    setPointerSession(next);
  }, []);

  useEffect(() => {
    const region = scrollRegionRef.current;
    if (region === null) return;
    const update = () => setViewportWidth(positiveWidth(region.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    updatePointerSession(null);
    setPointerEditError(null);
  }, [projection, selectedClipId, updatePointerSession]);

  const geometryViewport = useMemo(
    () => createGeometryViewport(projection, viewportWidth, 0),
    [projection, viewportWidth],
  );
  const viewport = useMemo(
    () => createGeometryViewport(projection, viewportWidth, scrollLeft),
    [projection, scrollLeft, viewportWidth],
  );
  const timeline = useMemo(
    () => (viewport === null ? null : projectVisibleTimeline(projection, viewport)),
    [projection, viewport],
  );
  const selectedCanonicalClip = useMemo(
    () => canonicalTimelineClip(projection, selectedClipId),
    [projection, selectedClipId],
  );

  useEffect(() => {
    if (!restoreFocusAfterRippleDeleteRef.current || editPending || panelRef.current === null) {
      return;
    }
    if (selectedClipId === null) {
      scrollRegionRef.current?.focus();
      restoreFocusAfterRippleDeleteRef.current = false;
      return;
    }
    if (selectedCanonicalClip === null) return;
    const selectedClip = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>("[data-clip-id]"),
    ).find((clip) => clip.dataset.clipId === selectedClipId);
    const selectedClipBody = selectedClip?.querySelector<HTMLElement>(".multitrack-clip-body");
    if (selectedClipBody === undefined || selectedClipBody === null) return;
    selectedClipBody.focus();
    restoreFocusAfterRippleDeleteRef.current = false;
  }, [editPending, selectedCanonicalClip, selectedClipId]);
  const thumbnailSource = useMemo(
    () =>
      preparedAsset === null
        ? null
        : {
            sourceUrl: convertCachePath(preparedAsset.thumbnailPath),
            identity: preparedAsset.sourceIdentity,
          },
    [convertCachePath, preparedAsset],
  );

  const canRippleDelete =
    selectedCanonicalClip !== null &&
    !selectedCanonicalClip.trackLocked &&
    !editPending &&
    pointerSession === null;
  const selectedTimelineClip =
    timeline?.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.clipId === selectedClipId) ?? null;
  const canMoveSelectedClip =
    canRippleDelete && selectedTimelineClip !== null && geometryViewport !== null;
  const canMoveSelectedClipBackward = canMoveSelectedClip && selectedTimelineClip.startFrame > 0;
  const canSplit =
    canRippleDelete &&
    previewSourceFrame > selectedCanonicalClip.clip.sourceIn.value &&
    previewSourceFrame < selectedCanonicalClip.clip.sourceOut.value;
  const moveSelectedClipByFrames = (frameDelta: -1 | 1) => {
    if (
      !canMoveSelectedClip ||
      selectedClipId === null ||
      selectedCanonicalClip === null ||
      selectedTimelineClip === null ||
      geometryViewport === null
    )
      return;
    const sequence = projection.state.sequences.find(
      (candidate) => candidate.id === projection.state.activeSequenceId,
    );
    if (sequence === undefined) return;
    const proposedStartFrame = selectedTimelineClip.startFrame + frameDelta;
    if (proposedStartFrame < 0) return;
    const resolution = resolveTimelineMoveSnap(
      createTimelineMoveSnapContext(sequence, timelinePlayheadFrame),
      {
        movingClipId: selectedClipId,
        destinationTrackId: selectedCanonicalClip.trackId,
        proposedStartFrame,
        durationFrames: selectedTimelineClip.endFrameExclusive - selectedTimelineClip.startFrame,
        zoomScale: geometryViewport.zoomScale,
        maximumSnapDistancePixels: 0,
      },
    );
    if (resolution.startFrame !== selectedTimelineClip.startFrame)
      onMoveClip(selectedClipId, resolution.startFrame);
  };
  const splitSelectedClip = () => {
    if (canSplit && selectedClipId !== null) onSplitClip(selectedClipId, previewSourceFrame);
  };
  const rippleDeleteSelectedClip = () => {
    if (canRippleDelete && selectedClipId !== null) {
      restoreFocusAfterRippleDeleteRef.current = true;
      onRippleDeleteClip(selectedClipId);
    }
  };
  useCommandHandler("timeline.moveSelectedClipBackward", {
    canExecute: canMoveSelectedClipBackward,
    execute: () => moveSelectedClipByFrames(-1),
    keyboardScopeRef: panelRef,
  });
  useCommandHandler("timeline.moveSelectedClipForward", {
    canExecute: canMoveSelectedClip,
    execute: () => moveSelectedClipByFrames(1),
    keyboardScopeRef: panelRef,
  });
  useCommandHandler("timeline.splitSelectedClip", {
    canExecute: canSplit,
    execute: splitSelectedClip,
    keyboardScopeRef: panelRef,
  });
  useCommandHandler("timeline.rippleDeleteSelectedClip", {
    canExecute: canRippleDelete,
    execute: rippleDeleteSelectedClip,
    keyboardScopeRef: panelRef,
  });
  const moveBackwardCommand = useCommand("timeline.moveSelectedClipBackward");
  const moveForwardCommand = useCommand("timeline.moveSelectedClipForward");
  const splitCommand = useCommand("timeline.splitSelectedClip");
  const rippleDeleteCommand = useCommand("timeline.rippleDeleteSelectedClip");
  if (timeline === null || geometryViewport === null) return null;

  const draftTimelineEnd = pointerSession?.draftEndFrameExclusive ?? 0;
  const contentWidth = Math.max(
    viewportWidth,
    frameToPixel(Math.max(timeline.range.endFrameExclusive, draftTimelineEnd), geometryViewport),
  );

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollLeft(event.currentTarget.scrollLeft);
  };

  const startPointerSession = (
    event: ReactPointerEvent<HTMLElement>,
    clipId: string,
    startFrame: number,
    endFrameExclusive: number,
    mode: PointerMode,
  ) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || (selectedClipIds?.length ?? 0) > 1 || editPending || selectedClipId !== clipId) return;
    const canonical = canonicalTimelineClip(projection, clipId);
    if (
      canonical === null ||
      canonical.trackLocked ||
      (mode !== "move" && !supportsTimelineFrameDeltaTrim(canonical.clip))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    pointerCaptureTarget(event.currentTarget).setPointerCapture?.(event.pointerId);
    const sequence = projection.state.sequences.find(
      (candidate) => candidate.id === projection.state.activeSequenceId,
    );
    setPointerEditError(null);
    updatePointerSession({
      originClip: canonical.clip,
      valid: true,
      pointerId: event.pointerId,
      clipId,
      destinationTrackId: canonical.trackId,
      mode,
      originClientX: event.clientX,
      originStartFrame: startFrame,
      originEndFrameExclusive: endFrameExclusive,
      originSourceInFrame: canonical.clip.sourceIn.value,
      originSourceOutFrame: canonical.clip.sourceOut.value,
      draftStartFrame: startFrame,
      draftEndFrameExclusive: endFrameExclusive,
      draftSourceInFrame: canonical.clip.sourceIn.value,
      draftSourceOutFrame: canonical.clip.sourceOut.value,
      moveSnapContext:
        mode === "move" && sequence !== undefined
          ? createTimelineMoveSnapContext(sequence, timelinePlayheadFrame)
          : null,
      snapGuide: null,
    });
  };

  const movePointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const current = pointerSessionRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const anchorFrame =
      current.mode === "trim-right" ? current.originEndFrameExclusive : current.originStartFrame;
    const anchorPixel = frameToPixel(anchorFrame, geometryViewport);
    const pointerFrame = pixelToFrame(
      anchorPixel + event.clientX - current.originClientX,
      geometryViewport,
      "nearestTiesAwayFromZero",
    );
    const frameDelta = pointerFrame - anchorFrame;
    let next: PointerSession;
    try {
      if (current.mode === "move") {
        const duration = current.originEndFrameExclusive - current.originStartFrame;
        const proposedStartFrame = Math.max(0, current.originStartFrame + frameDelta);
        const resolution =
          current.moveSnapContext === null
            ? { startFrame: proposedStartFrame, guide: null }
            : resolveTimelineMoveSnap(current.moveSnapContext, {
                movingClipId: current.clipId,
                destinationTrackId: current.destinationTrackId,
                proposedStartFrame,
                durationFrames: duration,
                zoomScale: geometryViewport.zoomScale,
                maximumSnapDistancePixels: MOVE_SNAP_DISTANCE_PIXELS,
              });
        next = {
          ...current,
          draftStartFrame: resolution.startFrame,
          draftEndFrameExclusive: resolution.startFrame + duration,
          snapGuide: resolution.guide,
        };
      } else if (current.mode === "trim-left") {
        const minimumStart = minimumTimelineTrimStart(current.originClip);
        const draftStartFrame = Math.min(
          current.originEndFrameExclusive - 1,
          Math.max(minimumStart, current.originStartFrame + frameDelta),
        );
        next = {
          ...current,
          draftStartFrame,
          draftSourceInFrame: sourceFrameAtTimelineDelta(
            current.originClip,
            current.originSourceInFrame,
            draftStartFrame - current.originStartFrame,
          ),
        };
      } else {
        const draftEndFrameExclusive = Math.max(
          current.originStartFrame + 1,
          current.originEndFrameExclusive + frameDelta,
        );
        next = {
          ...current,
          draftEndFrameExclusive,
          draftSourceOutFrame: sourceFrameAtTimelineDelta(
            current.originClip,
            current.originSourceOutFrame,
            draftEndFrameExclusive - current.originEndFrameExclusive,
          ),
        };
      }
      updatePointerSession({ ...next, valid: true });
      setPointerEditError(null);
    } catch (error) {
      updatePointerSession({ ...current, valid: false });
      setPointerEditError(error instanceof Error ? error.message : "Trim boundary is invalid");
    }
  };

  const finishPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const completed = pointerSessionRef.current;
    if (completed === null || completed.pointerId !== event.pointerId) return;
    pointerCaptureTarget(event.currentTarget).releasePointerCapture?.(event.pointerId);
    updatePointerSession(null);
    if (!completed.valid) return;
    if (completed.mode === "move") {
      if (completed.draftStartFrame !== completed.originStartFrame)
        onMoveClip(completed.clipId, completed.draftStartFrame);
      return;
    }
    if (
      completed.draftStartFrame !== completed.originStartFrame ||
      completed.draftEndFrameExclusive !== completed.originEndFrameExclusive
    )
      onTrimClip(
        completed.clipId,
        completed.draftSourceInFrame,
        completed.draftSourceOutFrame,
        completed.draftStartFrame,
      );
  };

  const cancelPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const cancelled = pointerSessionRef.current;
    if (cancelled === null || cancelled.pointerId !== event.pointerId) return;
    pointerCaptureTarget(event.currentTarget).releasePointerCapture?.(event.pointerId);
    updatePointerSession(null);
  };

  return (
    <section ref={panelRef} className="multitrack-panel" aria-labelledby="multitrack-heading">
      <div className="section-heading multitrack-heading">
        <div>
          <p className="eyebrow">Sequence timeline</p>
          <h3 id="multitrack-heading">Multitrack</h3>
        </div>
        <div className="multitrack-actions">
          <button
            type="button"
            className="compact-button"
            disabled={!splitCommand.canExecute}
            aria-keyshortcuts={splitCommand.ariaKeyShortcuts}
            onClick={splitCommand.execute}
          >
            <Scissors size={14} aria-hidden="true" />
            Split at playhead
            {splitCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {splitCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <button
            type="button"
            className="compact-button"
            aria-keyshortcuts={rippleDeleteCommand.ariaKeyShortcuts}
            disabled={!rippleDeleteCommand.canExecute}
            onClick={rippleDeleteCommand.execute}
          >
            <Trash2 size={14} aria-hidden="true" />
            Ripple delete clip
            {rippleDeleteCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {rippleDeleteCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <p className="timeline-range" aria-label="Timeline frame range">
            <span>Frames </span>
            {timeline.range.startFrame}–{timeline.range.endFrameExclusive}
          </p>
        </div>
      </div>

      {pointerEditError === null ? null : (
        <p className="multitrack-edit-error" role="alert">
          {pointerEditError}
        </p>
      )}
      {editError === null ? null : (
        <p className="multitrack-edit-error" role="alert">
          {editError.message}
        </p>
      )}

      <div className="multitrack-layout">
        <div className="multitrack-label-column">
          <div className="multitrack-label-spacer" aria-hidden="true" />
          {timeline.tracks.map((track) => (
            <div
              className={`multitrack-visible-label${track.locked ? " is-locked" : ""}${
                track.canToggleVisibility && track.hidden ? " is-hidden" : ""
              }`}
              data-track-muted={track.canMute ? track.muted : undefined}
              data-track-hidden={track.canToggleVisibility ? track.hidden : undefined}
              key={track.trackId}
            >
              <span>{track.kind}</span>
              <strong>{track.name}</strong>
              <small>
                {track.kind === "caption"
                  ? `${track.totalCaptionCount ?? 0} ${(track.totalCaptionCount ?? 0) === 1 ? "cue" : "cues"} · Non-editable`
                  : `${track.totalClipCount} clips · ${track.locked ? "Locked" : "Editable"}`}
                {track.canMute ? ` · ${track.muted ? "Muted" : "Audible"}` : ""}
                {track.canToggleVisibility ? ` · ${track.hidden ? "Hidden" : "Shown"}` : ""}
              </small>
              <div
                className="multitrack-track-controls"
                role="group"
                aria-label={`${track.name} track controls`}
              >
                {track.canToggleVisibility ? (
                  <button
                    type="button"
                    className="multitrack-visibility-toggle"
                    aria-label={`${track.name} ${track.kind} output`}
                    aria-pressed={!track.hidden}
                    title={track.hidden ? "Show track output" : "Hide track output"}
                    disabled={editPending}
                    onClick={() => onSetTrackHidden?.(track.trackId, !track.hidden)}
                  >
                    {track.hidden ? (
                      <EyeOff size={14} aria-hidden="true" />
                    ) : (
                      <Eye size={14} aria-hidden="true" />
                    )}
                    <span>{track.hidden ? "Show" : "Hide"}</span>
                  </button>
                ) : null}
                {track.canMute ? (
                  <button
                    type="button"
                    className="multitrack-mute-toggle"
                    aria-label={`${track.name} track ${track.muted ? "unmute" : "mute"}`}
                    aria-pressed={track.muted}
                    disabled={editPending}
                    onClick={() => onSetTrackMuted(track.trackId, !track.muted)}
                  >
                    {track.muted ? (
                      <VolumeX size={14} aria-hidden="true" />
                    ) : (
                      <Volume2 size={14} aria-hidden="true" />
                    )}
                    <span>{track.muted ? "Unmute" : "Mute"}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="multitrack-lock-toggle"
                  aria-label={`${track.name} track lock`}
                  aria-pressed={track.locked}
                  disabled={editPending}
                  onClick={() => onSetTrackLocked(track.trackId, !track.locked)}
                >
                  {track.locked ? (
                    <LockOpen size={14} aria-hidden="true" />
                  ) : (
                    <Lock size={14} aria-hidden="true" />
                  )}
                  <span>{track.locked ? "Unlock" : "Lock"}</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div
          ref={scrollRegionRef}
          className="multitrack-scroll-region"
          role="region"
          tabIndex={0}
          aria-label="Timeline tracks; scroll horizontally"
          onScroll={onScroll}
        >
          <div className="multitrack-canvas" style={{ width: `${contentWidth}px` }}>
            {pointerSession?.snapGuide === null ||
            pointerSession?.snapGuide === undefined ? null : (
              <div
                className="multitrack-snap-guide"
                data-snap-frame={pointerSession.snapGuide.frame}
                data-snap-target-kind={pointerSession.snapGuide.targetKind}
                data-moving-edge={pointerSession.snapGuide.movingEdge}
                aria-hidden="true"
                style={{
                  left: `${frameToPixel(pointerSession.snapGuide.frame, geometryViewport)}px`,
                }}
              />
            )}
            <div className="multitrack-ruler" aria-hidden="true">
              <span>{timeline.materializedRange.startFrame}</span>
              <span>{timeline.materializedRange.endFrameExclusive}</span>
            </div>
            <ol className="multitrack-track-list" aria-label={`${timeline.name} tracks`}>
              {timeline.tracks.map((track) => (
                <li
                  className={`multitrack-track-row${track.locked ? " is-locked" : ""}${
                    track.canToggleVisibility && track.hidden ? " is-hidden" : ""
                  }`}
                  data-track-id={track.trackId}
                  data-track-kind={track.kind}
                  data-track-locked={track.locked}
                  data-track-muted={track.canMute ? track.muted : undefined}
                  data-track-hidden={track.canToggleVisibility ? track.hidden : undefined}
                  key={track.trackId}
                  aria-label={`${track.name}, ${track.kind} track, ${track.kind === "caption" ? `${track.totalCaptionCount ?? 0} ${(track.totalCaptionCount ?? 0) === 1 ? "cue" : "cues"}, non-editable` : `${track.totalClipCount} clips, ${track.locked ? "locked" : "editable"}`}${track.canMute ? `, ${track.muted ? "muted" : "audible"}` : ""}${track.canToggleVisibility ? `, ${track.hidden ? "hidden" : "shown"}` : ""}`}
                >
                  {(track.captions ?? []).length === 0 ? null : (
                    <ol
                      className="multitrack-caption-list"
                      aria-label={`${track.name} caption cues`}
                    >
                      {(track.captions ?? []).map((caption) => {
                        const left = frameToPixel(caption.startFrame, geometryViewport);
                        const width = Math.max(
                          2,
                          frameToPixel(caption.endFrameExclusive, geometryViewport) - left,
                        );
                        return (
                          <li
                            className={`multitrack-caption${track.hidden ? " is-hidden" : ""}`}
                            data-caption-id={caption.captionId}
                            data-start-frame={caption.startFrame}
                            data-end-frame-exclusive={caption.endFrameExclusive}
                            key={caption.captionId}
                            style={{ left: `${left}px`, width: `${width}px` }}
                            aria-label={`${caption.text}, frames ${caption.startFrame} through ${caption.endFrameExclusive}, end exclusive, non-editable`}
                          >
                            <span>{caption.text}</span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {track.clips.length === 0 ? null : (
                    <ol className="multitrack-clip-list" aria-label={`${track.name} clips`}>
                      {track.clips.map((clip) => {
                        const draft =
                          pointerSession?.clipId === clip.clipId ? pointerSession : null;
                        const startFrame = draft?.draftStartFrame ?? clip.startFrame;
                        const endFrameExclusive =
                          draft?.draftEndFrameExclusive ?? clip.endFrameExclusive;
                        const left = frameToPixel(startFrame, geometryViewport);
                        const width = Math.max(
                          2,
                          frameToPixel(endFrameExclusive, geometryViewport) - left,
                        );
                        const usePreparedThumbnail =
                          thumbnailSource !== null &&
                          clip.sourceKind === "asset" &&
                          clip.assetContentIdentity === thumbnailSource.identity;
                        const isSelected = selectedClipIds?.includes(clip.clipId) ?? selectedClipId === clip.clipId;
                        const isDragging = draft !== null;
                        const canonical = canonicalTimelineClip(projection, clip.clipId);
                        const trimDisabled =
                          editPending ||
                          track.locked ||
                          canonical === null ||
                          !supportsTimelineFrameDeltaTrim(canonical.clip);
                        return (
                          <li
                            className={`multitrack-clip multitrack-clip-${track.kind}${
                              isSelected ? " is-selected" : ""
                            }${isDragging ? " is-dragging" : ""}${
                              track.locked ? " is-locked" : ""
                            }${track.canToggleVisibility && track.hidden ? " is-hidden" : ""}`}
                            data-clip-id={clip.clipId}
                            data-track-locked={track.locked}
                            data-track-hidden={track.canToggleVisibility ? track.hidden : undefined}
                            data-start-frame={startFrame}
                            data-end-frame-exclusive={endFrameExclusive}
                            data-drag-mode={draft?.mode}
                            key={clip.clipId}
                            style={{ left: `${left}px`, width: `${width}px` }}
                          >
                            <button
                              type="button"
                              className="multitrack-clip-body"
                              aria-label={`${clip.sourceLabel}, frames ${startFrame} through ${endFrameExclusive}, end exclusive${track.locked ? ", locked track" : ""}`}
                              aria-pressed={isSelected}
                              aria-keyshortcuts={
                                isSelected
                                  ? [
                                      canMoveSelectedClipBackward
                                        ? moveBackwardCommand.ariaKeyShortcuts
                                        : undefined,
                                      canMoveSelectedClip
                                        ? moveForwardCommand.ariaKeyShortcuts
                                        : undefined,
                                    ]
                                      .filter((shortcut) => shortcut !== undefined)
                                      .join(" ") || undefined
                                  : undefined
                              }
                              onClick={(event) => {
                                if (onSelectMediaClip && clip.sourceKind === "asset") onSelectMediaClip(clip.clipId, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "replace");
                                else onSelectClip(clip.clipId);
                              }}
                              onPointerDown={(event) =>
                                startPointerSession(
                                  event,
                                  clip.clipId,
                                  clip.startFrame,
                                  clip.endFrameExclusive,
                                  "move",
                                )
                              }
                              onPointerMove={movePointerSession}
                              onPointerUp={finishPointerSession}
                              onPointerCancel={cancelPointerSession}
                            >
                              {usePreparedThumbnail ? (
                                <img src={thumbnailSource.sourceUrl} alt="" draggable={false} />
                              ) : (
                                <span className="multitrack-clip-fallback">
                                  {track.kind === "audio" ? (
                                    <Music2 size={15} aria-hidden="true" />
                                  ) : (
                                    <Film size={15} aria-hidden="true" />
                                  )}
                                  <span>
                                    {clip.sourceKind === "sequence" ? "Nested sequence" : "Media"}
                                  </span>
                                </span>
                              )}
                              <span className="multitrack-clip-copy">
                                <strong>{clip.sourceLabel}</strong>
                                <small>{endFrameExclusive - startFrame}f</small>
                              </span>
                            </button>
                            {onSelectMediaClip && clip.sourceKind === "asset" ? <button type="button" aria-label={`Select ${clip.sourceLabel}`} aria-pressed={isSelected} onClick={(event) => onSelectMediaClip(clip.clipId, event.shiftKey ? "range" : "toggle")}>Select</button> : null}
                            {isSelected && (selectedClipIds?.length ?? 0) <= 1 ? (
                              <>
                                <button
                                  type="button"
                                  className="multitrack-trim-handle multitrack-trim-handle-left"
                                  aria-label={`Trim start of ${clip.sourceLabel}`}
                                  disabled={trimDisabled}
                                  onPointerDown={(event) =>
                                    startPointerSession(
                                      event,
                                      clip.clipId,
                                      clip.startFrame,
                                      clip.endFrameExclusive,
                                      "trim-left",
                                    )
                                  }
                                  onPointerMove={movePointerSession}
                                  onPointerUp={finishPointerSession}
                                  onPointerCancel={cancelPointerSession}
                                />
                                <button
                                  type="button"
                                  className="multitrack-trim-handle multitrack-trim-handle-right"
                                  aria-label={`Trim end of ${clip.sourceLabel}`}
                                  disabled={trimDisabled}
                                  onPointerDown={(event) =>
                                    startPointerSession(
                                      event,
                                      clip.clipId,
                                      clip.startFrame,
                                      clip.endFrameExclusive,
                                      "trim-right",
                                    )
                                  }
                                  onPointerMove={movePointerSession}
                                  onPointerUp={finishPointerSession}
                                  onPointerCancel={cancelPointerSession}
                                />
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {timeline.totalClipCount === 0 && (timeline.totalCaptionCount ?? 0) === 0 ? (
        <p className="multitrack-empty">
          <Film size={15} aria-hidden="true" />
          This sequence has no timeline clips or caption cues yet.
        </p>
      ) : (
        <p
          className="multitrack-count"
          aria-label={`${timeline.materializedClipCount} visible clips`}
        >
          Showing {timeline.materializedClipCount} of {timeline.totalClipCount} clips ·{" "}
          {timeline.materializedCaptionCount ?? 0} of {timeline.totalCaptionCount ?? 0} caption cues
        </p>
      )}
    </section>
  );
}
