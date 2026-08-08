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
