import {
  createRationalTime,
  createTimelineViewport,
  frameToPixel,
  pixelToFrame,
  type MediaContentIdentityV1,
  type ProjectProjection,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import type { PreparedVideoAsset } from "@supa-video/media";
import {
  deriveActiveTimelineRange,
  projectVisibleTimeline,
  type TimelineClipViewModel,
} from "@supa-video/project";
import { ImageOff, Layers3 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

const PIXELS_PER_SECOND = { numerator: 80, denominator: 1 } as const;
const OVERSCAN_PIXELS = 240;

interface MultitrackTimelineProps {
  readonly projection: ProjectProjection;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly convertCachePath: (path: string) => string;
}

function activeSequence(projection: ProjectProjection): VideoSequenceV2 {
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) {
    throw new Error("Multitrack timeline requires an active sequence");
  }
  return sequence;
}

function identitiesMatch(
  expected: MediaContentIdentityV1 | undefined,
  actual: MediaContentIdentityV1,
): boolean {
  return (
    expected !== undefined &&
    expected.algorithm === actual.algorithm &&
    expected.digest === actual.digest &&
    expected.byteLength === actual.byteLength
  );
}

function VisibleClipMedia({
  clip,
  preparedAsset,
  convertCachePath,
}: {
  readonly clip: TimelineClipViewModel;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly convertCachePath: (path: string) => string;
}) {
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null);
  const thumbnailUrl = useMemo(() => {
    if (
      preparedAsset === null ||
      !identitiesMatch(clip.assetContentIdentity, preparedAsset.sourceIdentity)
    ) {
      return null;
    }
    return convertCachePath(preparedAsset.thumbnailPath);
  }, [
    clip.assetContentIdentity?.algorithm,
    clip.assetContentIdentity?.byteLength,
    clip.assetContentIdentity?.digest,
    convertCachePath,
    preparedAsset?.sourceIdentity.algorithm,
    preparedAsset?.sourceIdentity.byteLength,
    preparedAsset?.sourceIdentity.digest,
    preparedAsset?.thumbnailPath,
  ]);

  if (thumbnailUrl !== null && thumbnailUrl !== failedThumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt=""
        draggable={false}
        onError={() => setFailedThumbnailUrl(thumbnailUrl)}
      />
    );
  }
  return (
    <span className="multitrack-clip-fallback">
      <ImageOff size={15} aria-hidden />
      <span>{clip.sourceLabel}</span>
    </span>
  );
}

export function MultitrackTimeline({
  projection,
  preparedAsset,
  convertCachePath,
}: MultitrackTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const sequence = activeSequence(projection);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometryViewport = useMemo(() => {
    const range = deriveActiveTimelineRange(projection);
    return createTimelineViewport({
      frameRate: sequence.rate,
      zoomScale: PIXELS_PER_SECOND,
      scrollOrigin: createRationalTime(0, sequence.rate),
      viewportWidthPixels: Math.max(1, viewportWidth),
      overscanPixels: OVERSCAN_PIXELS,
      timelineRange: { start: range.startFrame, endExclusive: range.endFrameExclusive },
    });
  }, [projection, sequence.rate, viewportWidth]);

  const viewport = useMemo(() => {
    const scrollOriginFrame = Math.max(
      geometryViewport.timelineRange.start,
      pixelToFrame(scrollLeft, geometryViewport, "floor"),
    );
    return createTimelineViewport({
      frameRate: sequence.rate,
      zoomScale: PIXELS_PER_SECOND,
      scrollOrigin: createRationalTime(scrollOriginFrame, sequence.rate),
      viewportWidthPixels: Math.max(1, viewportWidth),
      overscanPixels: OVERSCAN_PIXELS,
      timelineRange: geometryViewport.timelineRange,
    });
  }, [geometryViewport, scrollLeft, sequence.rate, viewportWidth]);

  const viewModel = useMemo(
    () => projectVisibleTimeline(projection, viewport),
    [projection, viewport],
  );
  if (viewModel === null) return null;

  const contentWidth = Math.max(
    viewportWidth,
    frameToPixel(viewModel.range.endFrameExclusive, geometryViewport),
  );
  const rateLabel = `${viewModel.rate.numerator}/${viewModel.rate.denominator} fps`;

  return (
    <section className="panel multitrack-panel" aria-labelledby="multitrack-title">
      <div className="panel-heading multitrack-heading">
        <div>
          <p className="state-kicker">Timeline</p>
          <h2 id="multitrack-title">Multitrack timeline</h2>
        </div>
        <p className="timeline-range">
          {viewModel.tracks.length} tracks <span>· {rateLabel}</span>
        </p>
      </div>
      <div className="multitrack-layout">
        <div className="multitrack-label-column" aria-hidden="true">
          <div className="multitrack-label-spacer" />
          {viewModel.tracks.map((track) => (
            <div className="multitrack-visible-label" key={track.trackId}>
              <span>{track.kind}</span>
              <strong>{track.name}</strong>
              <small>{track.totalClipCount} clips</small>
            </div>
          ))}
        </div>
        <div
          ref={scrollRef}
          className="multitrack-scroll-region"
          role="region"
          aria-label="Timeline tracks; scroll horizontally"
          tabIndex={0}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <div className="multitrack-canvas" style={{ width: `${contentWidth}px` }}>
            <div className="multitrack-ruler" aria-hidden="true">
              <span>0</span>
              <span>{viewModel.range.endFrameExclusive}f</span>
            </div>
            <ol className="multitrack-track-list" aria-label="Sequence tracks">
              {viewModel.tracks.map((track) => (
                <li
                  className="multitrack-track-row"
                  key={track.trackId}
                  data-track-id={track.trackId}
                  data-track-kind={track.kind}
                  aria-label={`${track.kind} track ${track.name}, ${track.totalClipCount} clips`}
                >
                  <span className="sr-only">{track.name}</span>
                  <ol className="multitrack-clip-list" aria-label={`${track.name} clips`}>
                    {track.clips.map((clip) => {
                      const left = frameToPixel(clip.startFrame, geometryViewport);
                      const width = Math.max(
                        2,
                        frameToPixel(clip.endFrameExclusive, geometryViewport) - left,
                      );
                      const rangeLabel = `frames ${clip.startFrame} through ${clip.endFrameExclusive}, end exclusive`;
                      return (
                        <li
                          className={`multitrack-clip multitrack-clip-${clip.trackKind}`}
                          key={clip.clipId}
                          data-track-id={clip.trackId}
                          data-track-kind={clip.trackKind}
                          data-clip-id={clip.clipId}
                          data-start-frame={clip.startFrame}
                          data-end-frame-exclusive={clip.endFrameExclusive}
                          style={{ insetInlineStart: `${left}px`, width: `${width}px` }}
                        >
                          <article aria-label={`${clip.sourceLabel}, ${rangeLabel}`}>
                            <VisibleClipMedia
                              clip={clip}
                              preparedAsset={preparedAsset}
                              convertCachePath={convertCachePath}
                            />
                            <span className="multitrack-clip-copy">
                              <strong>{clip.sourceLabel}</strong>
                              <small>
                                [{clip.startFrame}, {clip.endFrameExclusive})
                              </small>
                            </span>
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      {viewModel.totalClipCount === 0 ? (
        <div className="multitrack-empty">
          <Layers3 size={18} aria-hidden />
          <span>The active sequence has no clips.</span>
        </div>
      ) : null}
      <p
        className="multitrack-count"
        aria-label={`${viewModel.materializedClipCount} visible clips`}
      >
        Showing {viewModel.materializedClipCount} of {viewModel.totalClipCount} clips
      </p>
    </section>
  );
}
