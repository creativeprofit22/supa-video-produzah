import {
  VideoDomainError,
  clipTimelineDuration,
  isTrackLocked,
  moveClipCommandSchemaV2,
  projectProjectionSchema,
  rateOf,
  ratesEqual,
  videoProjectStateV2Schema,
  type ProjectCommandV2,
  type ProjectProjection,
  type VideoProjectStateV2,
} from "@supa-video/contracts";
import { transcriptArtifactV1Schema, type TranscriptArtifactV1 } from "@supa-video/media";

import {
  buildApplyCaptionArtifactCommand,
  captionLifecycleError,
  freezeLifecycleResult,
  resolveCaptionLifecycleContext,
} from "./caption-lifecycle-context.js";
import { projectTranscriptToCandidateTimeline } from "./transcript-edit-mapping.js";
import { remapCaptionArtifactV1AgainstCandidateState } from "./transcript-caption-remap.js";

export type MoveClipCommandV2 = Extract<ProjectCommandV2, { readonly type: "MoveClip" }>;

export interface PrepareMoveClipCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcriptArtifact?: TranscriptArtifactV1;
  readonly command: MoveClipCommandV2;
  readonly createCommandId: (captionTrackId: string, ordinal: number) => string | Promise<string>;
}

export type PrepareMoveClipCaptionLifecycleV1Result = readonly ProjectCommandV2[];

function moveFailure(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw captionLifecycleError("invalid_project", message, reason, details);
}

function activeCaptionArtifactCount(projection: ProjectProjection, sequenceId: string): number {
  const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return 0;
  return sequence.tracks.filter(
    (track) => track.kind === "caption" && track.activeCaptionArtifact !== undefined,
  ).length;
}

function parseMoveCommand(commandInput: MoveClipCommandV2): MoveClipCommandV2 {
  try {
    return moveClipCommandSchemaV2.parse(commandInput);
  } catch {
    moveFailure("caption_lifecycle_command_contract_invalid", "Move command contract is invalid");
  }
}

function parseRequiredTranscript(
  transcriptArtifact: TranscriptArtifactV1 | undefined,
): TranscriptArtifactV1 {
  if (transcriptArtifact === undefined) {
    moveFailure(
      "caption_lifecycle_transcript_missing",
      "Active captions require the source transcript artifact",
    );
  }
  try {
    return transcriptArtifactV1Schema.parse(transcriptArtifact);
  } catch {
    moveFailure(
      "caption_lifecycle_transcript_invalid",
      "Caption lifecycle transcript artifact is invalid",
    );
  }
}

function lifecycleRemapFailure(error: unknown): never {
  const causeReason =
    error instanceof VideoDomainError && typeof error.details.reason === "string"
      ? error.details.reason
      : undefined;
  moveFailure(
    "caption_lifecycle_remap_failed",
    "Caption lifecycle could not remap active captions",
    causeReason === undefined ? {} : { causeReason },
  );
}

function replayMoveAgainstCandidateState(
  projection: ProjectProjection,
  command: MoveClipCommandV2,
): VideoProjectStateV2 {
  const candidateState = structuredClone(projection.state);
  const sequence = candidateState.sequences.find(({ id }) => id === command.sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === command.trackId);
  if (sequence === undefined || track === undefined || track.kind === "caption") {
    moveFailure(
      "caption_lifecycle_command_target_mismatch",
      "Move command targets an unknown media track",
      { sequenceId: command.sequenceId, trackId: command.trackId },
    );
  }
  if (isTrackLocked(track)) {
    moveFailure(
      "caption_lifecycle_source_track_locked",
      "Move command targets a locked media track",
      { trackId: track.id },
    );
  }
  const clip = track.clips.find(({ id }) => id === command.clipId);
  if (clip === undefined) {
    moveFailure(
      "caption_lifecycle_command_target_mismatch",
      "Move command targets an unknown clip",
      {
        clipId: command.clipId,
      },
    );
  }
  if (
    command.timelineStart.value < 0 ||
    !ratesEqual(rateOf(command.timelineStart), rateOf(clip.timelineStart))
  ) {
    moveFailure(
      "caption_lifecycle_move_geometry_invalid",
      "Move command timeline geometry is invalid",
      { clipId: clip.id },
    );
  }
  if (!ratesEqual(rateOf(clip.sourceIn), rateOf(clip.sourceOut))) {
    moveFailure("caption_lifecycle_move_geometry_invalid", "Moved clip source rates do not match", {
      clipId: clip.id,
    });
  }

  let duration: number;
  try {
    duration = clipTimelineDuration(
      { in: clip.sourceIn, out: clip.sourceOut },
      rateOf(clip.timelineStart),
      clip.speed,
    ).value;
  } catch {
    moveFailure(
      "caption_lifecycle_move_geometry_inexact",
      "Moved clip duration cannot be represented exactly on the timeline",
      { clipId: clip.id },
    );
  }
  const timelineEnd = command.timelineStart.value + duration;
  if (!Number.isSafeInteger(timelineEnd)) {
    moveFailure("caption_lifecycle_unsafe_integer", "Move command exceeds the safe integer range", {
      clipId: clip.id,
    });
  }

  clip.timelineStart = command.timelineStart;
  try {
    return videoProjectStateV2Schema.parse(candidateState);
  } catch {
    moveFailure(
      "caption_lifecycle_candidate_state_invalid",
      "Move command produced an invalid candidate state",
    );
  }
}

export async function prepareMoveClipCaptionLifecycleV1(
  input: PrepareMoveClipCaptionLifecycleV1Input,
): Promise<PrepareMoveClipCaptionLifecycleV1Result> {
  const projection = projectProjectionSchema.parse(input.projection);
  const command = parseMoveCommand(input.command);
  const candidateState = replayMoveAgainstCandidateState(projection, command);

  if (activeCaptionArtifactCount(projection, command.sequenceId) === 0) {
    return freezeLifecycleResult([command]);
  }

  const transcript = parseRequiredTranscript(input.transcriptArtifact);
  const context = resolveCaptionLifecycleContext({
    projection,
    transcript,
    state: projection.state,
    sequenceId: command.sequenceId,
    sourceTrackId: command.trackId,
    sourceClipId: command.clipId,
  });
  const combinedCommandCount = 1 + context.activeCaptionTracks.length;
  if (combinedCommandCount > 100) {
    moveFailure(
      "caption_lifecycle_command_limit_exceeded",
      "Move and caption applications exceed the atomic command limit",
      { commandCount: combinedCommandCount, commandLimit: 100 },
    );
  }

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

  const preparedCommands: ProjectCommandV2[] = [command];
  for (const [ordinal, activeCaption] of context.activeCaptionTracks.entries()) {
    let remapped: ReturnType<typeof remapCaptionArtifactV1AgainstCandidateState>;
    try {
      remapped = remapCaptionArtifactV1AgainstCandidateState(
        { artifact: activeCaption.artifact, timeline, projection },
        candidateState,
      );
    } catch (error) {
      lifecycleRemapFailure(error);
    }
    const commandId = await input.createCommandId(activeCaption.track.id, ordinal);
    preparedCommands.push(
      buildApplyCaptionArtifactCommand(commandId, activeCaption.track, remapped.artifact),
    );
  }
  return freezeLifecycleResult(preparedCommands);
}
