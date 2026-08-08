import type { RationalRate } from "@supa-video/contracts";
import { unicodeScalarLength, type CaptionValidationProfileV1 } from "@supa-video/media";

import {
  isSentenceFinal,
  unitText,
  wrapUnits,
  type DisplayUnit,
} from "./transcript-caption-display.js";
import {
  captionError,
  spansOverlap,
  type FrameConstraints,
  type LogicalOccurrence,
  type ValidatedCaptionInput,
} from "./transcript-caption-internal.js";

const MAX_CAPTION_CUES = 100_000;

export interface CueGroup {
  readonly units: readonly DisplayUnit[];
  readonly occurrences: readonly LogicalOccurrence[];
}

interface CueFeasibilityMetrics {
  readonly start: number;
  readonly rawEnd: number;
  readonly scalarCount: number;
  readonly lineCount: number;
  readonly finalLineScalarCount: number;
}

interface SourceFeasibilityState {
  readonly wordIds: Set<string>;
  readonly spans: { sourceStartUs: number; sourceEndUs: number }[];
}

interface CueFeasibilityFrame {
  readonly startIndex: number;
  nextIndex: number;
  metrics: CueFeasibilityMetrics;
  readonly sourceState: SourceFeasibilityState;
  minimumCueCount: number;
  waitingFor?: {
    readonly kind: "mandatory" | "optional";
    readonly nextIndex: number;
    readonly candidateMetrics: CueFeasibilityMetrics;
  };
}

function groupOccurrences(units: readonly DisplayUnit[]): readonly LogicalOccurrence[] {
  return units.flatMap(({ occurrences }) => occurrences);
}

function cueGroup(units: readonly DisplayUnit[]): CueGroup {
  return { units, occurrences: groupOccurrences(units) };
}

function rawGroupEnd(group: CueGroup): number {
  return Math.max(...group.occurrences.map(({ timelineRange }) => timelineRange.end.value));
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function safeFrameCount(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function minimumCpsFrames(
  scalarCount: number,
  rate: RationalRate,
  maximumCharactersPerSecond: number,
): number | null {
  return safeFrameCount(
    ceilDivide(
      BigInt(scalarCount) * BigInt(rate.numerator),
      BigInt(maximumCharactersPerSecond) * BigInt(rate.denominator),
    ),
  );
}

function cueEndForMetrics(
  metrics: Pick<CueFeasibilityMetrics, "start" | "rawEnd" | "scalarCount">,
  input: ValidatedCaptionInput,
  constraints: FrameConstraints,
  nextCueStart?: number,
): number | null {
  const cpsFrames = minimumCpsFrames(
    metrics.scalarCount,
    input.timeline.timelineRate,
    input.validationProfile.maxCharactersPerSecond,
  );
  if (cpsFrames === null) return null;
  const end = Math.max(
    metrics.rawEnd,
    metrics.start + constraints.minimumDurationFrames,
    metrics.start + cpsFrames,
  );
  const latestEnd = Math.min(
    metrics.start + constraints.maximumDurationFrames,
    nextCueStart ?? Number.MAX_SAFE_INTEGER,
  );
  return Number.isSafeInteger(end) && end <= latestEnd ? end : null;
}

export function finalCueEnd(
  group: CueGroup,
  input: ValidatedCaptionInput,
  constraints: FrameConstraints,
  nextCueStart?: number,
): number | null {
  const lines = wrapUnits(group.units, input.validationProfile);
  if (lines === null) return null;
  return cueEndForMetrics(
    {
      start: group.occurrences[0]!.timelineRange.start.value,
      rawEnd: rawGroupEnd(group),
      scalarCount: lines.reduce((total, line) => total + unicodeScalarLength(line), 0),
    },
    input,
    constraints,
    nextCueStart,
  );
}

function unitRawEnd(unit: DisplayUnit): number {
  let rawEnd = 0;
  for (const { timelineRange } of unit.occurrences) {
    rawEnd = Math.max(rawEnd, timelineRange.end.value);
  }
  return rawEnd;
}

function initialCueFeasibilityMetrics(
  unit: DisplayUnit,
  unitScalarCount: number,
): CueFeasibilityMetrics {
  return {
    start: unit.occurrences[0]!.timelineRange.start.value,
    rawEnd: unitRawEnd(unit),
    scalarCount: unitScalarCount,
    lineCount: 1,
    finalLineScalarCount: unitScalarCount,
  };
}

function appendCueFeasibilityMetrics(
  metrics: CueFeasibilityMetrics,
  unit: DisplayUnit,
  unitScalarCount: number,
  profile: CaptionValidationProfileV1,
): CueFeasibilityMetrics {
  const fitsFinalLine =
    metrics.finalLineScalarCount + 1 + unitScalarCount <= profile.maxCharactersPerLine;
  return {
    ...metrics,
    rawEnd: Math.max(metrics.rawEnd, unitRawEnd(unit)),
    scalarCount: metrics.scalarCount + unitScalarCount + (fitsFinalLine ? 1 : 0),
    lineCount: metrics.lineCount + (fitsFinalLine ? 0 : 1),
    finalLineScalarCount: fitsFinalLine
      ? metrics.finalLineScalarCount + 1 + unitScalarCount
      : unitScalarCount,
  };
}

function cueMetricsExceedCapacity(
  metrics: CueFeasibilityMetrics,
  profile: CaptionValidationProfileV1,
  constraints: FrameConstraints,
): boolean {
  return (
    metrics.finalLineScalarCount > profile.maxCharactersPerLine ||
    metrics.lineCount > profile.maxLinesPerCue ||
    metrics.rawEnd - metrics.start > constraints.maximumDurationFrames
  );
}

function appendToSourceFeasibilityState(
  state: SourceFeasibilityState,
  occurrences: readonly LogicalOccurrence[],
): boolean {
  if (occurrences.some(({ wordId }) => state.wordIds.has(wordId))) return false;

  for (const occurrence of occurrences) {
    let merged = {
      sourceStartUs: occurrence.sourceStartUs,
      sourceEndUs: occurrence.sourceEndUs,
    };
    while (state.spans.length > 0 && spansOverlap(state.spans.at(-1)!, merged)) {
      const previous = state.spans.pop()!;
      merged = {
        sourceStartUs: Math.min(previous.sourceStartUs, merged.sourceStartUs),
        sourceEndUs: Math.max(previous.sourceEndUs, merged.sourceEndUs),
      };
    }
    const previous = state.spans.at(-1);
    if (previous !== undefined && merged.sourceStartUs < previous.sourceEndUs) return false;
    state.spans.push(merged);
  }
  for (const { wordId } of occurrences) state.wordIds.add(wordId);
  return true;
}

function initialSourceFeasibilityState(unit: DisplayUnit): SourceFeasibilityState {
  const state: SourceFeasibilityState = { wordIds: new Set(), spans: [] };
  appendToSourceFeasibilityState(state, unit.occurrences);
  return state;
}

function minimumCueCounts(
  units: readonly DisplayUnit[],
  input: ValidatedCaptionInput,
  constraints: FrameConstraints,
): readonly number[] {
  if (units.length === 0) return [];
  const unitScalarCounts = units.map((unit) => unicodeScalarLength(unitText(unit)));
  const minimumCounts: (number | undefined)[] = Array(units.length);
  const frames: CueFeasibilityFrame[] = [];

  const pushFrame = (startIndex: number): void => {
    const firstUnit = units[startIndex]!;
    frames.push({
      startIndex,
      nextIndex: startIndex + 1,
      metrics: initialCueFeasibilityMetrics(firstUnit, unitScalarCounts[startIndex]!),
      sourceState: initialSourceFeasibilityState(firstUnit),
      minimumCueCount: Number.POSITIVE_INFINITY,
    });
  };
  const completeFrame = (minimumCueCount: number): void => {
    const frame = frames.pop()!;
    minimumCounts[frame.startIndex] = minimumCueCount;
  };

  pushFrame(0);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const waitingFor = frame.waitingFor;
    if (waitingFor !== undefined) {
      const suffixMinimum = minimumCounts[waitingFor.nextIndex]!;
      delete frame.waitingFor;
      if (waitingFor.kind === "mandatory") {
        completeFrame(Math.min(frame.minimumCueCount, 1 + suffixMinimum));
      } else {
        frame.minimumCueCount = Math.min(frame.minimumCueCount, 1 + suffixMinimum);
        frame.metrics = waitingFor.candidateMetrics;
        frame.nextIndex = waitingFor.nextIndex + 1;
      }
      continue;
    }

    const nextUnit = units[frame.nextIndex];
    if (nextUnit === undefined) {
      const finalCount =
        cueEndForMetrics(frame.metrics, input, constraints) === null ? Number.POSITIVE_INFINITY : 1;
      completeFrame(Math.min(frame.minimumCueCount, finalCount));
      continue;
    }

    const nextStart = nextUnit.occurrences[0]!.timelineRange.start.value;
    const currentCanFinalize =
      cueEndForMetrics(frame.metrics, input, constraints, nextStart) !== null;
    const candidateMetrics = appendCueFeasibilityMetrics(
      frame.metrics,
      nextUnit,
      unitScalarCounts[frame.nextIndex]!,
      input.validationProfile,
    );
    const lineageBreak = !appendToSourceFeasibilityState(frame.sourceState, nextUnit.occurrences);
    const capacityBreak = cueMetricsExceedCapacity(
      candidateMetrics,
      input.validationProfile,
      constraints,
    );
    const mandatoryBreak = lineageBreak || capacityBreak;
    const previousUnit = units[frame.nextIndex - 1]!;
    const previousEnd = previousUnit.occurrences.at(-1)!.timelineRange.end.value;
    const preferredBreak =
      isSentenceFinal(previousUnit) || nextStart - previousEnd >= constraints.oneSecondFrames;

    if (mandatoryBreak && !currentCanFinalize) {
      completeFrame(frame.minimumCueCount);
      continue;
    }
    if (!mandatoryBreak && (!preferredBreak || !currentCanFinalize)) {
      frame.metrics = candidateMetrics;
      frame.nextIndex += 1;
      continue;
    }

    const suffixMinimum = minimumCounts[frame.nextIndex];
    if (suffixMinimum === undefined) {
      frame.waitingFor = {
        kind: mandatoryBreak ? "mandatory" : "optional",
        nextIndex: frame.nextIndex,
        candidateMetrics,
      };
      pushFrame(frame.nextIndex);
      continue;
    }
    if (mandatoryBreak) {
      completeFrame(Math.min(frame.minimumCueCount, 1 + suffixMinimum));
    } else {
      frame.minimumCueCount = Math.min(frame.minimumCueCount, 1 + suffixMinimum);
      frame.metrics = candidateMetrics;
      frame.nextIndex += 1;
    }
  }

  return minimumCounts.map((count) => count ?? Number.POSITIVE_INFINITY);
}

export function groupDisplayUnits(
  units: readonly DisplayUnit[],
  input: ValidatedCaptionInput,
  constraints: FrameConstraints,
): readonly CueGroup[] {
  for (const unit of units) wrapUnits([unit], input.validationProfile);
  if (units.length === 0) return [];

  const minimumCounts = minimumCueCounts(units, input, constraints);
  if (minimumCounts[0]! > MAX_CAPTION_CUES) {
    throw captionError(
      "invalid_range",
      "Caption constraints cannot be satisfied",
      "caption_constraints_unsatisfied",
    );
  }

  const unitScalarCounts = units.map((unit) => unicodeScalarLength(unitText(unit)));
  const groups: CueGroup[] = [];
  let startIndex = 0;
  let remainingCueCount = MAX_CAPTION_CUES;

  while (startIndex < units.length) {
    let nextIndex = startIndex + 1;
    let metrics = initialCueFeasibilityMetrics(units[startIndex]!, unitScalarCounts[startIndex]!);
    const sourceState = initialSourceFeasibilityState(units[startIndex]!);

    while (true) {
      const nextUnit = units[nextIndex];
      if (nextUnit === undefined) {
        groups.push(cueGroup(units.slice(startIndex)));
        return groups;
      }

      const nextStart = nextUnit.occurrences[0]!.timelineRange.start.value;
      const currentCanFinalize = cueEndForMetrics(metrics, input, constraints, nextStart) !== null;
      const candidateMetrics = appendCueFeasibilityMetrics(
        metrics,
        nextUnit,
        unitScalarCounts[nextIndex]!,
        input.validationProfile,
      );
      const lineageBreak = !appendToSourceFeasibilityState(sourceState, nextUnit.occurrences);
      const capacityBreak = cueMetricsExceedCapacity(
        candidateMetrics,
        input.validationProfile,
        constraints,
      );
      const mandatoryBreak = lineageBreak || capacityBreak;
      const previousUnit = units[nextIndex - 1]!;
      const previousEnd = previousUnit.occurrences.at(-1)!.timelineRange.end.value;
      const preferredBreak =
        isSentenceFinal(previousUnit) || nextStart - previousEnd >= constraints.oneSecondFrames;
      const preferredBreakIsFeasible =
        currentCanFinalize && minimumCounts[nextIndex]! <= remainingCueCount - 1;

      if (mandatoryBreak || (preferredBreak && preferredBreakIsFeasible)) {
        groups.push(cueGroup(units.slice(startIndex, nextIndex)));
        startIndex = nextIndex;
        remainingCueCount -= 1;
        break;
      }

      metrics = candidateMetrics;
      nextIndex += 1;
    }
  }

  return groups;
}
