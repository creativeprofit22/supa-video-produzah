import {
  VideoDomainError,
  isTrackLocked,
  mediaContentIdentityV1Schema,
  projectProjectionSchema,
  projectRevisionDescriptorV2Schema,
  rationalRateSchema,
  rationalTimeSchema,
  ratesEqual,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type RationalRate,
} from "@supa-video/contracts";
import { captionArtifactV1Schema, type CaptionArtifactV1 } from "@supa-video/media";

import {
  compareTranscriptTimelineOccurrences,
  identitiesEqual,
  type TranscriptTimelineOccurrence,
  type TranscriptTimelineProjection,
} from "./transcript-edit-mapping.js";

export interface RemapCaptionArtifactV1Input {
  readonly artifact: CaptionArtifactV1;
  readonly timeline: TranscriptTimelineProjection;
  readonly projection: ProjectProjection;
}

export type RemapFailureReason =
  | "caption_remap_contract_invalid"
  | "caption_remap_projection_invalid"
  | "caption_remap_stale_revision"
  | "caption_remap_stale_identity"
  | "caption_remap_source_track_missing"
  | "caption_remap_caption_track_missing"
  | "caption_remap_caption_track_locked"
  | "caption_remap_rate_changed"
  | "caption_remap_ambiguous_occurrences"
  | "caption_remap_constraints_unsatisfied"
  | "generated_caption_invalid";

export interface ValidatedRemapInput {
  readonly artifact: CaptionArtifactV1;
  readonly timeline: TranscriptTimelineProjection;
  readonly projection: ProjectProjection;
  readonly occurrences: readonly TranscriptTimelineOccurrence[];
}

export function remapError(
  code: "invalid_project" | "invalid_range",
  message: string,
  reason: RemapFailureReason,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

function contractInvalid(field: string): never {
  throw remapError(
    "invalid_range",
    "Caption remap input contract is invalid",
    "caption_remap_contract_invalid",
    { field },
  );
}

export function projectionInvalid(
  field: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw remapError(
    "invalid_project",
    "Transcript timeline projection is invalid",
    "caption_remap_projection_invalid",
    { field, ...details },
  );
}

function staleIdentity(field: string): never {
  throw remapError(
    "invalid_project",
    "Caption remap lineage does not match the source artifact",
    "caption_remap_stale_identity",
    { field },
  );
}

function revisionsEqual(
  left: ProjectRevisionDescriptorV2,
  right: ProjectRevisionDescriptorV2,
): boolean {
  return (
    left.number === right.number &&
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.committedAt === right.committedAt &&
    left.operationId === right.operationId &&
    left.stateHash === right.stateHash
  );
}

function timeUsesRate(
  time: { readonly rateNumerator: number; readonly rateDenominator: number },
  rate: RationalRate,
): boolean {
  return time.rateNumerator === rate.numerator && time.rateDenominator === rate.denominator;
}

function validateOccurrenceRange(
  occurrence: TranscriptTimelineOccurrence,
  rangeName: "sourceRange" | "timelineRange",
): void {
  const range = occurrence[rangeName];
  if (
    !rationalTimeSchema.safeParse(range?.start).success ||
    !rationalTimeSchema.safeParse(range?.end).success ||
    range.start.rateNumerator !== range.end.rateNumerator ||
    range.start.rateDenominator !== range.end.rateDenominator ||
    range.end.value <= range.start.value
  ) {
    projectionInvalid(rangeName, { occurrenceId: occurrence.occurrenceId });
  }
}

export function validateRemapInput(input: RemapCaptionArtifactV1Input): ValidatedRemapInput {
  if (input === null || typeof input !== "object") contractInvalid("input");
  const artifactResult = captionArtifactV1Schema.safeParse(input.artifact);
  if (!artifactResult.success) contractInvalid("artifact");
  const projectionResult = projectProjectionSchema.safeParse(input.projection);
  if (!projectionResult.success) contractInvalid("projection");

  const timeline = input.timeline;
  if (
    timeline === null ||
    typeof timeline !== "object" ||
    timeline.schemaVersion !== 1 ||
    typeof timeline.projectId !== "string" ||
    typeof timeline.sequenceId !== "string" ||
    typeof timeline.trackId !== "string" ||
    typeof timeline.artifactIdentityKey !== "string" ||
    !mediaContentIdentityV1Schema.safeParse(timeline.sourceIdentity).success ||
    !rationalRateSchema.safeParse(timeline.timelineRate).success ||
    !projectRevisionDescriptorV2Schema.safeParse(timeline.projectRevision).success ||
    !Array.isArray(timeline.occurrences)
  ) {
    projectionInvalid("timeline");
  }

  const artifact = artifactResult.data;
  const projection = projectionResult.data;
  if (
    timeline.projectId !== artifact.trackLink.projectId ||
    projection.projectId !== timeline.projectId
  ) {
    staleIdentity("projectId");
  }
  if (!revisionsEqual(timeline.projectRevision, projection.revision)) {
    throw remapError(
      "invalid_project",
      "Caption remap target revision is stale",
      "caption_remap_stale_revision",
      { field: "targetRevision" },
    );
  }
  if (timeline.projectRevision.number <= artifact.trackLink.projectRevision.number) {
    throw remapError(
      "invalid_project",
      "Caption remap target revision must be strictly newer",
      "caption_remap_stale_revision",
      { field: "projectRevision" },
    );
  }
  if (
    timeline.sequenceId !== artifact.trackLink.sequenceId ||
    timeline.artifactIdentityKey !== artifact.transcriptArtifactIdentityKey ||
    !identitiesEqual(timeline.sourceIdentity, artifact.sourceIdentity)
  ) {
    staleIdentity("timelineLineage");
  }

  const sequence = projection.state.sequences.find(({ id }) => id === timeline.sequenceId);
  if (sequence === undefined || sequence.id !== artifact.trackLink.sequenceId) {
    staleIdentity("sequenceId");
  }
  if (!ratesEqual(sequence.rate, timeline.timelineRate)) projectionInvalid("sequenceRate");
  if (!ratesEqual(artifact.timelineRate, timeline.timelineRate)) {
    throw remapError(
      "invalid_project",
      "Caption remap does not support sequence rate changes",
      "caption_remap_rate_changed",
    );
  }

  const sourceTrack = sequence.tracks.find(({ id }) => id === timeline.trackId);
  if (
    sourceTrack === undefined ||
    sourceTrack.kind === "caption" ||
    sourceTrack.id === artifact.trackLink.captionTrackId
  ) {
    throw remapError(
      "invalid_project",
      "Caption remap source media track is missing",
      "caption_remap_source_track_missing",
      { trackId: timeline.trackId },
    );
  }
  const captionTrack = sequence.tracks.find(({ id }) => id === artifact.trackLink.captionTrackId);
  if (captionTrack === undefined || captionTrack.kind !== "caption") {
    throw remapError(
      "invalid_project",
      "Caption remap target caption track is missing",
      "caption_remap_caption_track_missing",
      { trackId: artifact.trackLink.captionTrackId },
    );
  }
  if (isTrackLocked(captionTrack)) {
    throw remapError(
      "invalid_project",
      "Caption remap target caption track is locked",
      "caption_remap_caption_track_locked",
      { trackId: captionTrack.id },
    );
  }

  const occurrenceIds = new Set<string>();
  const metadataByWordId = new Map<
    string,
    { readonly text: string; readonly sourceStartUs: number; readonly sourceEndUs: number }
  >();
  for (const occurrence of timeline.occurrences) {
    if (
      occurrence === null ||
      typeof occurrence !== "object" ||
      typeof occurrence.occurrenceId !== "string" ||
      occurrence.occurrenceId.length === 0 ||
      occurrenceIds.has(occurrence.occurrenceId)
    ) {
      projectionInvalid("occurrenceId", { occurrenceId: occurrence?.occurrenceId ?? null });
    }
    occurrenceIds.add(occurrence.occurrenceId);
    if (
      !projectRevisionDescriptorV2Schema.safeParse(occurrence.projectRevision).success ||
      !mediaContentIdentityV1Schema.safeParse(occurrence.sourceIdentity).success
    ) {
      projectionInvalid("occurrenceLineage", { occurrenceId: occurrence.occurrenceId });
    }
    if (
      occurrence.projectId !== timeline.projectId ||
      !revisionsEqual(occurrence.projectRevision, timeline.projectRevision) ||
      occurrence.sequenceId !== timeline.sequenceId ||
      occurrence.trackId !== timeline.trackId ||
      occurrence.artifactIdentityKey !== timeline.artifactIdentityKey ||
      !identitiesEqual(occurrence.sourceIdentity, timeline.sourceIdentity)
    ) {
      projectionInvalid("occurrenceLineage", { occurrenceId: occurrence.occurrenceId });
    }
    if (
      typeof occurrence.wordId !== "string" ||
      occurrence.wordId.length === 0 ||
      typeof occurrence.text !== "string" ||
      !Number.isSafeInteger(occurrence.sourceStartUs) ||
      !Number.isSafeInteger(occurrence.sourceEndUs) ||
      occurrence.sourceStartUs < 0 ||
      occurrence.sourceEndUs <= occurrence.sourceStartUs ||
      typeof occurrence.clipId !== "string" ||
      occurrence.clipId.length === 0 ||
      typeof occurrence.assetId !== "string" ||
      occurrence.assetId.length === 0
    ) {
      projectionInvalid("occurrenceWord", { occurrenceId: occurrence.occurrenceId });
    }
    validateOccurrenceRange(occurrence, "sourceRange");
    validateOccurrenceRange(occurrence, "timelineRange");
    if (!timeUsesRate(occurrence.timelineRange.start, timeline.timelineRate)) {
      projectionInvalid("timelineRate", { occurrenceId: occurrence.occurrenceId });
    }
    const metadata = metadataByWordId.get(occurrence.wordId);
    if (
      metadata !== undefined &&
      (metadata.text !== occurrence.text ||
        metadata.sourceStartUs !== occurrence.sourceStartUs ||
        metadata.sourceEndUs !== occurrence.sourceEndUs)
    ) {
      projectionInvalid("occurrenceWordConflict", { wordId: occurrence.wordId });
    }
    metadataByWordId.set(occurrence.wordId, {
      text: occurrence.text,
      sourceStartUs: occurrence.sourceStartUs,
      sourceEndUs: occurrence.sourceEndUs,
    });
  }

  for (const cue of artifact.cues) {
    for (const link of cue.sourceLinks) {
      for (const wordId of link.transcriptWordIds) {
        const metadata = metadataByWordId.get(wordId);
        if (
          metadata !== undefined &&
          (metadata.sourceStartUs < link.sourceStartUs || metadata.sourceEndUs > link.sourceEndUs)
        ) {
          projectionInvalid("occurrenceWordSourceLink", { cueId: cue.cueId, wordId });
        }
      }
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

  return { artifact, timeline, projection, occurrences };
}
