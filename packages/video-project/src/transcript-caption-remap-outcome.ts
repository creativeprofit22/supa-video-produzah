import { createRationalTime, type RationalRate } from "@supa-video/contracts";
import type { CaptionCueV1 } from "@supa-video/media";

import { projectionInvalid } from "./transcript-caption-remap-input.js";
import { analyzeCuePlacements, type Placement } from "./transcript-caption-remap-placement.js";
import type { LogicalOccurrence } from "./transcript-caption-internal.js";

export type CaptionRemapOutcome =
  "retained" | "moved" | "trimmed" | "split" | "duplicated" | "orphaned";

export interface CueCandidate {
  readonly sourceCue: CaptionCueV1;
  readonly sourceOrdinal: number;
  readonly outcome: Exclude<CaptionRemapOutcome, "orphaned">;
  readonly placement: Placement;
  readonly cue?: CaptionCueV1;
}

export interface ClassifiedCue {
  readonly sourceCue: CaptionCueV1;
  readonly outcome: CaptionRemapOutcome;
  readonly candidates: readonly CueCandidate[];
}

function translatedFullCue(
  cue: CaptionCueV1,
  placement: Placement,
  timelineRate: RationalRate,
): CaptionCueV1 {
  const start = Math.min(
    ...placement.occurrences.map(({ timelineRange }) => timelineRange.start.value),
  );
  const duration = cue.end.value - cue.start.value;
  const end = start + duration;
  if (!Number.isSafeInteger(end)) projectionInvalid("translatedCueRange", { cueId: cue.cueId });
  return {
    ...cue,
    start: createRationalTime(start, timelineRate),
    end: createRationalTime(end, timelineRate),
    lines: [...cue.lines],
    anchor: { ...cue.anchor },
    sourceLinks: cue.sourceLinks.map((link) => ({
      ...link,
      transcriptWordIds: [...link.transcriptWordIds],
    })),
  };
}

export function classifyCue(
  cue: CaptionCueV1,
  sourceOrdinal: number,
  occurrences: readonly LogicalOccurrence[],
  timelineRate: RationalRate,
): ClassifiedCue {
  const placements = analyzeCuePlacements(cue, occurrences, timelineRate);
  if (placements.length === 0) return { sourceCue: cue, outcome: "orphaned", candidates: [] };

  if (placements.every(({ full }) => full)) {
    if (placements.length > 1) {
      return {
        sourceCue: cue,
        outcome: "duplicated",
        candidates: placements.map((placement) => ({
          sourceCue: cue,
          sourceOrdinal,
          outcome: "duplicated",
          placement,
          cue: translatedFullCue(cue, placement, timelineRate),
        })),
      };
    }
    const placement = placements[0]!;
    const translated = translatedFullCue(cue, placement, timelineRate);
    const outcome: "retained" | "moved" =
      translated.start.value === cue.start.value && translated.end.value === cue.end.value
        ? "retained"
        : "moved";
    return {
      sourceCue: cue,
      outcome,
      candidates: [{ sourceCue: cue, sourceOrdinal, outcome, placement, cue: translated }],
    };
  }

  const outcome: "trimmed" | "split" = placements.length === 1 ? "trimmed" : "split";
  return {
    sourceCue: cue,
    outcome,
    candidates: placements.map((placement) => ({
      sourceCue: cue,
      sourceOrdinal,
      outcome,
      placement,
    })),
  };
}
