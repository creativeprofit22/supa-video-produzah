import { z } from "zod";

import { VideoDomainError } from "./errors.js";

const safePositiveIntegerSchema = z.number().int().safe().positive();
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export const rationalRateSchema = z
  .object({
    numerator: safePositiveIntegerSchema,
    denominator: safePositiveIntegerSchema,
  })
  .strict()
  .refine((rate) => greatestCommonDivisor(rate.numerator, rate.denominator) === 1, {
    message: "Rational rate must be reduced",
  });

export type RationalRate = z.infer<typeof rationalRateSchema>;

export const rationalTimeSchema = z
  .object({
    value: safeNonNegativeIntegerSchema,
    rateNumerator: safePositiveIntegerSchema,
    rateDenominator: safePositiveIntegerSchema,
  })
  .strict()
  .refine((time) => greatestCommonDivisor(time.rateNumerator, time.rateDenominator) === 1, {
    message: "Rational time rate must be reduced",
  });

export type RationalTime = z.infer<typeof rationalTimeSchema>;
export type RoundingMode = "floor" | "ceil" | "nearestTiesAwayFromZero";

export interface FrameRange {
  readonly in: RationalTime;
  readonly out: RationalTime;
}

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VideoDomainError("invalid_time", `${label} exceeds the safe integer range`, {
      value: value.toString(),
    });
  }
  return Number(value);
}

function divideWithRounding(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new VideoDomainError("invalid_time", "Rational division requires non-negative values");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "floor") {
    return quotient;
  }
  if (mode === "ceil") {
    return quotient + 1n;
  }
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function createRationalRate(numerator: number, denominator: number): RationalRate {
  const candidate = z
    .object({ numerator: safePositiveIntegerSchema, denominator: safePositiveIntegerSchema })
    .strict()
    .parse({ numerator, denominator });
  const divisor = greatestCommonDivisor(candidate.numerator, candidate.denominator);
  return Object.freeze({
    numerator: candidate.numerator / divisor,
    denominator: candidate.denominator / divisor,
  });
}

export function createRationalTime(value: number, rate: RationalRate): RationalTime {
  const validatedRate = rationalRateSchema.parse(rate);
  return Object.freeze(
    rationalTimeSchema.parse({
      value,
      rateNumerator: validatedRate.numerator,
      rateDenominator: validatedRate.denominator,
    }),
  );
}

export function rateOf(time: RationalTime): RationalRate {
  const valid = rationalTimeSchema.parse(time);
  return { numerator: valid.rateNumerator, denominator: valid.rateDenominator };
}

export function ratesEqual(left: RationalRate, right: RationalRate): boolean {
  const validLeft = rationalRateSchema.parse(left);
  const validRight = rationalRateSchema.parse(right);
  return (
    validLeft.numerator === validRight.numerator && validLeft.denominator === validRight.denominator
  );
}

export function assertSameRate(left: RationalTime, right: RationalTime): void {
  const leftRate = rateOf(left);
  const rightRate = rateOf(right);
  if (!ratesEqual(leftRate, rightRate)) {
    throw new VideoDomainError("mixed_rate", "Explicit conversion is required for mixed rates", {
      leftRate,
      rightRate,
    });
  }
}

export function compareRationalTimes(left: RationalTime, right: RationalTime): -1 | 0 | 1 {
  rationalTimeSchema.parse(left);
  rationalTimeSchema.parse(right);
  assertSameRate(left, right);
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

export function rescaleRationalTime(
  time: RationalTime,
  targetRate: RationalRate,
  mode: RoundingMode,
): RationalTime {
  const validTime = rationalTimeSchema.parse(time);
  const validTarget = rationalRateSchema.parse(targetRate);
  const numerator =
    BigInt(validTime.value) * BigInt(validTime.rateDenominator) * BigInt(validTarget.numerator);
  const denominator = BigInt(validTime.rateNumerator) * BigInt(validTarget.denominator);
  return createRationalTime(
    toSafeNumber(divideWithRounding(numerator, denominator, mode), "Converted frame value"),
    validTarget,
  );
}

export function microsecondsToSourceFrames(
  durationMicroseconds: number,
  rate: RationalRate,
): RationalTime {
  const duration = safeNonNegativeIntegerSchema.parse(durationMicroseconds);
  const validRate = rationalRateSchema.parse(rate);
  const frames = divideWithRounding(
    BigInt(duration) * BigInt(validRate.numerator),
    1_000_000n * BigInt(validRate.denominator),
    "ceil",
  );
  return createRationalTime(toSafeNumber(frames, "Source frame duration"), validRate);
}

export function rationalTimeToMicroseconds(time: RationalTime, mode: RoundingMode): number {
  const valid = rationalTimeSchema.parse(time);
  const microseconds = divideWithRounding(
    BigInt(valid.value) * BigInt(valid.rateDenominator) * 1_000_000n,
    BigInt(valid.rateNumerator),
    mode,
  );
  return toSafeNumber(microseconds, "Microsecond value");
}

export function validateFrameRange(range: FrameRange): Readonly<FrameRange> {
  rationalTimeSchema.parse(range.in);
  rationalTimeSchema.parse(range.out);
  assertSameRate(range.in, range.out);
  if (range.out.value <= range.in.value) {
    throw new VideoDomainError(
      "invalid_range",
      "Frame ranges are half-open and must contain at least one frame",
      { in: range.in.value, out: range.out.value },
    );
  }
  return Object.freeze({ in: range.in, out: range.out });
}

export function frameRangeDuration(range: FrameRange): RationalTime {
  const valid = validateFrameRange(range);
  return createRationalTime(valid.out.value - valid.in.value, rateOf(valid.in));
}
