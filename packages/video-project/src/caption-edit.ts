import type { CommandGroupRequest, ProjectProjection } from "@supa-video/contracts";
import {
  validateCaptionArtifactV1,
  type CaptionArtifactV1,
  type CaptionStyleV1,
  type CaptionValidationIssueV1,
} from "@supa-video/media";

import { buildCommandGroup } from "./command-group.js";
import { captionAnchorForAlignment } from "./transcript-caption-artifact.js";

/**
 * Caption style and retime edits. Each edit derives a NEW caption artifact from
 * the active one, validates it against the artifact's own profile (overlap,
 * CPS, line length, cue duration, safe area) and is applied with the existing
 * `ApplyCaptionArtifact` command, so undo/redo/journal recovery are the
 * already-verified caption lifecycle.
 */
export type CaptionEditResult =
  | { readonly ok: true; readonly artifact: CaptionArtifactV1 }
  | { readonly ok: false; readonly issues: readonly CaptionValidationIssueV1[] };

export type CaptionCueEdge = "start" | "end";

export interface ActiveCaptionArtifact {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly artifact: CaptionArtifactV1;
}

/** Finds the active caption artifact on the first caption track that has one. */
export function findActiveCaptionArtifact(
  projection: ProjectProjection,
  sequenceId: string,
): ActiveCaptionArtifact | null {
  const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
  for (const track of sequence?.tracks ?? []) {
    if (track.kind === "caption" && track.activeCaptionArtifact !== undefined) {
      return { sequenceId, trackId: track.id, artifact: track.activeCaptionArtifact };
    }
  }
  return null;
}

function relinked(artifact: CaptionArtifactV1, projection: ProjectProjection): CaptionArtifactV1 {
  return {
    ...artifact,
    trackLink: { ...artifact.trackLink, projectRevision: projection.revision },
  };
}

function checked(candidate: CaptionArtifactV1): CaptionEditResult {
  const validation = validateCaptionArtifactV1(candidate);
  return validation.valid
    ? { ok: true, artifact: candidate }
    : { ok: false, issues: validation.issues };
}

/**
 * Applies a new style. Alignment changes re-anchor every cue from the safe
 * area, so anchors can never leave it.
 */
export function restyleCaptionArtifactV1(
  artifact: CaptionArtifactV1,
  style: CaptionStyleV1,
  projection: ProjectProjection,
): CaptionEditResult {
  const anchor = captionAnchorForAlignment(style.alignment, artifact.validationProfile.safeArea);
  return checked({
    ...relinked(artifact, projection),
    style,
    cues: artifact.cues.map((cue) => ({ ...cue, anchor: { ...anchor } })),
  });
}

/** Moves one edge of one cue by whole frames at the artifact's timeline rate. */
export function retimeCaptionCueV1(
  artifact: CaptionArtifactV1,
  cueId: string,
  edge: CaptionCueEdge,
  deltaFrames: number,
  projection: ProjectProjection,
): CaptionEditResult {
  if (!Number.isSafeInteger(deltaFrames) || deltaFrames === 0) {
    return {
      ok: false,
      issues: [{ code: "CAPTION_CUE_DURATION_NON_POSITIVE", path: "$.deltaFrames", cueId }],
    };
  }
  const index = artifact.cues.findIndex((cue) => cue.cueId === cueId);
  const cue = artifact.cues[index];
  if (cue === undefined) {
    return {
      ok: false,
      issues: [{ code: "CAPTION_SCHEMA_INVALID", path: "$.cueId", cueId: null }],
    };
  }
  const time = cue[edge];
  const value = time.value + deltaFrames;
  if (value < 0) {
    return {
      ok: false,
      issues: [
        { code: "CAPTION_CUE_DURATION_NON_POSITIVE", path: `$.cues[${index}].${edge}`, cueId },
      ],
    };
  }
  const cues = artifact.cues.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, [edge]: { ...time, value } } : candidate,
  );
  return checked({ ...relinked(artifact, projection), cues });
}

export interface BuildCaptionEditGroupInput {
  readonly projection: ProjectProjection;
  readonly active: ActiveCaptionArtifact;
  readonly artifact: CaptionArtifactV1;
  readonly groupId: string;
  readonly commandId: string;
}

export function buildCaptionEditCommandGroup(
  input: BuildCaptionEditGroupInput,
): Readonly<CommandGroupRequest> {
  return buildCommandGroup({
    groupId: input.groupId,
    projectId: input.projection.projectId,
    baseRevision: input.projection.revision.number,
    commands: [
      {
        type: "ApplyCaptionArtifact",
        commandId: input.commandId,
        sequenceId: input.active.sequenceId,
        trackId: input.active.trackId,
        artifact: input.artifact,
      },
    ],
  });
}
