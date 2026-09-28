import { VideoDomainError } from "@supa-video/contracts";
import type {
  CaptionStyleV1,
  CaptionValidationProfileV1,
  TranscriptArtifactV1,
} from "@supa-video/media";

import type {
  TranscriptTimelineOccurrence,
  TranscriptTimelineProjection,
} from "./transcript-edit-mapping.js";

type CaptionFailureReason =
  | "caption_projection_mismatch"
  | "caption_track_conflict"
  | "caption_projection_invalid"
  | "caption_contract_invalid"
  | "caption_unit_unrenderable"
  | "caption_constraints_unsatisfied"
  | "generated_caption_invalid";

export interface LogicalOccurrence extends TranscriptTimelineOccurrence {
  readonly constituentOccurrenceIds: readonly string[];
}

export interface ValidatedCaptionInput {
  readonly artifact: TranscriptArtifactV1;
  readonly timeline: TranscriptTimelineProjection;
  readonly captionTrackId: string;
  readonly language: string;
  readonly style: CaptionStyleV1;
  readonly validationProfile: CaptionValidationProfileV1;
  readonly occurrences: readonly LogicalOccurrence[];
}

export interface FrameConstraints {
  readonly minimumDurationFrames: number;
  readonly maximumDurationFrames: number;
  readonly oneSecondFrames: number;
}

export function captionError(
  code: "invalid_project" | "invalid_range",
  message: string,
  reason: CaptionFailureReason,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

export function spansOverlap(
  left: { readonly sourceStartUs: number; readonly sourceEndUs: number },
  right: { readonly sourceStartUs: number; readonly sourceEndUs: number },
): boolean {
  return left.sourceStartUs < right.sourceEndUs && left.sourceEndUs > right.sourceStartUs;
}

/**
 * The last frame a cue's speech needs, given where the next cue starts.
 *
 * Word ranges are mapped to frames with the start rounded down and the end
 * rounded up, so a cut always removes a word's whole audio. Two words that
 * touch in source time (one ends at the instant the next starts) therefore
 * overlap by one frame on the timeline whenever that instant is not
 * frame-aligned, which is almost always for real speech. That one-frame
 * rounding overlap is absorbed here, so the cue ends where the next begins.
 * A genuine overlap of more than one frame is left to fail the constraints.
 */
export function speechEndBeforeNextCue(rawEnd: number, nextCueStart?: number): number {
  return nextCueStart !== undefined && rawEnd - nextCueStart === 1 ? nextCueStart : rawEnd;
}

/**
 * A cue's end frame, or null when the hard limits cannot be met.
 *
 * Hard: the cue covers its speech, lasts at least the minimum duration, at
 * most the maximum, and ends by the next cue. Soft: it also stays up long
 * enough for the reading speed (`readingFrames`) when there is room; when
 * there is not, the cue is kept and later flagged as reading too fast.
 */
export function cueEndWithinLimits(
  start: number,
  speechEnd: number,
  readingFrames: number,
  constraints: FrameConstraints,
  nextCueStart?: number,
): number | null {
  const latestEnd = Math.min(
    start + constraints.maximumDurationFrames,
    nextCueStart ?? Number.MAX_SAFE_INTEGER,
  );
  const required = Math.max(speechEnd, start + constraints.minimumDurationFrames);
  if (!Number.isSafeInteger(required) || required > latestEnd) return null;
  return Math.min(Math.max(required, start + readingFrames), latestEnd);
}
