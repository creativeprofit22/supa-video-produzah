import type { VideoProjectStateV2 } from "@supa-video/contracts";

import { stitchOccurrences } from "./transcript-caption-input.js";
import {
  validateRemapInput,
  validateRemapInputAgainstCandidateState,
  type RemapCaptionArtifactV1Input,
  type ValidatedRemapInput,
} from "./transcript-caption-remap-input.js";
import { classifyCue } from "./transcript-caption-remap-outcome.js";
import {
  buildRemapResult,
  type RemapCaptionArtifactV1Result,
} from "./transcript-caption-remap-result.js";

export type { RemapCaptionArtifactV1Input } from "./transcript-caption-remap-input.js";
export type { CaptionRemapOutcome } from "./transcript-caption-remap-outcome.js";
export type {
  CaptionCueRemapRecord,
  CaptionRemapReport,
  CaptionRemapTargetCue,
  RemapCaptionArtifactV1Result,
} from "./transcript-caption-remap-result.js";

function remapValidatedInput(validated: ValidatedRemapInput): RemapCaptionArtifactV1Result {
  const logicalOccurrences = stitchOccurrences(validated.occurrences);
  const classified = validated.artifact.cues.map((cue, sourceOrdinal) =>
    classifyCue(cue, sourceOrdinal, logicalOccurrences, validated.timeline.timelineRate),
  );
  return buildRemapResult(validated, classified);
}

export function remapCaptionArtifactV1(
  input: RemapCaptionArtifactV1Input,
): RemapCaptionArtifactV1Result {
  return remapValidatedInput(validateRemapInput(input));
}

export function remapCaptionArtifactV1AgainstCandidateState(
  input: RemapCaptionArtifactV1Input,
  candidateState: VideoProjectStateV2,
): RemapCaptionArtifactV1Result {
  return remapValidatedInput(validateRemapInputAgainstCandidateState(input, candidateState));
}
