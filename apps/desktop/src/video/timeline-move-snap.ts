import {
  VideoDomainError,
  createRationalTime,
  createTimelineSnapIndex,
  frameRangeDuration,
  rateOf,
  rescaleRationalTime,
  snapTimelineTime,
  type ProjectClip,
  type RationalRate,
  type TimelineSnapIndex,
  type TimelineSnapTarget,
  type VideoSequenceV2,
} from "@supa-video/contracts";

export type TimelineMoveSnapTargetKind = "clip-start" | "clip-end" | "playhead";
export type TimelineMovingEdge = "start" | "end";

export interface TimelineMoveSnapTarget extends TimelineSnapTarget {
  readonly kind: TimelineMoveSnapTargetKind;
  readonly trackId: string | null;
}

export interface TimelineMoveClipInterval {
  readonly clipId: string;
  readonly trackId: string;
  readonly startFrame: number;
  readonly endFrameExclusive: number;
}

export interface TimelineMoveSnapContext {
  readonly frameRate: RationalRate;
  readonly index: TimelineSnapIndex<TimelineMoveSnapTarget>;
  readonly clipIntervals: readonly TimelineMoveClipInterval[];
}

export interface TimelineMoveSnapInput {
  readonly movingClipId: string;
  readonly destinationTrackId: string;
  readonly proposedStartFrame: number;
  readonly durationFrames: number;
  readonly zoomScale: RationalRate;
  readonly maximumSnapDistancePixels: number;
}

export interface TimelineMoveSnapGuide {
  readonly frame: number;
  readonly targetKind: TimelineMoveSnapTargetKind;
  readonly movingEdge: TimelineMovingEdge;
}

export interface TimelineMoveSnapResolution {
  readonly startFrame: number;
  readonly guide: TimelineMoveSnapGuide | null;
}

interface SnapCandidate {
  readonly startFrame: number;
  readonly correctionFrames: number;
  readonly guide: TimelineMoveSnapGuide;
}

/** Maps the source monitor playhead into the selected clip's canonical timeline position. */
export function timelineFrameForClipSourceFrame(
  clip: ProjectClip,
  sourceFrame: number,
): number | null {
  if (sourceFrame < clip.sourceIn.value || sourceFrame >= clip.sourceOut.value) return null;
  const sourceOffset = createRationalTime(sourceFrame - clip.sourceIn.value, rateOf(clip.sourceIn));
  try {
    const timelineOffset = rescaleRationalTime(sourceOffset, rateOf(clip.timelineStart), "exact");
    return clip.timelineStart.value + timelineOffset.value;
  } catch (error) {
    if (
      error instanceof VideoDomainError &&
      error.code === "invalid_time" &&
      error.message === "Frame value cannot be represented exactly at the target rate"
    ) {
      return null;
    }
    throw error;
  }
}

/** Builds targets from the full canonical sequence, independent of viewport materialization. */
export function createTimelineMoveSnapContext(
  sequence: VideoSequenceV2,
  timelinePlayheadFrame: number | null,
): TimelineMoveSnapContext {
  const clipIntervals: TimelineMoveClipInterval[] = [];
  const targets: TimelineMoveSnapTarget[] =
    timelinePlayheadFrame === null
      ? []
      : [
          {
            kind: "playhead",
            trackId: null,
            time: createRationalTime(timelinePlayheadFrame, sequence.rate),
          },
        ];
  for (const track of sequence.tracks) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      const startFrame = clip.timelineStart.value;
      const sourceDuration = frameRangeDuration({ in: clip.sourceIn, out: clip.sourceOut });
      const durationFrames = rescaleRationalTime(sourceDuration, sequence.rate, "exact").value;
      const endFrame = startFrame + durationFrames;
      clipIntervals.push({
        clipId: clip.id,
        trackId: track.id,
        startFrame,
        endFrameExclusive: endFrame,
      });
      targets.push(
        {
          kind: "clip-start",
          clipId: clip.id,
          trackId: track.id,
          time: createRationalTime(startFrame, sequence.rate),
        },
        {
          kind: "clip-end",
          clipId: clip.id,
          trackId: track.id,
          time: createRationalTime(endFrame, sequence.rate),
        },
      );
    }
  }
  return Object.freeze({
    frameRate: sequence.rate,
    index: createTimelineSnapIndex(targets),
    clipIntervals: Object.freeze(clipIntervals),
  });
}

function overlapsDestinationTrack(
  context: TimelineMoveSnapContext,
  input: TimelineMoveSnapInput,
  startFrame: number,
): boolean {
  const endFrameExclusive = startFrame + input.durationFrames;
  return context.clipIntervals.some(
    (interval) =>
      interval.trackId === input.destinationTrackId &&
      interval.clipId !== input.movingClipId &&
      startFrame < interval.endFrameExclusive &&
      interval.startFrame < endFrameExclusive,
  );
}

function snapCandidate(
  context: TimelineMoveSnapContext,
  input: TimelineMoveSnapInput,
  movingEdge: TimelineMovingEdge,
): SnapCandidate | null {
  const proposedEdgeFrame =
    movingEdge === "start"
      ? input.proposedStartFrame
      : input.proposedStartFrame + input.durationFrames;
  const result = snapTimelineTime(context.index, {
    proposedTime: createRationalTime(proposedEdgeFrame, context.frameRate),
    movingClipId: input.movingClipId,
    zoomScale: input.zoomScale,
    maximumSnapDistancePixels: input.maximumSnapDistancePixels,
  });
  if (result.matchedTarget === null) return null;
  const startFrame =
    movingEdge === "start"
      ? result.correctedTime.value
      : result.correctedTime.value - input.durationFrames;
  if (startFrame < 0 || overlapsDestinationTrack(context, input, startFrame)) return null;
  return {
    startFrame,
    correctionFrames: Math.abs(startFrame - input.proposedStartFrame),
    guide: {
      frame: result.matchedTarget.time.value,
      targetKind: result.matchedTarget.kind,
      movingEdge,
    },
  };
}

/** Resolves both moving edges and deterministically favors the leading edge on equal corrections. */
export function resolveTimelineMoveSnap(
  context: TimelineMoveSnapContext,
  input: TimelineMoveSnapInput,
): TimelineMoveSnapResolution {
  const startCandidate = snapCandidate(context, input, "start");
  const endCandidate = snapCandidate(context, input, "end");
  const candidate =
    startCandidate === null
      ? endCandidate
      : endCandidate === null || startCandidate.correctionFrames <= endCandidate.correctionFrames
        ? startCandidate
        : endCandidate;
  if (candidate === null) return { startFrame: input.proposedStartFrame, guide: null };
  return { startFrame: candidate.startFrame, guide: candidate.guide };
}
