import {
  createRationalTime,
  rateOf,
  sourceOffsetToTimeline,
  timelineOffsetToSource,
  VideoDomainError,
  type ProjectClip,
} from "@supa-video/contracts";

/** Integer pointer positions are proposals. Inexact source boundaries reject; they are never rounded. */
export function sourceFrameAtTimelineDelta(
  clip: ProjectClip,
  sourceFrame: number,
  delta: number,
): number {
  if (!Number.isSafeInteger(sourceFrame) || !Number.isSafeInteger(delta)) {
    throw new VideoDomainError("invalid_time", "Trim boundary exceeds the safe integer range");
  }
  const offset = timelineOffsetToSource(
    createRationalTime(Math.abs(delta), rateOf(clip.timelineStart)),
    rateOf(clip.sourceIn),
    clip.speed,
  ).value;
  const result = sourceFrame + Math.sign(delta) * offset;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new VideoDomainError("invalid_time", "Trim boundary is outside the source range");
  }
  return result;
}

export function minimumTimelineTrimStart(clip: ProjectClip): number {
  // Floor bounds the number of whole timeline frames available before source zero;
  // the actual chosen source boundary still goes through exact conversion above.
  const available = sourceOffsetToTimeline(
    clip.sourceIn,
    rateOf(clip.timelineStart),
    clip.speed,
    "floor",
  ).value;
  return Math.max(0, clip.timelineStart.value - available);
}
