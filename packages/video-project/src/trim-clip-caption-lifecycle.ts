import {
  VideoDomainError,
  commandGroupRequestSchema,
  createRationalTime,
  isTrackLocked,
  projectProjectionSchema,
  rateOf,
  ratesEqual,
  rescaleRationalTime,
  trimClipCommandSchemaV2,
  videoProjectStateV2Schema,
  type CommandGroupRequest,
  type ProjectCommandV2,
  type ProjectProjection,
} from "@supa-video/contracts";
import { transcriptArtifactV1Schema, type TranscriptArtifactV1 } from "@supa-video/media";

import {
  identitiesEqual,
  projectTranscriptToCandidateTimeline,
} from "./transcript-edit-mapping.js";
import { remapCaptionArtifactV1AgainstCandidateState } from "./transcript-caption-remap.js";
import type { CaptionRemapReport } from "./transcript-caption-remap-result.js";

export type TrimClipCommandV2 = Extract<ProjectCommandV2, { readonly type: "TrimClip" }>;

export interface PrepareTrimClipCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcript: TranscriptArtifactV1;
  readonly trimCommand: TrimClipCommandV2;
  readonly captionTrackId: string;
  readonly groupId: string;
  readonly applyCaptionArtifactCommandId: string;
}

export interface PrepareTrimClipCaptionLifecycleV1Result {
  readonly commandGroup: Readonly<CommandGroupRequest>;
  readonly report: CaptionRemapReport;
}

function lifecycleError(
  code: "invalid_project" | "invalid_range",
  message: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function timesEqual(
  left: TrimClipCommandV2["sourceIn"],
  right: TrimClipCommandV2["sourceIn"],
): boolean {
  return (
    left.value === right.value &&
    left.rateNumerator === right.rateNumerator &&
    left.rateDenominator === right.rateDenominator
  );
}

export function prepareTrimClipCaptionLifecycleV1(
  input: PrepareTrimClipCaptionLifecycleV1Input,
): PrepareTrimClipCaptionLifecycleV1Result {
  const projection = projectProjectionSchema.parse(input.projection);
  const transcript = transcriptArtifactV1Schema.parse(input.transcript);
  const trimCommand = trimClipCommandSchemaV2.parse(input.trimCommand);
  const candidateState = videoProjectStateV2Schema.parse(projection.state);

  const sequence = candidateState.sequences.find(({ id }) => id === trimCommand.sequenceId);
  if (sequence === undefined) {
    throw lifecycleError(
      "invalid_project",
      "Trim target sequence does not exist",
      "trim_sequence_missing",
      { sequenceId: trimCommand.sequenceId },
    );
  }

  const sourceTrack = sequence.tracks.find(({ id }) => id === trimCommand.trackId);
  if (sourceTrack === undefined || sourceTrack.kind === "caption") {
    throw lifecycleError(
      "invalid_project",
      "Trim target media track does not exist",
      "trim_source_track_missing",
      { trackId: trimCommand.trackId },
    );
  }
  if (isTrackLocked(sourceTrack)) {
    throw lifecycleError(
      "invalid_project",
      "Trim target media track is locked",
      "trim_source_track_locked",
      { trackId: sourceTrack.id },
    );
  }

  const clip = sourceTrack.clips.find(({ id }) => id === trimCommand.clipId);
  if (clip === undefined) {
    throw lifecycleError(
      "invalid_project",
      "Trim target clip does not exist",
      "trim_clip_missing",
      { clipId: trimCommand.clipId },
    );
  }
  const sourceAssetId = clip.source.kind === "asset" ? clip.source.assetId : undefined;
  const sourceAsset =
    sourceAssetId === undefined
      ? undefined
      : candidateState.assets.find(({ id }) => id === sourceAssetId);
  if (sourceAsset?.contentIdentity === undefined) {
    throw lifecycleError(
      "invalid_project",
      "Trim target clip does not have an identified media source",
      "trim_clip_source_lineage_mismatch",
      { clipId: clip.id },
    );
  }
  const sourceDuration = rescaleRationalTime(
    createRationalTime(sourceAsset.probe.durationMicroseconds, {
      numerator: 1_000_000,
      denominator: 1,
    }),
    rateOf(trimCommand.sourceIn),
    "ceil",
  );
  if (
    trimCommand.sourceOut.value <= trimCommand.sourceIn.value ||
    trimCommand.sourceOut.value > sourceDuration.value ||
    !ratesEqual(rateOf(trimCommand.sourceIn), rateOf(trimCommand.sourceOut)) ||
    !ratesEqual(rateOf(trimCommand.sourceIn), rateOf(clip.sourceIn))
  ) {
    throw lifecycleError(
      "invalid_range",
      "Trim source geometry is invalid",
      "trim_geometry_invalid",
      { clipId: clip.id },
    );
  }
  if (
    timesEqual(trimCommand.sourceIn, clip.sourceIn) &&
    timesEqual(trimCommand.sourceOut, clip.sourceOut)
  ) {
    throw lifecycleError(
      "invalid_range",
      "Trim source geometry does not change the clip",
      "trim_geometry_no_op",
      { clipId: clip.id },
    );
  }

  const captionTrack = sequence.tracks.find(({ id }) => id === input.captionTrackId);
  if (captionTrack === undefined || captionTrack.kind !== "caption") {
    throw lifecycleError(
      "invalid_project",
      "Caption target track does not exist",
      "caption_track_missing",
      { trackId: input.captionTrackId },
    );
  }
  if (isTrackLocked(captionTrack)) {
    throw lifecycleError(
      "invalid_project",
      "Caption target track is locked",
      "caption_track_locked",
      { trackId: captionTrack.id },
    );
  }
  const activeArtifact = captionTrack.activeCaptionArtifact;
  if (activeArtifact === undefined) {
    throw lifecycleError(
      "invalid_project",
      "Caption target track has no active artifact",
      "active_caption_artifact_missing",
      { trackId: captionTrack.id },
    );
  }
  if (activeArtifact.trackLink.projectId !== projection.projectId) {
    throw lifecycleError(
      "invalid_project",
      "Active caption artifact belongs to another project",
      "caption_project_mismatch",
      { trackId: captionTrack.id },
    );
  }
  if (
    transcript.identity.key !== activeArtifact.transcriptArtifactIdentityKey ||
    !identitiesEqual(transcript.identity.sourceIdentity, activeArtifact.sourceIdentity)
  ) {
    throw lifecycleError(
      "invalid_project",
      "Transcript lineage does not match the active caption artifact",
      "caption_transcript_lineage_mismatch",
      { trackId: captionTrack.id },
    );
  }
  if (!identitiesEqual(sourceAsset.contentIdentity, transcript.identity.sourceIdentity)) {
    throw lifecycleError(
      "invalid_project",
      "Trim target clip does not match the caption transcript source",
      "trim_clip_source_lineage_mismatch",
      { clipId: clip.id },
    );
  }

  clip.sourceIn = trimCommand.sourceIn;
  clip.sourceOut = trimCommand.sourceOut;
  const validatedCandidateState = videoProjectStateV2Schema.parse(candidateState);
  const timeline = projectTranscriptToCandidateTimeline(
    {
      artifact: transcript,
      projection,
      sequenceId: sequence.id,
      trackId: sourceTrack.id,
    },
    validatedCandidateState,
  );
  const remapped = remapCaptionArtifactV1AgainstCandidateState(
    { artifact: activeArtifact, timeline, projection },
    validatedCandidateState,
  );
  const commandGroup = commandGroupRequestSchema.parse({
    groupId: input.groupId,
    projectId: projection.projectId,
    baseRevision: projection.revision.number,
    commands: [
      trimCommand,
      {
        type: "ApplyCaptionArtifact",
        commandId: input.applyCaptionArtifactCommandId,
        sequenceId: sequence.id,
        trackId: captionTrack.id,
        artifact: remapped.artifact,
      },
    ],
  });

  return freezeDeep({ commandGroup, report: remapped.report });
}
