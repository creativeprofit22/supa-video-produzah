import { VideoDomainError } from "./errors.js";
import {
  rationalRateSchema,
  rationalTimeSchema,
  ratesEqual,
  type RationalRate,
  type RationalTime,
} from "./time.js";

interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * A transient timeline point that can participate in snapping. Callers may extend this shape with
 * target-specific metadata; clip-owned points use clipId so a moving clip cannot snap to itself.
 */
export interface TimelineSnapTarget {
  readonly time: RationalTime;
  readonly clipId?: string;
}

const timelineSnapIndexData: unique symbol = Symbol("timelineSnapIndexData");

interface TimelineSnapIndexData<Target extends TimelineSnapTarget> {
  readonly rate: RationalRate | null;
  readonly targets: readonly Target[];
}

/** An opaque, stable index created by createTimelineSnapIndex. */
export interface TimelineSnapIndex<Target extends TimelineSnapTarget = TimelineSnapTarget> {
  readonly [timelineSnapIndexData]: TimelineSnapIndexData<Target>;
}

interface TimelineSnapLookup {
  readonly proposedTime: RationalTime;
  readonly movingClipId?: string;
}

interface TimelineSnapNeighbors<Target extends TimelineSnapTarget = TimelineSnapTarget> {
  readonly predecessor: Target | null;
  readonly successor: Target | null;
}

export interface TimelineSnapInput extends TimelineSnapLookup {
  /** A reduced pixels-per-second ratio. */
  readonly zoomScale: RationalRate;
  /** Maximum distance in logical pixels; fractional values are supported exactly. */
  readonly maximumSnapDistancePixels: number;
}

export interface TimelineSnapResult<Target extends TimelineSnapTarget = TimelineSnapTarget> {
  readonly correctedTime: RationalTime;
  readonly matchedTarget: Target | null;
}

function validateTime(time: RationalTime, label: string): RationalTime {
  const result = rationalTimeSchema.safeParse(time);
  if (!result.success) {
    throw new VideoDomainError("invalid_time", `${label} must be an exact non-negative time`, {
      issues: result.error.issues,
    });
  }
  return Object.freeze({ ...result.data });
}

function validateRate(rate: RationalRate, label: string): RationalRate {
  const result = rationalRateSchema.safeParse(rate);
  if (!result.success) {
    throw new VideoDomainError("invalid_rate", `${label} must be a reduced positive rate`, {
      issues: result.error.issues,
    });
  }
  return Object.freeze({ ...result.data });
}

function rateOfTime(time: RationalTime): RationalRate {
  return { numerator: time.rateNumerator, denominator: time.rateDenominator };
}

function validateClipId(clipId: string | undefined, label: string): void {
  if (clipId !== undefined && (typeof clipId !== "string" || clipId.trim().length === 0)) {
    throw new VideoDomainError("invalid_range", `${label} must be a non-blank string`);
  }
}

function getTimelineSnapIndexData<Target extends TimelineSnapTarget>(
  index: TimelineSnapIndex<Target>,
): TimelineSnapIndexData<Target> {
  const data =
    index !== null && typeof index === "object"
      ? (index as TimelineSnapIndex<Target>)[timelineSnapIndexData]
      : undefined;
  if (data === undefined) {
    throw new VideoDomainError(
      "invalid_range",
      "Timeline snap index must be created by createTimelineSnapIndex",
    );
  }
  return data;
}

function nonNegativeNumberToFraction(value: number, label: string): Fraction {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new VideoDomainError("invalid_range", `${label} must be a finite non-negative value`, {
      value,
    });
  }

  const normalized = Object.is(value, -0) ? 0 : value;
  const [coefficient = "0", exponentText] = normalized.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
  const [whole = "0", fractional = ""] = coefficient.split(".");
  const digits = BigInt(`${whole}${fractional}`);
  const decimalPlaces = fractional.length - exponent;
  if (decimalPlaces <= 0) {
    return { numerator: digits * 10n ** BigInt(-decimalPlaces), denominator: 1n };
  }
  return { numerator: digits, denominator: 10n ** BigInt(decimalPlaces) };
}

function lowerBound<Target extends TimelineSnapTarget>(
  targets: readonly Target[],
  value: number,
): number {
  let start = 0;
  let end = targets.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (targets[middle]!.time.value < value) start = middle + 1;
    else end = middle;
  }
  return start;
}

function nearestTarget<Target extends TimelineSnapTarget>(
  proposedTime: RationalTime,
  neighbors: TimelineSnapNeighbors<Target>,
): Target | null {
  const { predecessor, successor } = neighbors;
  if (predecessor === null) return successor;
  if (successor === null) return predecessor;
  const predecessorDistance = proposedTime.value - predecessor.time.value;
  const successorDistance = successor.time.value - proposedTime.value;
  return predecessorDistance <= successorDistance ? predecessor : successor;
}

function isWithinPixelDistance(
  frameDistance: number,
  rate: RationalRate,
  zoomScale: RationalRate,
  maximumDistance: Fraction,
): boolean {
  const pixelDistanceNumerator =
    BigInt(frameDistance) * BigInt(rate.denominator) * BigInt(zoomScale.numerator);
  const pixelDistanceDenominator = BigInt(rate.numerator) * BigInt(zoomScale.denominator);
  return (
    pixelDistanceNumerator * maximumDistance.denominator <=
    maximumDistance.numerator * pixelDistanceDenominator
  );
}

/** Builds a stable index by exact time while preserving caller target identity. */
export function createTimelineSnapIndex<Target extends TimelineSnapTarget>(
  targets: readonly Target[],
): TimelineSnapIndex<Target> {
  if (!Array.isArray(targets)) {
    throw new VideoDomainError("invalid_range", "Timeline snap targets must be an array");
  }

  let rate: RationalRate | null = null;
  const validatedTargets = targets.map((target, sourceIndex) => {
    if (target === null || typeof target !== "object") {
      throw new VideoDomainError("invalid_range", "Timeline snap target must be an object", {
        sourceIndex,
      });
    }
    const time = validateTime(target.time, "Timeline snap target time");
    const targetRate = rateOfTime(time);
    if (rate === null) rate = Object.freeze(targetRate);
    else if (!ratesEqual(rate, targetRate)) {
      throw new VideoDomainError("mixed_rate", "Timeline snap targets must use one common rate", {
        sourceIndex,
      });
    }
    validateClipId(target.clipId, "Timeline snap target clipId");
    return { sourceIndex, target };
  });

  validatedTargets.sort(
    (left, right) =>
      left.target.time.value - right.target.time.value || left.sourceIndex - right.sourceIndex,
  );
  const data = Object.freeze({
    rate,
    targets: Object.freeze(validatedTargets.map(({ target }) => target)),
  });
  return Object.freeze({ [timelineSnapIndexData]: data });
}

/**
 * Finds the closest eligible points on either side of proposedTime in
 * O(log n + inspected coincident/excluded targets). The predecessor is strictly earlier; an exact
 * match is returned as the successor.
 */
function findTimelineSnapNeighbors<Target extends TimelineSnapTarget>(
  index: TimelineSnapIndex<Target>,
  lookup: TimelineSnapLookup,
): Readonly<TimelineSnapNeighbors<Target>> {
  const { rate, targets } = getTimelineSnapIndexData(index);
  const proposedTime = validateTime(lookup.proposedTime, "Proposed timeline snap time");
  validateClipId(lookup.movingClipId, "Moving clip id");
  if (rate !== null && !ratesEqual(rate, rateOfTime(proposedTime))) {
    throw new VideoDomainError(
      "mixed_rate",
      "Proposed timeline snap time must use the snap index rate",
    );
  }

  const isExcluded = (target: Target): boolean =>
    lookup.movingClipId !== undefined && target.clipId === lookup.movingClipId;
  const insertionIndex = lowerBound(targets, proposedTime.value);

  let predecessor: Target | null = null;
  let predecessorGroupEnd = insertionIndex - 1;
  while (predecessorGroupEnd >= 0 && predecessor === null) {
    const groupTime = targets[predecessorGroupEnd]!.time.value;
    let groupStart = predecessorGroupEnd;
    while (groupStart > 0 && targets[groupStart - 1]!.time.value === groupTime) {
      groupStart -= 1;
    }
    for (let targetIndex = groupStart; targetIndex <= predecessorGroupEnd; targetIndex += 1) {
      const target = targets[targetIndex]!;
      if (!isExcluded(target)) {
        predecessor = target;
        break;
      }
    }
    predecessorGroupEnd = groupStart - 1;
  }

  let successor: Target | null = null;
  let successorGroupStart = insertionIndex;
  while (successorGroupStart < targets.length && successor === null) {
    const groupTime = targets[successorGroupStart]!.time.value;
    let groupEnd = successorGroupStart + 1;
    while (groupEnd < targets.length && targets[groupEnd]!.time.value === groupTime) {
      groupEnd += 1;
    }
    for (let targetIndex = successorGroupStart; targetIndex < groupEnd; targetIndex += 1) {
      const target = targets[targetIndex]!;
      if (!isExcluded(target)) {
        successor = target;
        break;
      }
    }
    successorGroupStart = groupEnd;
  }

  return Object.freeze({ predecessor, successor });
}

/** Returns the original time when no eligible target is within the zoom-aware pixel threshold. */
export function snapTimelineTime<Target extends TimelineSnapTarget>(
  index: TimelineSnapIndex<Target>,
  input: TimelineSnapInput,
): Readonly<TimelineSnapResult<Target>> {
  const proposedTime = validateTime(input.proposedTime, "Proposed timeline snap time");
  const zoomScale = validateRate(input.zoomScale, "Timeline snap zoom scale");
  const maximumDistance = nonNegativeNumberToFraction(
    input.maximumSnapDistancePixels,
    "Maximum timeline snap distance",
  );
  const neighbors = findTimelineSnapNeighbors(index, {
    proposedTime,
    ...(input.movingClipId === undefined ? {} : { movingClipId: input.movingClipId }),
  });
  const candidate = nearestTarget(proposedTime, neighbors);
  if (candidate === null) {
    return Object.freeze({ correctedTime: proposedTime, matchedTarget: null });
  }

  const frameDistance = Math.abs(candidate.time.value - proposedTime.value);
  const rate = rateOfTime(proposedTime);
  if (!isWithinPixelDistance(frameDistance, rate, zoomScale, maximumDistance)) {
    return Object.freeze({ correctedTime: proposedTime, matchedTarget: null });
  }

  return Object.freeze({ correctedTime: candidate.time, matchedTarget: candidate });
}
