import type { CaptionArtifactV1 } from "@supa-video/media";

import { buildCaptionArtifactV1 } from "./transcript-caption-artifact.js";
import { displayUnits } from "./transcript-caption-display.js";
import { groupDisplayUnits } from "./transcript-caption-grouping.js";
import {
  frameConstraints,
  validateCaptionInput,
  type GenerateCaptionArtifactV1Input,
} from "./transcript-caption-input.js";

export type { GenerateCaptionArtifactV1Input } from "./transcript-caption-input.js";

export function generateCaptionArtifactV1(
  generatorInput: GenerateCaptionArtifactV1Input,
): CaptionArtifactV1 {
  const input = validateCaptionInput(generatorInput);
  const constraints = frameConstraints(input);
  const units = displayUnits(input.occurrences);
  const groups = groupDisplayUnits(units, input, constraints);
  return buildCaptionArtifactV1(input, groups, constraints);
}
