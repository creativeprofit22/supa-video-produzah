import {
  VideoDomainError,
  createRationalTime,
  isTrackLocked,
  projectProjectionSchema,
  rateOf,
  ratesEqual,
  rescaleRationalTime,
  rippleDeleteClipCommandSchemaV2,
  splitClipCommandSchemaV2,
  videoProjectStateV2Schema,
  type ProjectCommandV2,
  type ProjectProjection,
  type VideoProjectStateV2,
} from "@supa-video/contracts";
import {
  transcriptArtifactV1Schema,
  type CaptionArtifactV1,
  type TranscriptArtifactV1,
} from "@supa-video/media";

import {
  buildApplyCaptionArtifactCommand,
  captionLifecycleError,
  freezeLifecycleResult,
  resolveCaptionLifecycleContext,
} from "./caption-lifecycle-context.js";
import { projectTranscriptToCandidateTimeline } from "./transcript-edit-mapping.js";
import { remapCaptionArtifactV1AgainstCandidateState } from "./transcript-caption-remap.js";

export type SplitClipCommandV2 = Extract<ProjectCommandV2, { readonly type: "SplitClip" }>;
export type RippleDeleteClipCommandV2 = Extract<
  ProjectCommandV2,
  { readonly type: "RippleDeleteClip" }
>;
export type SplitDeleteCommandV2 = SplitClipCommandV2 | RippleDeleteClipCommandV2;

export interface PrepareSplitClipCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcriptArtifact?: TranscriptArtifactV1;
  readonly command: SplitClipCommandV2;
}

export type PrepareSplitClipCaptionLifecycleV1Result = readonly SplitClipCommandV2[];

export interface PrepareTranscriptEditCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcriptArtifact?: TranscriptArtifactV1;
  readonly commands: readonly ProjectCommandV2[];
  readonly createCommandId: (captionTrackId: string, ordinal: number) => string | Promise<string>;
}

export type PrepareTranscriptEditCaptionLifecycleV1Result = readonly ProjectCommandV2[];

function replayFailure(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw captionLifecycleError("invalid_project", message, reason, details);
}

function resolveReplayTarget(
  state: VideoProjectStateV2,
  command: SplitDeleteCommandV2,
): {
  sequence: VideoProjectStateV2["sequences"][number];
  track: Exclude<VideoProjectStateV2["sequences"][number]["tracks"][number], { kind: "caption" }>;
  clipIndex: number;
} {
  const sequence = state.sequences.find(({ id }) => id === command.sequenceId);
  if (sequence === undefined) {
    replayFailure(
      "caption_lifecycle_command_target_mismatch",
      "Caption lifecycle command targets an unknown sequence",
      { sequenceId: command.sequenceId },
    );
  }
  const track = sequence.tracks.find(({ id }) => id === command.trackId);
  if (track === undefined || track.kind === "caption") {
    replayFailure(
      "caption_lifecycle_command_target_mismatch",
      "Caption lifecycle command targets an unknown media track",
      { trackId: command.trackId },
    );
  }
  if (isTrackLocked(track)) {
    replayFailure(
      "caption_lifecycle_command_track_locked",
      "Caption lifecycle command targets a locked media track",
      { trackId: track.id },
    );
  }
  const clipIndex = track.clips.findIndex(({ id }) => id === command.clipId);
  if (clipIndex < 0) {
    replayFailure(
      "caption_lifecycle_command_target_mismatch",
      "Caption lifecycle command targets an unknown clip",
      { clipId: command.clipId },
    );
  }
  return { sequence, track, clipIndex };
}

function exactTimelineDuration(
  clip: Exclude<
    VideoProjectStateV2["sequences"][number]["tracks"][number],
    { kind: "caption" }
  >["clips"][number],
  reason: string,
): number {
  if (!ratesEqual(rateOf(clip.sourceIn), rateOf(clip.sourceOut))) {
    replayFailure(reason, "Caption lifecycle clip source rates do not match", { clipId: clip.id });
  }
  try {
    return rescaleRationalTime(
      createRationalTime(clip.sourceOut.value - clip.sourceIn.value, rateOf(clip.sourceIn)),
      rateOf(clip.timelineStart),
      "exact",
    ).value;
  } catch {
    replayFailure(reason, "Caption lifecycle clip duration is not exact", { clipId: clip.id });
  }
}

function replaySplit(state: VideoProjectStateV2, command: SplitClipCommandV2): void {
  const { track, clipIndex } = resolveReplayTarget(state, command);
  if (
    state.sequences.some(({ tracks }) =>
      tracks.some((candidateTrack) =>
        candidateTrack.kind === "caption"
          ? false
          : candidateTrack.clips.some(({ id }) => id === command.rightClipId),
      ),
    )
  ) {
    replayFailure(
      "caption_lifecycle_duplicate_generated_clip_id",
      "Split command would create a duplicate clip ID",
      { rightClipId: command.rightClipId },
    );
  }

  const original = track.clips[clipIndex]!;
  if (
    !ratesEqual(rateOf(original.sourceIn), rateOf(original.sourceOut)) ||
    !ratesEqual(rateOf(original.sourceIn), rateOf(command.splitAt)) ||
    command.splitAt.value <= original.sourceIn.value ||
    command.splitAt.value >= original.sourceOut.value
  ) {
    replayFailure(
      "caption_lifecycle_split_geometry_invalid",
      "Split command geometry is not strictly interior",
      { clipId: original.id },
    );
  }

  let timelineOffset: number;
  try {
    timelineOffset = rescaleRationalTime(
      createRationalTime(
        command.splitAt.value - original.sourceIn.value,
        rateOf(original.sourceIn),
      ),
      rateOf(original.timelineStart),
      "exact",
    ).value;
  } catch {
    replayFailure(
      "caption_lifecycle_split_geometry_inexact",
      "Split command geometry cannot be represented exactly on the timeline",
      { clipId: original.id },
    );
  }
  const rightTimelineStart = original.timelineStart.value + timelineOffset;
  if (!Number.isSafeInteger(rightTimelineStart)) {
    replayFailure(
      "caption_lifecycle_unsafe_integer",
      "Split command exceeds the safe integer range",
      { clipId: original.id },
    );
  }

  const rightClip = structuredClone(original);
  original.sourceOut = command.splitAt;
  rightClip.id = command.rightClipId;
  rightClip.sourceIn = command.splitAt;
  rightClip.timelineStart = createRationalTime(rightTimelineStart, rateOf(original.timelineStart));
  track.clips.splice(clipIndex + 1, 0, rightClip);
}

function replayRippleDelete(state: VideoProjectStateV2, command: RippleDeleteClipCommandV2): void {
  const { track, clipIndex } = resolveReplayTarget(state, command);
  const removed = track.clips[clipIndex]!;
  const duration = exactTimelineDuration(removed, "caption_lifecycle_ripple_geometry_inexact");
  track.clips.splice(clipIndex, 1);
  for (const clip of track.clips.slice(clipIndex)) {
    const shiftedStart = clip.timelineStart.value - duration;
    if (shiftedStart < 0 || !Number.isSafeInteger(shiftedStart)) {
      replayFailure(
        shiftedStart < 0
          ? "caption_lifecycle_ripple_underflow"
          : "caption_lifecycle_unsafe_integer",
        "Ripple delete produced invalid timeline geometry",
        { clipId: clip.id },
      );
    }
    clip.timelineStart = createRationalTime(shiftedStart, rateOf(clip.timelineStart));
  }
}

export function replaySplitDeleteCommandsAgainstCandidateState(
  projectionInput: ProjectProjection,
  commands: readonly ProjectCommandV2[],
): VideoProjectStateV2 {
  const projection = projectProjectionSchema.parse(projectionInput);
  const candidateState = structuredClone(projection.state);
  for (const commandInput of commands) {
    if (commandInput.type === "SplitClip") {
      let command: SplitClipCommandV2;
      try {
        command = splitClipCommandSchemaV2.parse(commandInput);
      } catch {
        replayFailure(
          "caption_lifecycle_command_contract_invalid",
          "Split command contract is invalid",
        );
      }
      replaySplit(candidateState, command);
      continue;
    }
    if (commandInput.type === "RippleDeleteClip") {
      let command: RippleDeleteClipCommandV2;
      try {
        command = rippleDeleteClipCommandSchemaV2.parse(commandInput);
      } catch {
        replayFailure(
          "caption_lifecycle_command_contract_invalid",
          "Ripple delete command contract is invalid",
        );
      }
      replayRippleDelete(candidateState, command);
      continue;
    }
    replayFailure(
      "caption_lifecycle_command_unsupported",
      "Caption lifecycle candidate replay does not support this command",
      { commandType: commandInput.type },
    );
  }

  try {
    return videoProjectStateV2Schema.parse(candidateState);
  } catch {
    replayFailure(
      "caption_lifecycle_candidate_state_invalid",
      "Caption lifecycle candidate state is invalid",
    );
  }
}

function activeCaptionArtifactCount(projection: ProjectProjection, sequenceId: string): number {
  const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return 0;
  return sequence.tracks.filter(
    (track) => track.kind === "caption" && track.activeCaptionArtifact !== undefined,
  ).length;
}

function parseRequiredTranscript(
  transcriptArtifact: TranscriptArtifactV1 | undefined,
): TranscriptArtifactV1 {
  if (transcriptArtifact === undefined) {
    replayFailure(
      "caption_lifecycle_transcript_missing",
      "Active captions require the source transcript artifact",
    );
  }
  try {
    return transcriptArtifactV1Schema.parse(transcriptArtifact);
  } catch {
    replayFailure(
      "caption_lifecycle_transcript_invalid",
      "Caption lifecycle transcript artifact is invalid",
    );
  }
}

function normalizedArtifactJson(
  artifact: CaptionArtifactV1,
  installedRevision: CaptionArtifactV1["trackLink"]["projectRevision"],
): string {
  return JSON.stringify({
    ...artifact,
    trackLink: { ...artifact.trackLink, projectRevision: installedRevision },
  });
}

function lifecycleRemapFailure(error: unknown): never {
  const causeReason =
    error instanceof VideoDomainError && typeof error.details.reason === "string"
      ? error.details.reason
      : undefined;
  replayFailure(
    "caption_lifecycle_remap_failed",
    "Caption lifecycle could not remap active captions",
    causeReason === undefined ? {} : { causeReason },
  );
}

export function prepareSplitClipCaptionLifecycleV1(
  input: PrepareSplitClipCaptionLifecycleV1Input,
): PrepareSplitClipCaptionLifecycleV1Result {
  const projection = projectProjectionSchema.parse(input.projection);
  let command: SplitClipCommandV2;
  try {
    command = splitClipCommandSchemaV2.parse(input.command);
  } catch {
    replayFailure(
      "caption_lifecycle_command_contract_invalid",
      "Split command contract is invalid",
    );
  }

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
  const candidateState = replaySplitDeleteCommandsAgainstCandidateState(projection, [command]);

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

  for (const activeCaption of context.activeCaptionTracks) {
    let remapped: ReturnType<typeof remapCaptionArtifactV1AgainstCandidateState>;
    try {
      remapped = remapCaptionArtifactV1AgainstCandidateState(
        { artifact: activeCaption.artifact, timeline, projection },
        candidateState,
      );
    } catch (error) {
      lifecycleRemapFailure(error);
    }
    if (remapped.report.cues.some(({ outcome }) => outcome !== "retained")) {
      replayFailure(
        "caption_lifecycle_split_outcome_changed",
        "Contiguous split changed a caption cue outcome",
        { trackId: activeCaption.track.id },
      );
    }
    if (
      normalizedArtifactJson(
        remapped.artifact,
        activeCaption.artifact.trackLink.projectRevision,
      ) !== JSON.stringify(activeCaption.artifact)
    ) {
      replayFailure(
        "caption_lifecycle_split_artifact_changed",
        "Contiguous split changed the active caption artifact",
        { trackId: activeCaption.track.id },
      );
    }
  }

  return freezeLifecycleResult([command]);
}

export async function prepareTranscriptEditCaptionLifecycleV1(
  input: PrepareTranscriptEditCaptionLifecycleV1Input,
): Promise<PrepareTranscriptEditCaptionLifecycleV1Result> {
  const projection = projectProjectionSchema.parse(input.projection);
  if (input.commands.length === 0) {
    replayFailure(
      "caption_lifecycle_command_contract_invalid",
      "Transcript edit command list cannot be empty",
    );
  }
  const commands = [...input.commands];
  const firstCommand = commands[0]!;
  if (firstCommand.type !== "SplitClip" && firstCommand.type !== "RippleDeleteClip") {
    replayFailure(
      "caption_lifecycle_command_unsupported",
      "Transcript edit starts with an unsupported command",
      { commandType: firstCommand.type },
    );
  }
  for (const command of commands) {
    if (
      (command.type !== "SplitClip" && command.type !== "RippleDeleteClip") ||
      command.sequenceId !== firstCommand.sequenceId ||
      command.trackId !== firstCommand.trackId
    ) {
      replayFailure(
        "caption_lifecycle_command_target_mismatch",
        "Transcript edit commands must target one media track",
        { commandType: command.type },
      );
    }
  }

  if (activeCaptionArtifactCount(projection, firstCommand.sequenceId) === 0) {
    return freezeLifecycleResult(commands);
  }

  const transcript = parseRequiredTranscript(input.transcriptArtifact);
  const context = resolveCaptionLifecycleContext({
    projection,
    transcript,
    state: projection.state,
    sequenceId: firstCommand.sequenceId,
    sourceTrackId: firstCommand.trackId,
  });
  const combinedCommandCount = commands.length + context.activeCaptionTracks.length;
  if (combinedCommandCount > 100) {
    replayFailure(
      "caption_lifecycle_command_limit_exceeded",
      "Transcript edit and caption applications exceed the atomic command limit",
      { commandCount: combinedCommandCount, commandLimit: 100 },
    );
  }

  const candidateState = replaySplitDeleteCommandsAgainstCandidateState(projection, commands);
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

  const preparedCommands: ProjectCommandV2[] = [...commands];
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
