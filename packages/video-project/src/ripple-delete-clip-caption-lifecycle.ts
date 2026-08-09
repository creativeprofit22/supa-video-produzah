import {
  VideoDomainError,
  applyCaptionArtifactCommandSchemaV2,
  projectProjectionSchema,
  rippleDeleteClipCommandSchemaV2,
  type MediaContentIdentityV1,
  type ProjectCommandV2,
  type ProjectProjection,
} from "@supa-video/contracts";
import { transcriptArtifactV1Schema, type TranscriptArtifactV1 } from "@supa-video/media";

import {
  buildApplyCaptionArtifactCommand,
  captionLifecycleError,
  freezeLifecycleResult,
  resolveCaptionLifecycleContext,
  type CaptionProjectTrack,
} from "./caption-lifecycle-context.js";
import {
  replaySplitDeleteCommandsAgainstCandidateState,
  type RippleDeleteClipCommandV2,
} from "./split-clip-caption-lifecycle.js";
import { remapCaptionArtifactV1AgainstCandidateState } from "./transcript-caption-remap.js";
import {
  identitiesEqual,
  projectTranscriptToCandidateTimeline,
} from "./transcript-edit-mapping.js";

export interface PrepareRippleDeleteClipCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcriptArtifacts?: readonly TranscriptArtifactV1[];
  readonly command: RippleDeleteClipCommandV2;
  readonly createCommandId: (captionTrackId: string, ordinal: number) => string | Promise<string>;
}

export type PrepareRippleDeleteClipCaptionLifecycleV1Result = readonly ProjectCommandV2[];
export type RippleDeleteAffectedCaptionTrackV1 = CaptionProjectTrack;

export interface SelectRippleDeleteAffectedCaptionTracksV1Input {
  readonly projection: ProjectProjection;
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
}

export function selectRippleDeleteAffectedCaptionTracksV1({
  projection,
  sequenceId,
  trackId,
  clipId,
}: SelectRippleDeleteAffectedCaptionTracksV1Input): readonly RippleDeleteAffectedCaptionTrackV1[] {
  const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === trackId);
  if (sequence === undefined || track === undefined || track.kind === "caption") return [];

  const targetIndex = track.clips.findIndex(({ id }) => id === clipId);
  if (targetIndex < 0) return [];

  const changedSourceIdentities: MediaContentIdentityV1[] = [];
  for (const clip of track.clips.slice(targetIndex)) {
    if (clip.source.kind !== "asset") continue;
    const assetId = clip.source.assetId;
    const identity = projection.state.assets.find(({ id }) => id === assetId)?.contentIdentity;
    if (
      identity !== undefined &&
      !changedSourceIdentities.some((candidate) => identitiesEqual(candidate, identity))
    ) {
      changedSourceIdentities.push(identity);
    }
  }

  const affectedCaptionTracks: CaptionProjectTrack[] = [];
  for (const candidateTrack of sequence.tracks) {
    if (candidateTrack.kind !== "caption") continue;
    const activeArtifact = candidateTrack.activeCaptionArtifact;
    if (
      activeArtifact !== undefined &&
      changedSourceIdentities.some((identity) =>
        identitiesEqual(identity, activeArtifact.sourceIdentity),
      )
    ) {
      affectedCaptionTracks.push(candidateTrack);
    }
  }
  return affectedCaptionTracks;
}

function rippleFailure(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw captionLifecycleError("invalid_project", message, reason, details);
}

function parseRippleCommand(commandInput: RippleDeleteClipCommandV2): RippleDeleteClipCommandV2 {
  try {
    return rippleDeleteClipCommandSchemaV2.parse(commandInput);
  } catch {
    rippleFailure(
      "caption_lifecycle_command_contract_invalid",
      "Ripple delete command contract is invalid",
    );
  }
}

function transcriptIdentityKey(identity: {
  readonly key: string;
  readonly sourceIdentity: MediaContentIdentityV1;
}): string {
  const source = identity.sourceIdentity;
  return [identity.key, source.schemaVersion, source.algorithm, source.digest, source.byteLength]
    .map((part) => `${String(part).length}:${String(part)}`)
    .join("|");
}

function parseTranscriptIndex(
  transcriptArtifacts: readonly TranscriptArtifactV1[] | undefined,
): ReadonlyMap<string, TranscriptArtifactV1> {
  const transcripts = new Map<string, TranscriptArtifactV1>();
  for (const artifactInput of transcriptArtifacts ?? []) {
    let artifact: TranscriptArtifactV1;
    try {
      artifact = transcriptArtifactV1Schema.parse(artifactInput);
    } catch {
      rippleFailure(
        "caption_lifecycle_transcript_invalid",
        "Caption lifecycle transcript artifact is invalid",
      );
    }
    const key = transcriptIdentityKey(artifact.identity);
    if (transcripts.has(key)) {
      rippleFailure(
        "caption_lifecycle_transcript_duplicate",
        "Caption lifecycle transcript identity is duplicated",
        { transcriptArtifactIdentityKey: artifact.identity.key },
      );
    }
    transcripts.set(key, artifact);
  }
  return transcripts;
}

function lifecycleRemapFailure(error: unknown): never {
  const causeReason =
    error instanceof VideoDomainError && typeof error.details.reason === "string"
      ? error.details.reason
      : undefined;
  rippleFailure(
    "caption_lifecycle_remap_failed",
    "Caption lifecycle could not remap active captions",
    causeReason === undefined ? {} : { causeReason },
  );
}

export async function prepareRippleDeleteClipCaptionLifecycleV1(
  input: PrepareRippleDeleteClipCaptionLifecycleV1Input,
): Promise<PrepareRippleDeleteClipCaptionLifecycleV1Result> {
  const projection = projectProjectionSchema.parse(input.projection);
  const command = parseRippleCommand(input.command);
  const sequence = projection.state.sequences.find(({ id }) => id === command.sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === command.trackId);
  if (sequence === undefined || track === undefined || track.kind === "caption") {
    rippleFailure(
      "caption_lifecycle_command_target_mismatch",
      "Ripple delete command targets an unknown media track",
      { sequenceId: command.sequenceId, trackId: command.trackId },
    );
  }
  const targetIndex = track.clips.findIndex(({ id }) => id === command.clipId);
  if (targetIndex < 0) {
    rippleFailure(
      "caption_lifecycle_command_target_mismatch",
      "Ripple delete command targets an unknown clip",
      { clipId: command.clipId },
    );
  }

  const affectedCaptionTracks = selectRippleDeleteAffectedCaptionTracksV1({
    projection,
    sequenceId: command.sequenceId,
    trackId: command.trackId,
    clipId: command.clipId,
  });
  const candidateState = replaySplitDeleteCommandsAgainstCandidateState(projection, [command]);
  if (affectedCaptionTracks.length === 0) {
    return freezeLifecycleResult([command]);
  }

  const commandCount = 1 + affectedCaptionTracks.length;
  if (commandCount > 100) {
    rippleFailure(
      "caption_lifecycle_command_limit_exceeded",
      "Ripple delete and caption applications exceed the atomic command limit",
      { commandCount, commandLimit: 100 },
    );
  }

  const transcripts = parseTranscriptIndex(input.transcriptArtifacts);
  const preparedCommands: ProjectCommandV2[] = [command];
  for (const [ordinal, captionTrack] of affectedCaptionTracks.entries()) {
    const activeArtifact = captionTrack.activeCaptionArtifact!;
    const transcript = transcripts.get(
      transcriptIdentityKey({
        key: activeArtifact.transcriptArtifactIdentityKey,
        sourceIdentity: activeArtifact.sourceIdentity,
      }),
    );
    if (transcript === undefined) {
      rippleFailure(
        "caption_lifecycle_transcript_missing",
        "Active captions require an exact source transcript artifact",
        { trackId: captionTrack.id },
      );
    }

    const context = resolveCaptionLifecycleContext({
      projection,
      transcript,
      state: projection.state,
      sequenceId: command.sequenceId,
      sourceTrackId: command.trackId,
      captionTrackIds: [captionTrack.id],
    });
    const activeCaption = context.activeCaptionTracks[0]!;

    let timeline: ReturnType<typeof projectTranscriptToCandidateTimeline>;
    try {
      timeline = projectTranscriptToCandidateTimeline(
        {
          artifact: transcript,
          projection,
          sequenceId: context.sequence.id,
          trackId: context.sourceTrack.id,
        },
        candidateState,
      );
    } catch (error) {
      lifecycleRemapFailure(error);
    }

    let remapped: ReturnType<typeof remapCaptionArtifactV1AgainstCandidateState>;
    try {
      remapped = remapCaptionArtifactV1AgainstCandidateState(
        { artifact: activeCaption.artifact, timeline, projection },
        candidateState,
      );
    } catch (error) {
      lifecycleRemapFailure(error);
    }

    const commandId = await input.createCommandId(captionTrack.id, ordinal);
    try {
      preparedCommands.push(
        applyCaptionArtifactCommandSchemaV2.parse(
          buildApplyCaptionArtifactCommand(commandId, captionTrack, remapped.artifact),
        ),
      );
    } catch {
      rippleFailure(
        "caption_lifecycle_command_contract_invalid",
        "Generated caption application command is invalid",
        { trackId: captionTrack.id },
      );
    }
  }

  return freezeLifecycleResult(preparedCommands);
}
