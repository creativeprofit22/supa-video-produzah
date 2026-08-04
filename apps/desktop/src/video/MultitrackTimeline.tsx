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
import { Film, Music2, Scissors } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";

interface MultitrackTimelineProps {
  readonly projection: ProjectProjection;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly convertCachePath: (path: string) => string;
  readonly selectedClipId: string | null;
  readonly playheadFrame: number;
  readonly editPending: boolean;
  readonly editError: Error | null;
  readonly onSelectClip: (clipId: string) => void;
  readonly onSplitClip: (clipId: string, sourceFrame: number) => void;
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
}

type PointerMode = "move" | "trim-left" | "trim-right";

interface PointerSession {
  readonly pointerId: number;
  readonly clipId: string;
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
}

const TRACK_HEIGHT = 72;
const MIN_PIXELS_PER_FRAME = 4;
const MAX_TIMELINE_WIDTH = 2_000_000;
const VIEWPORT_OVERSCAN_PIXELS = 160;
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
    if (clip !== undefined) return { clip };
  }
  return null;
}

function pointerCaptureTarget(element: HTMLElement) {
  return element as HTMLElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
}

export function MultitrackTimeline({
  projection,
  preparedAsset,
  convertCachePath,
  selectedClipId,
  playheadFrame,
  editPending,
  editError,
  onSelectClip,
  onSplitClip,
  onMoveClip,
  onTrimClip,
}: MultitrackTimelineProps) {
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const [viewportWidth, setViewportWidth] = useState(960);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pointerSession, setPointerSession] = useState<PointerSession | null>(null);

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
  }, [projection, updatePointerSession]);

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

  if (timeline === null || geometryViewport === null) return null;

  const draftTimelineEnd = pointerSession?.draftEndFrameExclusive ?? 0;
  const contentWidth = Math.max(
    viewportWidth,
    frameToPixel(Math.max(timeline.range.endFrameExclusive, draftTimelineEnd), geometryViewport),
  );
  const canSplit =
    selectedClipId !== null &&
    selectedCanonicalClip !== null &&
    playheadFrame > selectedCanonicalClip.clip.sourceIn.value &&
    playheadFrame < selectedCanonicalClip.clip.sourceOut.value &&
    !editPending;

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
    if (event.button !== 0 || editPending || selectedClipId !== clipId) return;
    const canonical = canonicalTimelineClip(projection, clipId);
    if (canonical === null) return;
    event.preventDefault();
    event.stopPropagation();
    pointerCaptureTarget(event.currentTarget).setPointerCapture?.(event.pointerId);
    updatePointerSession({
      pointerId: event.pointerId,
      clipId,
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
    if (current.mode === "move") {
      const duration = current.originEndFrameExclusive - current.originStartFrame;
      const draftStartFrame = Math.max(0, current.originStartFrame + frameDelta);
      next = {
        ...current,
        draftStartFrame,
        draftEndFrameExclusive: draftStartFrame + duration,
      };
    } else if (current.mode === "trim-left") {
      const minimumStart = Math.max(0, current.originStartFrame - current.originSourceInFrame);
      const draftStartFrame = Math.min(
        current.originEndFrameExclusive - 1,
        Math.max(minimumStart, current.originStartFrame + frameDelta),
      );
      next = {
        ...current,
        draftStartFrame,
        draftSourceInFrame:
          current.originSourceInFrame + draftStartFrame - current.originStartFrame,
      };
    } else {
      const draftEndFrameExclusive = Math.max(
        current.originStartFrame + 1,
        current.originEndFrameExclusive + frameDelta,
      );
      next = {
        ...current,
        draftEndFrameExclusive,
        draftSourceOutFrame:
          current.originSourceOutFrame + draftEndFrameExclusive - current.originEndFrameExclusive,
      };
    }
    updatePointerSession(next);
  };

  const finishPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const completed = pointerSessionRef.current;
    if (completed === null || completed.pointerId !== event.pointerId) return;
    pointerCaptureTarget(event.currentTarget).releasePointerCapture?.(event.pointerId);
    updatePointerSession(null);
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

  const splitSelectedClip = () => {
    if (canSplit && selectedClipId !== null) onSplitClip(selectedClipId, playheadFrame);
  };

  return (
    <section className="multitrack-panel" aria-labelledby="multitrack-heading">
      <div className="section-heading multitrack-heading">
        <div>
          <p className="eyebrow">Sequence timeline</p>
          <h3 id="multitrack-heading">Multitrack</h3>
        </div>
        <div className="multitrack-actions">
          <button
            type="button"
            className="compact-button"
            disabled={!canSplit}
            onClick={splitSelectedClip}
          >
            <Scissors size={14} aria-hidden="true" />
            Split at playhead
          </button>
          <p className="timeline-range" aria-label="Timeline frame range">
            <span>Frames </span>
            {timeline.range.startFrame}–{timeline.range.endFrameExclusive}
          </p>
        </div>
      </div>

      {editError === null ? null : (
        <p className="multitrack-edit-error" role="alert">
          {editError.message}
        </p>
      )}

      <div
        className="multitrack-layout"
        style={{ "--timeline-track-height": `${TRACK_HEIGHT}px` } as CSSProperties}
      >
        <div className="multitrack-label-column" aria-hidden="true">
          <div className="multitrack-label-spacer" />
          {timeline.tracks.map((track) => (
            <div className="multitrack-visible-label" key={track.trackId}>
              <span>{track.kind}</span>
              <strong>{track.name}</strong>
              <small>{track.totalClipCount} clips</small>
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
            <div className="multitrack-ruler" aria-hidden="true">
              <span>{timeline.materializedRange.startFrame}</span>
              <span>{timeline.materializedRange.endFrameExclusive}</span>
            </div>
            <ol className="multitrack-track-list" aria-label={`${timeline.name} tracks`}>
              {timeline.tracks.map((track) => (
                <li
                  className="multitrack-track-row"
                  data-track-id={track.trackId}
                  data-track-kind={track.kind}
                  key={track.trackId}
                  aria-label={`${track.name}, ${track.kind} track, ${track.totalClipCount} clips`}
                >
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
                        const isSelected = selectedClipId === clip.clipId;
                        const isDragging = draft !== null;
                        return (
                          <li
                            className={`multitrack-clip multitrack-clip-${track.kind}${
                              isSelected ? " is-selected" : ""
                            }${isDragging ? " is-dragging" : ""}`}
                            data-clip-id={clip.clipId}
                            data-start-frame={startFrame}
                            data-end-frame-exclusive={endFrameExclusive}
                            data-drag-mode={draft?.mode}
                            key={clip.clipId}
                            style={{ left: `${left}px`, width: `${width}px` }}
                          >
                            <button
                              type="button"
                              className="multitrack-clip-body"
                              aria-label={`${clip.sourceLabel}, frames ${startFrame} through ${endFrameExclusive}, end exclusive`}
                              aria-pressed={isSelected}
                              onClick={() => onSelectClip(clip.clipId)}
                              onKeyDown={(event) => {
                                if (
                                  event.code === "KeyS" &&
                                  !event.altKey &&
                                  !event.ctrlKey &&
                                  !event.metaKey &&
                                  !event.shiftKey &&
                                  isSelected &&
                                  canSplit
                                ) {
                                  event.preventDefault();
                                  splitSelectedClip();
                                }
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
                            {isSelected ? (
                              <>
                                <button
                                  type="button"
                                  className="multitrack-trim-handle multitrack-trim-handle-left"
                                  aria-label={`Trim start of ${clip.sourceLabel}`}
                                  disabled={editPending}
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
                                  disabled={editPending}
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

      {timeline.totalClipCount === 0 ? (
        <p className="multitrack-empty">
          <Film size={15} aria-hidden="true" />
          This sequence has no timeline clips yet.
        </p>
      ) : (
        <p
          className="multitrack-count"
          aria-label={`${timeline.materializedClipCount} visible clips`}
        >
          Showing {timeline.materializedClipCount} of {timeline.totalClipCount} clips
        </p>
      )}
    </section>
  );
}
