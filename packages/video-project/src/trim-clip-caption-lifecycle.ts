import {
  commandGroupRequestSchema,
  createRationalTime,
  moveClipCommandSchemaV2,
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
  buildApplyCaptionArtifactCommand,
  captionLifecycleError,
  freezeLifecycleResult,
  resolveCaptionLifecycleContext,
  type CaptionLifecycleFailureReasons,
} from "./caption-lifecycle-context.js";
import { projectTranscriptToCandidateTimeline } from "./transcript-edit-mapping.js";
import { remapCaptionArtifactV1AgainstCandidateState } from "./transcript-caption-remap.js";
import type { CaptionRemapReport } from "./transcript-caption-remap-result.js";

export type TrimClipCommandV2 = Extract<ProjectCommandV2, { readonly type: "TrimClip" }>;
export type MoveClipCommandV2 = Extract<ProjectCommandV2, { readonly type: "MoveClip" }>;

export interface PrepareTrimClipCaptionLifecycleV1Input {
  readonly projection: ProjectProjection;
  readonly transcript: TranscriptArtifactV1;
  readonly trimCommand: TrimClipCommandV2;
  readonly moveCommand?: MoveClipCommandV2;
  readonly captionTrackId: string;
  readonly groupId: string;
  readonly applyCaptionArtifactCommandId: string;
}

export interface PrepareTrimClipCaptionLifecycleV1Result {
  readonly commandGroup: Readonly<CommandGroupRequest>;
  readonly report: CaptionRemapReport;
}

const trimCaptionLifecycleFailureReasons = Object.freeze({
  sequenceMissing: "trim_sequence_missing",
  sourceTrackMissing: "trim_source_track_missing",
  sourceTrackLocked: "trim_source_track_locked",
  sourceClipMissing: "trim_clip_missing",
  sourceLineageMismatch: "trim_clip_source_lineage_mismatch",
  sourceLineageAmbiguous: "trim_clip_source_lineage_mismatch",
  captionTrackMissing: "caption_track_missing",
  captionTrackLocked: "caption_track_locked",
  activeArtifactMissing: "active_caption_artifact_missing",
  captionProjectMismatch: "caption_project_mismatch",
  captionSequenceMismatch: "caption_remap_stale_identity",
  captionTrackMismatch: "caption_remap_stale_identity",
  captionRevisionStale: "caption_remap_stale_revision",
  transcriptLineageMismatch: "caption_transcript_lineage_mismatch",
} satisfies CaptionLifecycleFailureReasons);

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
  const moveCommand =
    input.moveCommand === undefined ? undefined : moveClipCommandSchemaV2.parse(input.moveCommand);
  const candidateState = videoProjectStateV2Schema.parse(projection.state);

  const context = resolveCaptionLifecycleContext({
    projection,
    transcript,
    state: candidateState,
    sequenceId: trimCommand.sequenceId,
    sourceTrackId: trimCommand.trackId,
    sourceClipId: trimCommand.clipId,
    captionTrackIds: [input.captionTrackId],
    reasons: trimCaptionLifecycleFailureReasons,
  });
  const { sequence, sourceTrack, sourceAsset } = context;
  const clip = context.sourceClip!;
  const activeCaption = context.activeCaptionTracks[0]!;
  const { track: captionTrack, artifact: activeArtifact } = activeCaption;
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
    throw captionLifecycleError(
      "invalid_range",
      "Trim source geometry is invalid",
      "trim_geometry_invalid",
      { clipId: clip.id },
    );
  }
  const trimChangesSource =
    !timesEqual(trimCommand.sourceIn, clip.sourceIn) ||
    !timesEqual(trimCommand.sourceOut, clip.sourceOut);
  if (moveCommand !== undefined) {
    if (
      moveCommand.sequenceId !== trimCommand.sequenceId ||
      moveCommand.trackId !== trimCommand.trackId ||
      moveCommand.clipId !== trimCommand.clipId
    ) {
      throw captionLifecycleError(
        "invalid_project",
        "Trim move must target the same clip",
        "trim_move_target_mismatch",
        { clipId: trimCommand.clipId },
      );
    }
    if (
      moveCommand.timelineStart.value < 0 ||
      !ratesEqual(rateOf(moveCommand.timelineStart), rateOf(clip.timelineStart))
    ) {
      throw captionLifecycleError(
        "invalid_range",
        "Trim move geometry is invalid",
        "trim_move_geometry_invalid",
        { clipId: trimCommand.clipId },
      );
    }
  }
  const moveChangesTimeline =
    moveCommand !== undefined && !timesEqual(moveCommand.timelineStart, clip.timelineStart);
  if (!trimChangesSource && !moveChangesTimeline) {
    throw captionLifecycleError(
      "invalid_range",
      "Trim geometry does not change the clip",
      "trim_geometry_no_op",
      { clipId: clip.id },
    );
  }

  clip.sourceIn = trimCommand.sourceIn;
  clip.sourceOut = trimCommand.sourceOut;
  if (moveCommand !== undefined) clip.timelineStart = moveCommand.timelineStart;
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
      ...(moveCommand === undefined ? [] : [moveCommand]),
      buildApplyCaptionArtifactCommand(
        input.applyCaptionArtifactCommandId,
        captionTrack,
        remapped.artifact,
      ),
    ],
  });

  return freezeLifecycleResult({ commandGroup, report: remapped.report });
}
