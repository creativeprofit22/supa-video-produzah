import type { z } from "zod";

import { VideoDomainError } from "./errors.js";
import {
  createRationalRate,
  createRationalTime,
  frameRangeDuration,
  rateOf,
  rationalRateSchema,
  rationalTimeSchema,
  type FrameRange,
  type RationalRate,
  type RationalTime,
} from "./time.js";

/** Canonical speeds are reduced, forward, whole percentages from 50 through 200. */
export const clipSpeedSchema = rationalRateSchema.refine((speed) => {
  if (
    !Number.isSafeInteger(speed.numerator) ||
    !Number.isSafeInteger(speed.denominator) ||
    speed.numerator <= 0 ||
    speed.denominator <= 0
  )
    return false;
  const percent = BigInt(speed.numerator) * 100n;
  const denominator = BigInt(speed.denominator);
  return (
    percent % denominator === 0n && percent >= 50n * denominator && percent <= 200n * denominator
  );
}, "Speed must be a whole percentage from 50% through 200%");
export type ClipSpeed = z.infer<typeof clipSpeedSchema>;
export const NORMAL_CLIP_SPEED: Readonly<ClipSpeed> = Object.freeze({
  numerator: 1,
  denominator: 1,
});

/** UI percentages are integer strings, not floating-point multipliers. No clamping. */
export function parseClipSpeedPercent(text: string): ClipSpeed {
  if (!/^(?:[5-9][0-9]|1[0-9]{2}|200)$/.test(text)) {
    throw new VideoDomainError("invalid_time", "Enter a whole percentage from 50% through 200%");
  }
  return clipSpeedSchema.parse(createRationalRate(Number(text), 100));
}

export function clipSpeedPercent(speed: ClipSpeed = NORMAL_CLIP_SPEED): number {
  const valid = clipSpeedSchema.parse(speed);
  return Number((BigInt(valid.numerator) * 100n) / BigInt(valid.denominator));
}

/** Use only when applying an edit, never to rewrite a loaded project's representation. */
export function normalizeClipSpeed(speed: ClipSpeed): ClipSpeed | undefined {
  const valid = clipSpeedSchema.parse(speed);
  return valid.numerator === valid.denominator ? undefined : valid;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Cancel all factors before multiplying/dividing; canonical boundaries never round. */
function convertFrames(
  value: number,
  from: RationalRate,
  to: RationalRate,
  multiplier: ClipSpeed,
  mode: "exact" | "floor",
): number {
  if (mode !== "exact" && mode !== "floor") {
    throw new VideoDomainError("invalid_time", "Unknown frame sampling policy");
  }
  const numerator = [
    BigInt(value),
    BigInt(from.denominator),
    BigInt(to.numerator),
    BigInt(multiplier.numerator),
  ];
  const denominator = [
    BigInt(from.numerator),
    BigInt(to.denominator),
    BigInt(multiplier.denominator),
  ];
  for (let i = 0; i < numerator.length; i++) {
    for (let j = 0; j < denominator.length; j++) {
      const divisor = gcd(numerator[i]!, denominator[j]!);
      numerator[i] = numerator[i]! / divisor;
      denominator[j] = denominator[j]! / divisor;
    }
  }
  const top = numerator.reduce((product, factor) => product * factor, 1n);
  const bottom = denominator.reduce((product, factor) => product * factor, 1n);
  if (mode === "exact" && top % bottom !== 0n) {
    throw new VideoDomainError("invalid_time", "Speed produces an inexact frame boundary");
  }
  // Match native checked u128 products, including display-only floor conversions.
  const maximumProduct = (1n << 128n) - 1n;
  if (top > maximumProduct || bottom > maximumProduct) {
    throw new VideoDomainError(
      "invalid_time",
      "Retimed arithmetic exceeds the supported integer range",
    );
  }
  const result = top / bottom;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VideoDomainError(
      "invalid_time",
      "Retimed frame value exceeds the safe integer range",
    );
  }
  return Number(result);
}

export function clipTimelineDuration(
  range: FrameRange,
  sequenceRate: RationalRate,
  speed: ClipSpeed = NORMAL_CLIP_SPEED,
): RationalTime {
  const duration = frameRangeDuration(range);
  const target = rationalRateSchema.parse(sequenceRate);
  const validSpeed = clipSpeedSchema.parse(speed);
  const value = convertFrames(
    duration.value,
    rateOf(duration),
    target,
    {
      numerator: validSpeed.denominator,
      denominator: validSpeed.numerator,
    },
    "exact",
  );
  if (value === 0) throw new VideoDomainError("invalid_time", "Retimed duration must be positive");
  return createRationalTime(value, target);
}

/** Relative offsets only. Use exact for edits; floor selects the source sample for display. */
export function timelineOffsetToSource(
  offset: RationalTime,
  sourceRate: RationalRate,
  speed: ClipSpeed = NORMAL_CLIP_SPEED,
  mode: "exact" | "floor" = "exact",
): RationalTime {
  const valid = rationalTimeSchema.parse(offset);
  const target = rationalRateSchema.parse(sourceRate);
  const multiplier = clipSpeedSchema.parse(speed);
  return createRationalTime(
    convertFrames(valid.value, rateOf(valid), target, multiplier, mode),
    target,
  );
}

/** Relative offsets only. Inexact split/trim boundaries are rejected by default. */
export function sourceOffsetToTimeline(
  offset: RationalTime,
  sequenceRate: RationalRate,
  speed: ClipSpeed = NORMAL_CLIP_SPEED,
  mode: "exact" | "floor" = "exact",
): RationalTime {
  const valid = rationalTimeSchema.parse(offset);
  const target = rationalRateSchema.parse(sequenceRate);
  const multiplier = clipSpeedSchema.parse(speed);
  return createRationalTime(
    convertFrames(
      valid.value,
      rateOf(valid),
      target,
      {
        numerator: multiplier.denominator,
        denominator: multiplier.numerator,
      },
      mode,
    ),
    target,
  );
}
