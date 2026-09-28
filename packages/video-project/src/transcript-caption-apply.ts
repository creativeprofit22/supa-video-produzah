import {
  createRationalTime,
  type CommandGroupRequest,
  type ProjectProjection,
  type RationalRate,
} from "@supa-video/contracts";
import type {
  CaptionStyleV1,
  CaptionValidationProfileV1,
  TranscriptArtifactV1,
} from "@supa-video/media";

import { buildCommandGroup } from "./command-group.js";
import { generateCaptionArtifactV1 } from "./transcript-caption.js";
import { projectTranscriptToTimeline } from "./transcript-edit-mapping.js";

/** Readable defaults: two lines, 42 characters, 20 characters per second. */
export const DEFAULT_CAPTION_STYLE_V1: CaptionStyleV1 = Object.freeze({
  schemaVersion: 1,
  typography: Object.freeze({
    fontFamily: "Arial",
    fontSizePx: 48,
    fontWeight: 600,
    fontStyle: "normal",
    lineHeightPermille: 1_200,
    foregroundColorRgba: "#ffffffff",
  }),
  alignment: Object.freeze({ horizontal: "center", vertical: "bottom" }),
}) as CaptionStyleV1;

export function defaultCaptionValidationProfileV1(rate: RationalRate): CaptionValidationProfileV1 {
  const framesPerSecond = rate.numerator / rate.denominator;
  const minimumFrames = Math.max(1, Math.ceil((framesPerSecond * 5) / 6));
  const maximumFrames = Math.max(minimumFrames, Math.floor(framesPerSecond * 7));
  return {
    schemaVersion: 1,
    maxLinesPerCue: 2,
    maxCharactersPerLine: 42,
    maxCharactersPerSecond: 20,
    minimumCueDuration: createRationalTime(minimumFrames, rate),
    maximumCueDuration: createRationalTime(maximumFrames, rate),
    safeArea: { topPermille: 50, rightPermille: 50, bottomPermille: 50, leftPermille: 50 },
  };
}

export interface BuildGenerateCaptionsGroupInput {
  readonly artifact: TranscriptArtifactV1;
  readonly projection: ProjectProjection;
  readonly sequenceId: string;
  /** Media track whose clips reference the transcribed source. */
  readonly trackId: string;
  readonly language: string;
  readonly groupId: string;
  readonly applyCommandId: string;
  /** Used only when the sequence has no caption track yet. */
  readonly insertTrackCommandId: string;
  readonly newCaptionTrackId: string;
  readonly style?: CaptionStyleV1;
  readonly validationProfile?: CaptionValidationProfileV1;
}

export interface GenerateCaptionsGroup {
  readonly captionTrackId: string;
  readonly insertsTrack: boolean;
  readonly cueCount: number;
  readonly commandGroup: Readonly<CommandGroupRequest>;
}

/**
 * Generates captions from a transcript and packages them as one undoable
 * command group built only from existing command types: an optional
 * `InsertTrack` (caption) followed by `ApplyCaptionArtifact`. Undo, redo and
 * journal recovery are therefore the already verified caption lifecycle.
 */
export function buildGenerateCaptionsCommandGroup(
  input: BuildGenerateCaptionsGroupInput,
): GenerateCaptionsGroup {
  const sequence = input.projection.state.sequences.find(({ id }) => id === input.sequenceId);
  if (sequence === undefined) {
    throw new Error("The caption sequence is not in the project");
  }
  const existing = sequence.tracks.find((track) => track.kind === "caption");
  const captionTrackId = existing?.id ?? input.newCaptionTrackId;
  const timeline = projectTranscriptToTimeline({
    artifact: input.artifact,
    projection: input.projection,
    sequenceId: input.sequenceId,
    trackId: input.trackId,
  });
  const captions = generateCaptionArtifactV1({
    artifact: input.artifact,
    timeline,
    captionTrackId,
    language: input.language,
    style: input.style ?? DEFAULT_CAPTION_STYLE_V1,
    validationProfile: input.validationProfile ?? defaultCaptionValidationProfileV1(sequence.rate),
  });
  const insert =
    existing === undefined
      ? [
          {
            type: "InsertTrack" as const,
            commandId: input.insertTrackCommandId,
            sequenceId: input.sequenceId,
            index: sequence.tracks.length,
            track: { id: captionTrackId, name: "Captions", kind: "caption" as const, captions: [] },
          },
        ]
      : [];
  const commandGroup = buildCommandGroup({
    groupId: input.groupId,
    projectId: input.projection.projectId,
    baseRevision: input.projection.revision.number,
    commands: [
      ...insert,
      {
        type: "ApplyCaptionArtifact",
        commandId: input.applyCommandId,
        sequenceId: input.sequenceId,
        trackId: captionTrackId,
        artifact: captions,
      },
    ],
  });
  return {
    captionTrackId,
    insertsTrack: existing === undefined,
    cueCount: captions.cues.length,
    commandGroup,
  };
}
