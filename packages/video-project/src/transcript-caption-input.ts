import {
  VideoDomainError,
  createRationalTime,
  mediaContentIdentityV1Schema,
  projectRevisionDescriptorV2Schema,
  rationalRateSchema,
  rationalTimeSchema,
  ratesEqual,
  rescaleRationalTime,
  type RationalRate,
} from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  captionStyleV1Schema,
  captionTrackLinkV1Schema,
  captionValidationProfileV1Schema,
  transcriptArtifactV1Schema,
  type CaptionStyleV1,
  type CaptionValidationProfileV1,
  type TranscriptArtifactV1,
} from "@supa-video/media";

import {
  captionError,
  type FrameConstraints,
  type LogicalOccurrence,
  type ValidatedCaptionInput,
} from "./transcript-caption-internal.js";
import {
  compareTranscriptTimelineOccurrences,
  identitiesEqual,
  type TranscriptTimelineOccurrence,
  type TranscriptTimelineProjection,
} from "./transcript-edit-mapping.js";

export interface GenerateCaptionArtifactV1Input {
  readonly artifact: TranscriptArtifactV1;
  readonly timeline: TranscriptTimelineProjection;
  readonly captionTrackId: string;
  readonly language: string;
  readonly style: CaptionStyleV1;
  readonly validationProfile: CaptionValidationProfileV1;
}

function contractInvalid(field: string): never {
  throw captionError(
    "invalid_range",
    "Caption generator input contract is invalid",
    "caption_contract_invalid",
    {
      field,
    },
  );
}

function projectionInvalid(field: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw captionError(
    "invalid_project",
    "Transcript timeline projection is invalid",
    "caption_projection_invalid",
    { field, ...details },
  );
}

function projectionMismatch(field: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw captionError(
    "invalid_project",
    "Transcript and timeline projection lineage do not match",
    "caption_projection_mismatch",
    { field, ...details },
  );
}

function revisionsEqual(
  left: TranscriptTimelineProjection["projectRevision"],
  right: TranscriptTimelineProjection["projectRevision"],
): boolean {
  if (
    !projectRevisionDescriptorV2Schema.safeParse(left).success ||
    !projectRevisionDescriptorV2Schema.safeParse(right).success
  ) {
    return false;
  }
  return (
    left.number === right.number &&
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.committedAt === right.committedAt &&
    left.operationId === right.operationId &&
    left.stateHash === right.stateHash
  );
}

function identitiesMatch(
  left: unknown,
  right: TranscriptArtifactV1["identity"]["sourceIdentity"],
): boolean {
  const parsed = mediaContentIdentityV1Schema.safeParse(left);
  return parsed.success && identitiesEqual(parsed.data, right);
}

function timeUsesRate(
  time: { readonly rateNumerator: number; readonly rateDenominator: number },
  rate: RationalRate,
): boolean {
  return time.rateNumerator === rate.numerator && time.rateDenominator === rate.denominator;
}

function validateRange(
  occurrence: TranscriptTimelineOccurrence,
  rangeName: "sourceRange" | "timelineRange",
): void {
  const range = occurrence[rangeName];
  if (
    !rationalTimeSchema.safeParse(range?.start).success ||
    !rationalTimeSchema.safeParse(range?.end).success ||
    !ratesEqual(
      { numerator: range.start.rateNumerator, denominator: range.start.rateDenominator },
      { numerator: range.end.rateNumerator, denominator: range.end.rateDenominator },
    ) ||
    range.end.value <= range.start.value
  ) {
    projectionInvalid(rangeName, { occurrenceId: occurrence.occurrenceId });
  }
}

function canStitch(previous: LogicalOccurrence, current: TranscriptTimelineOccurrence): boolean {
  return (
    previous.wordId === current.wordId &&
    previous.assetId === current.assetId &&
    previous.timelineRange.end.value === current.timelineRange.start.value &&
    timeUsesRate(current.timelineRange.start, {
      numerator: previous.timelineRange.end.rateNumerator,
      denominator: previous.timelineRange.end.rateDenominator,
    }) &&
    previous.sourceRange.end.value === current.sourceRange.start.value &&
    timeUsesRate(current.sourceRange.start, {
      numerator: previous.sourceRange.end.rateNumerator,
      denominator: previous.sourceRange.end.rateDenominator,
    })
  );
}

function stitchOccurrences(
  occurrences: readonly TranscriptTimelineOccurrence[],
): readonly LogicalOccurrence[] {
  const stitched: LogicalOccurrence[] = [];
  for (const occurrence of occurrences) {
    const previous = stitched.at(-1);
    if (previous !== undefined && canStitch(previous, occurrence)) {
      stitched[stitched.length - 1] = {
        ...previous,
        occurrenceId: `${previous.occurrenceId}+${occurrence.occurrenceId}`,
        sourceRange: { start: previous.sourceRange.start, end: occurrence.sourceRange.end },
        timelineRange: { start: previous.timelineRange.start, end: occurrence.timelineRange.end },
        constituentOccurrenceIds: [...previous.constituentOccurrenceIds, occurrence.occurrenceId],
      };
      continue;
    }
    stitched.push({ ...occurrence, constituentOccurrenceIds: [occurrence.occurrenceId] });
  }
  return stitched;
}

export function validateCaptionInput(input: GenerateCaptionArtifactV1Input): ValidatedCaptionInput {
  const artifactResult = transcriptArtifactV1Schema.safeParse(input.artifact);
  if (!artifactResult.success) contractInvalid("artifact");
  const styleResult = captionStyleV1Schema.safeParse(input.style);
  if (!styleResult.success) contractInvalid("style");
  const profileResult = captionValidationProfileV1Schema.safeParse(input.validationProfile);
  if (!profileResult.success) contractInvalid("validationProfile");

  const timeline = input.timeline;
  if (
    timeline === null ||
    typeof timeline !== "object" ||
    timeline.schemaVersion !== 1 ||
    !rationalRateSchema.safeParse(timeline.timelineRate).success ||
    !projectRevisionDescriptorV2Schema.safeParse(timeline.projectRevision).success ||
    !Array.isArray(timeline.occurrences)
  ) {
    projectionInvalid("timeline");
  }

  const trackLink = {
    schemaVersion: 1 as const,
    projectId: timeline.projectId,
    projectRevision: timeline.projectRevision,
    sequenceId: timeline.sequenceId,
    captionTrackId: input.captionTrackId,
  };
  if (!captionTrackLinkV1Schema.safeParse(trackLink).success) contractInvalid("trackLink");
  if (input.captionTrackId === timeline.trackId) {
    throw captionError(
      "invalid_project",
      "Caption track cannot equal the transcript source track",
      "caption_track_conflict",
      { trackId: timeline.trackId },
    );
  }
  if (
    timeline.artifactIdentityKey !== artifactResult.data.identity.key ||
    !identitiesMatch(timeline.sourceIdentity, artifactResult.data.identity.sourceIdentity)
  ) {
    projectionMismatch("timelineIdentity");
  }

  const contractShell = {
    schemaVersion: 1 as const,
    trackLink,
    sourceIdentity: artifactResult.data.identity.sourceIdentity,
    transcriptArtifactIdentityKey: artifactResult.data.identity.key,
    language: input.language,
    timelineRate: timeline.timelineRate,
    style: styleResult.data,
    validationProfile: profileResult.data,
    cues: [],
  };
  if (!captionArtifactV1Schema.safeParse(contractShell).success) contractInvalid("language");

  const wordsById = new Map(artifactResult.data.words.map((word) => [word.wordId, word]));
  const occurrenceIds = new Set<string>();
  for (const occurrence of timeline.occurrences) {
    if (
      typeof occurrence?.occurrenceId !== "string" ||
      occurrence.occurrenceId.length === 0 ||
      occurrenceIds.has(occurrence.occurrenceId)
    ) {
      projectionInvalid("occurrenceId", { occurrenceId: occurrence?.occurrenceId ?? null });
    }
    occurrenceIds.add(occurrence.occurrenceId);
    if (
      occurrence.projectId !== timeline.projectId ||
      !revisionsEqual(occurrence.projectRevision, timeline.projectRevision) ||
      occurrence.sequenceId !== timeline.sequenceId ||
      occurrence.trackId !== timeline.trackId ||
      occurrence.artifactIdentityKey !== timeline.artifactIdentityKey ||
      !identitiesMatch(occurrence.sourceIdentity, artifactResult.data.identity.sourceIdentity)
    ) {
      projectionMismatch("occurrenceLineage", { occurrenceId: occurrence.occurrenceId });
    }
    const word = wordsById.get(occurrence.wordId);
    if (
      word === undefined ||
      occurrence.text !== word.text ||
      occurrence.sourceStartUs !== word.sourceStartUs ||
      occurrence.sourceEndUs !== word.sourceEndUs
    ) {
      projectionInvalid("occurrenceWord", { occurrenceId: occurrence.occurrenceId });
    }
    validateRange(occurrence, "sourceRange");
    validateRange(occurrence, "timelineRange");
    if (
      !timeUsesRate(occurrence.timelineRange.start, timeline.timelineRate) ||
      !timeUsesRate(occurrence.timelineRange.end, timeline.timelineRate)
    ) {
      projectionInvalid("timelineRate", { occurrenceId: occurrence.occurrenceId });
    }
  }

  const occurrences = [...timeline.occurrences].sort(compareTranscriptTimelineOccurrences);
  for (let index = 1; index < occurrences.length; index += 1) {
    const previous = occurrences[index - 1]!;
    const current = occurrences[index]!;
    if (compareTranscriptTimelineOccurrences(previous, current) === 0) {
      projectionInvalid("occurrenceGeometry", {
        occurrenceIds: [previous.occurrenceId, current.occurrenceId].sort(),
      });
    }
  }
  return {
    artifact: artifactResult.data,
    timeline,
    captionTrackId: input.captionTrackId,
    language: input.language,
    style: styleResult.data,
    validationProfile: profileResult.data,
    occurrences: stitchOccurrences(occurrences),
  };
}

export function frameConstraints(input: ValidatedCaptionInput): FrameConstraints {
  try {
    const minimumDurationFrames = rescaleRationalTime(
      input.validationProfile.minimumCueDuration,
      input.timeline.timelineRate,
      "ceil",
    ).value;
    const maximumDurationFrames = rescaleRationalTime(
      input.validationProfile.maximumCueDuration,
      input.timeline.timelineRate,
      "floor",
    ).value;
    const oneSecondFrames = rescaleRationalTime(
      createRationalTime(1, { numerator: 1, denominator: 1 }),
      input.timeline.timelineRate,
      "ceil",
    ).value;
    if (
      input.occurrences.length > 0 &&
      maximumDurationFrames < Math.max(1, minimumDurationFrames)
    ) {
      contractInvalid("durationProfile");
    }
    return { minimumDurationFrames, maximumDurationFrames, oneSecondFrames };
  } catch (error) {
    if (error instanceof VideoDomainError && error.details.reason === "caption_contract_invalid") {
      throw error;
    }
    contractInvalid("durationProfile");
  }
}
