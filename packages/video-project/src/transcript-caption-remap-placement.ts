import {
  createRationalTime,
  rescaleRationalTime,
  type RationalRate,
  type RationalTime,
} from "@supa-video/contracts";
import type { CaptionCueV1 } from "@supa-video/media";

import { projectionInvalid, remapError } from "./transcript-caption-remap-input.js";
import type { LogicalOccurrence } from "./transcript-caption-internal.js";

interface LinkedWord {
  readonly wordId: string;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
}

export interface Placement {
  readonly translation: number;
  readonly occurrences: readonly LogicalOccurrence[];
  readonly fullWordIds: ReadonlySet<string>;
  readonly coveredWordIds: ReadonlySet<string>;
  readonly full: boolean;
}

function sourceRateOf(occurrence: LogicalOccurrence): RationalRate {
  return {
    numerator: occurrence.sourceRange.start.rateNumerator,
    denominator: occurrence.sourceRange.start.rateDenominator,
  };
}

function exactSourceFrameAtTimelineRate(time: RationalTime, rate: RationalRate): number {
  try {
    return rescaleRationalTime(time, rate, "exact").value;
  } catch {
    projectionInvalid("occurrenceTransform");
  }
}

function occurrenceTranslation(occurrence: LogicalOccurrence, timelineRate: RationalRate): number {
  const sourceStart = exactSourceFrameAtTimelineRate(occurrence.sourceRange.start, timelineRate);
  const sourceEnd = exactSourceFrameAtTimelineRate(occurrence.sourceRange.end, timelineRate);
  const startTranslation = occurrence.timelineRange.start.value - sourceStart;
  const endTranslation = occurrence.timelineRange.end.value - sourceEnd;
  if (
    startTranslation !== endTranslation ||
    !Number.isSafeInteger(startTranslation) ||
    !Number.isSafeInteger(endTranslation)
  ) {
    projectionInvalid("occurrenceTransform", { occurrenceId: occurrence.occurrenceId });
  }
  return startTranslation;
}

function linkedWordsForCue(
  cue: CaptionCueV1,
  occurrences: readonly LogicalOccurrence[],
): readonly LinkedWord[] {
  return cue.sourceLinks.flatMap((link) =>
    link.transcriptWordIds.map((wordId) => {
      const occurrence = occurrences.find((candidate) => candidate.wordId === wordId);
      return {
        wordId,
        sourceStartUs: occurrence?.sourceStartUs ?? link.sourceStartUs,
        sourceEndUs: occurrence?.sourceEndUs ?? link.sourceEndUs,
      };
    }),
  );
}

function expectedWordFrameRange(
  word: LinkedWord,
  occurrence: LogicalOccurrence,
  timelineRate: RationalRate,
): readonly [number, number] {
  const microsecondRate = { numerator: 1_000_000, denominator: 1 } as const;
  try {
    const sourceRate = sourceRateOf(occurrence);
    const sourceStart = rescaleRationalTime(
      createRationalTime(word.sourceStartUs, microsecondRate),
      sourceRate,
      "floor",
    );
    const sourceEnd = rescaleRationalTime(
      createRationalTime(word.sourceEndUs, microsecondRate),
      sourceRate,
      "ceil",
    );
    return [
      rescaleRationalTime(sourceStart, timelineRate, "exact").value,
      rescaleRationalTime(sourceEnd, timelineRate, "exact").value,
    ];
  } catch {
    projectionInvalid("occurrenceTransform", { wordId: word.wordId });
  }
}

function coverageForWord(
  word: LinkedWord,
  occurrences: readonly LogicalOccurrence[],
  timelineRate: RationalRate,
): "none" | "partial" | "full" {
  const matching = occurrences.filter(({ wordId }) => wordId === word.wordId);
  if (matching.length === 0) return "none";
  const expected = expectedWordFrameRange(word, matching[0]!, timelineRate);
  const ranges = matching
    .map((occurrence): [number, number] => {
      const occurrenceExpected = expectedWordFrameRange(word, occurrence, timelineRate);
      if (occurrenceExpected[0] !== expected[0] || occurrenceExpected[1] !== expected[1]) {
        projectionInvalid("occurrenceWordRate", { wordId: word.wordId });
      }
      const start = exactSourceFrameAtTimelineRate(occurrence.sourceRange.start, timelineRate);
      const end = exactSourceFrameAtTimelineRate(occurrence.sourceRange.end, timelineRate);
      if (start < expected[0] || end > expected[1]) {
        projectionInvalid("occurrenceWordRange", { occurrenceId: occurrence.occurrenceId });
      }
      return [start, end];
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged.length === 1 && merged[0]![0] === expected[0] && merged[0]![1] === expected[1]
    ? "full"
    : "partial";
}

function placementsForCue(
  cue: CaptionCueV1,
  occurrences: readonly LogicalOccurrence[],
  timelineRate: RationalRate,
): readonly Placement[] {
  const linkedWords = linkedWordsForCue(cue, occurrences);
  const linkedWordIds = new Set(linkedWords.map(({ wordId }) => wordId));
  const groups = new Map<number, LogicalOccurrence[]>();
  for (const occurrence of occurrences) {
    if (!linkedWordIds.has(occurrence.wordId)) continue;
    const translation = occurrenceTranslation(occurrence, timelineRate);
    const group = groups.get(translation) ?? [];
    group.push(occurrence);
    groups.set(translation, group);
  }

  return [...groups.entries()]
    .map(([translation, group]): Placement => {
      const fullWordIds = new Set<string>();
      const coveredWordIds = new Set<string>();
      for (const word of linkedWords) {
        const coverage = coverageForWord(word, group, timelineRate);
        if (coverage !== "none") coveredWordIds.add(word.wordId);
        if (coverage === "full") fullWordIds.add(word.wordId);
      }
      return {
        translation,
        occurrences: group,
        fullWordIds,
        coveredWordIds,
        full: linkedWords.every(({ wordId }) => fullWordIds.has(wordId)),
      };
    })
    .filter(({ coveredWordIds }) => coveredWordIds.size > 0)
    .sort((left, right) => {
      const leftStart = Math.min(
        ...left.occurrences.map(({ timelineRange }) => timelineRange.start.value),
      );
      const rightStart = Math.min(
        ...right.occurrences.map(({ timelineRange }) => timelineRange.start.value),
      );
      return leftStart - rightStart || left.translation - right.translation;
    });
}

function validateUnambiguousPlacements(placements: readonly Placement[]): void {
  const fullCount = placements.filter(({ full }) => full).length;
  if (fullCount > 0 && fullCount !== placements.length) {
    throw remapError(
      "invalid_project",
      "Caption remap occurrences mix complete and partial placements",
      "caption_remap_ambiguous_occurrences",
    );
  }
  if (fullCount === 0 && placements.length > 1) {
    const seenWordIds = new Set<string>();
    for (const placement of placements) {
      for (const wordId of placement.coveredWordIds) {
        if (seenWordIds.has(wordId)) {
          throw remapError(
            "invalid_project",
            "Caption remap repeats partial source coverage",
            "caption_remap_ambiguous_occurrences",
            { wordId },
          );
        }
        seenWordIds.add(wordId);
      }
    }
  }
  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    const left = placements[leftIndex]!;
    const leftStart = Math.min(
      ...left.occurrences.map(({ timelineRange }) => timelineRange.start.value),
    );
    const leftEnd = Math.max(
      ...left.occurrences.map(({ timelineRange }) => timelineRange.end.value),
    );
    for (const right of placements.slice(leftIndex + 1)) {
      const rightStart = Math.min(
        ...right.occurrences.map(({ timelineRange }) => timelineRange.start.value),
      );
      const rightEnd = Math.max(
        ...right.occurrences.map(({ timelineRange }) => timelineRange.end.value),
      );
      if (leftStart < rightEnd && leftEnd > rightStart) {
        throw remapError(
          "invalid_project",
          "Caption remap placements overlap",
          "caption_remap_ambiguous_occurrences",
        );
      }
    }
  }
}

export function analyzeCuePlacements(
  cue: CaptionCueV1,
  occurrences: readonly LogicalOccurrence[],
  timelineRate: RationalRate,
): readonly Placement[] {
  const placements = placementsForCue(cue, occurrences, timelineRate);
  validateUnambiguousPlacements(placements);
  return placements;
}
