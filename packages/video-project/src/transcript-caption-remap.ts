import { stitchOccurrences } from "./transcript-caption-input.js";
import {
  validateRemapInput,
  type RemapCaptionArtifactV1Input,
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

export function remapCaptionArtifactV1(
  input: RemapCaptionArtifactV1Input,
): RemapCaptionArtifactV1Result {
  const validated = validateRemapInput(input);
  const logicalOccurrences = stitchOccurrences(validated.occurrences);
  const classified = validated.artifact.cues.map((cue, sourceOrdinal) =>
    classifyCue(cue, sourceOrdinal, logicalOccurrences, validated.timeline.timelineRate),
  );
  return buildRemapResult(validated, classified);
}
