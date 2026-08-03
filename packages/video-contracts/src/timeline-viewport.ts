import { VideoDomainError } from "./errors.js";
import {
  createRationalTime,
  rationalRateSchema,
  rationalTimeSchema,
  type RationalRate,
  type RationalTime,
  type RoundingMode,
} from "./time.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const ROUNDING_MODES: readonly RoundingMode[] = ["floor", "ceil", "nearestTiesAwayFromZero"];

interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

declare const timelineViewportBrand: unique symbol;

export interface TimelineFrameRange {
  readonly start: number;
  readonly endExclusive: number;
}

/** All pixel fields use one consistent logical coordinate space (CSS pixels in browser callers). */
export interface TimelineViewportInput {
  readonly frameRate: RationalRate;
  /** A reduced, positive pixels-per-second ratio in the same logical pixel space. */
  readonly zoomScale: RationalRate;
  readonly scrollOrigin: RationalTime;
  readonly viewportWidthPixels: number;
  readonly overscanPixels: number;
  readonly timelineRange: TimelineFrameRange;
}

/** An immutable, factory-created transient viewport model. */
export interface TimelineViewport extends TimelineViewportInput {
  readonly effectiveOverscanPixels: number;
  readonly visibleRange: Readonly<TimelineFrameRange>;
  readonly overscanRange: Readonly<TimelineFrameRange>;
  readonly [timelineViewportBrand]: true;
}

const timelineViewportInstances = new WeakSet<TimelineViewport>();

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function normalizeFraction(numerator: bigint, denominator: bigint): Fraction {
  if (denominator <= 0n) {
    throw new VideoDomainError("invalid_time", "Rational geometry requires a positive denominator");
  }
  if (numerator === 0n) {
    return { numerator: 0n, denominator: 1n };
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function validatePixelNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new VideoDomainError("invalid_range", `${label} must be a finite safe pixel value`, {
      value,
    });
  }
  return Object.is(value, -0) ? 0 : value;
}

function numberToFraction(value: number, label: string): Fraction {
  const valid = validatePixelNumber(value, label);
  const [coefficient = "0", exponentText] = valid.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
  const negative = coefficient.startsWith("-");
  const unsignedCoefficient = negative ? coefficient.slice(1) : coefficient;
  const [whole = "0", fractional = ""] = unsignedCoefficient.split(".");
  const digits = BigInt(`${whole}${fractional}`);
  const signedDigits = negative ? -digits : digits;
  const decimalPlaces = fractional.length - exponent;

  if (decimalPlaces <= 0) {
    return normalizeFraction(signedDigits * 10n ** BigInt(-decimalPlaces), 1n);
  }
  return normalizeFraction(signedDigits, 10n ** BigInt(decimalPlaces));
}

function fractionToPixel(fraction: Fraction, label: string): number {
  const value = Number(fraction.numerator) / Number(fraction.denominator);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new VideoDomainError("invalid_range", `${label} exceeds the finite safe pixel range`, {
      numerator: fraction.numerator.toString(),
      denominator: fraction.denominator.toString(),
    });
  }
  return Object.is(value, -0) ? 0 : value;
}

function validateRoundingMode(mode: RoundingMode): RoundingMode {
  if (!ROUNDING_MODES.includes(mode)) {
    throw new VideoDomainError("invalid_time", "Unknown timeline rounding mode", { mode });
  }
  return mode;
}

function divideSigned(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  validateRoundingMode(mode);
  if (denominator <= 0n) {
    throw new VideoDomainError("invalid_time", "Rational division requires a positive denominator");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  if (mode === "floor") {
    return numerator < 0n ? quotient - 1n : quotient;
  }
  if (mode === "ceil") {
    return numerator > 0n ? quotient + 1n : quotient;
  }

  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  if (absoluteRemainder * 2n < denominator) {
    return quotient;
  }
  return quotient + (numerator < 0n ? -1n : 1n);
}

function toSafeFrame(value: bigint, label: string): number {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new VideoDomainError("invalid_time", `${label} exceeds the safe frame range`, {
      value: value.toString(),
    });
  }
  return Number(value);
}

function validateFrame(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new VideoDomainError("invalid_time", `${label} must be a safe integer frame`, { value });
  }
  return value;
}

function validateRangeFrame(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new VideoDomainError("invalid_range", `${label} must be a safe integer frame`, { value });
  }
  return value;
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

function validateTime(time: RationalTime, label: string): RationalTime {
  const result = rationalTimeSchema.safeParse(time);
  if (!result.success) {
    throw new VideoDomainError("invalid_time", `${label} must be an exact non-negative time`, {
      issues: result.error.issues,
    });
  }
  return Object.freeze({ ...result.data });
}

function assertTimelineViewport(viewport: TimelineViewport): void {
  if (
    viewport === null ||
    typeof viewport !== "object" ||
    !timelineViewportInstances.has(viewport)
  ) {
    throw new VideoDomainError(
      "invalid_range",
      "Timeline viewport must be created by createTimelineViewport",
    );
  }
}

function timeFraction(time: RationalTime): Fraction {
  return normalizeFraction(
    BigInt(time.value) * BigInt(time.rateDenominator),
    BigInt(time.rateNumerator),
  );
}

function frameFraction(frame: number, frameRate: RationalRate): Fraction {
  return normalizeFraction(
    BigInt(frame) * BigInt(frameRate.denominator),
    BigInt(frameRate.numerator),
  );
}

function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return normalizeFraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function addFractions(left: Fraction, right: Fraction): Fraction {
  return normalizeFraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function secondsToPixels(seconds: Fraction, zoomScale: RationalRate): Fraction {
  return normalizeFraction(
    seconds.numerator * BigInt(zoomScale.numerator),
    seconds.denominator * BigInt(zoomScale.denominator),
  );
}

function pixelsToSeconds(pixels: Fraction, zoomScale: RationalRate): Fraction {
  return normalizeFraction(
    pixels.numerator * BigInt(zoomScale.denominator),
    pixels.denominator * BigInt(zoomScale.numerator),
  );
}

function absoluteFrameAtPixelFraction(pixel: Fraction, viewport: TimelineViewport): Fraction {
  const absoluteSeconds = addFractions(
    timeFraction(viewport.scrollOrigin),
    pixelsToSeconds(pixel, viewport.zoomScale),
  );
  return normalizeFraction(
    absoluteSeconds.numerator * BigInt(viewport.frameRate.numerator),
    absoluteSeconds.denominator * BigInt(viewport.frameRate.denominator),
  );
}

function absoluteFrameAtPixel(pixel: number, viewport: TimelineViewport): Fraction {
  return absoluteFrameAtPixelFraction(numberToFraction(pixel, "Pixel position"), viewport);
}

function roundedFrameAtPixelFraction(
  pixel: Fraction,
  viewport: TimelineViewport,
  mode: RoundingMode,
): bigint {
  const frame = absoluteFrameAtPixelFraction(pixel, viewport);
  return divideSigned(frame.numerator, frame.denominator, mode);
}

function clampBigInt(value: bigint, minimum: bigint, maximum: bigint): bigint {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function deriveClampedRange(
  startPixel: Fraction,
  endPixel: Fraction,
  viewport: TimelineViewport,
  bounds: TimelineFrameRange,
): Readonly<TimelineFrameRange> {
  const minimum = BigInt(bounds.start);
  const maximum = BigInt(bounds.endExclusive);
  const start = clampBigInt(
    roundedFrameAtPixelFraction(startPixel, viewport, "floor"),
    minimum,
    maximum,
  );
  const endExclusive = clampBigInt(
    roundedFrameAtPixelFraction(endPixel, viewport, "ceil"),
    minimum,
    maximum,
  );
  return Object.freeze({ start: Number(start), endExclusive: Number(endExclusive) });
}

export function validateTimelineFrameRange(
  range: TimelineFrameRange,
): Readonly<TimelineFrameRange> {
  if (range === null || typeof range !== "object") {
    throw new VideoDomainError("invalid_range", "Timeline frame range must be an object");
  }
  const start = validateRangeFrame(range.start, "Timeline range start");
  const endExclusive = validateRangeFrame(range.endExclusive, "Timeline range end");
  if (endExclusive < start) {
    throw new VideoDomainError("invalid_range", "Timeline frame ranges must be normalized", {
      start,
      endExclusive,
    });
  }
  return Object.freeze({ start, endExclusive });
}

export function timelineFrameRangesIntersect(
  left: TimelineFrameRange,
  right: TimelineFrameRange,
): boolean {
  const validLeft = validateTimelineFrameRange(left);
  const validRight = validateTimelineFrameRange(right);
  return (
    validLeft.start < validLeft.endExclusive &&
    validRight.start < validRight.endExclusive &&
    validLeft.start < validRight.endExclusive &&
    validRight.start < validLeft.endExclusive
  );
}

export function intersectTimelineFrameRanges(
  left: TimelineFrameRange,
  right: TimelineFrameRange,
): Readonly<TimelineFrameRange> | null {
  const validLeft = validateTimelineFrameRange(left);
  const validRight = validateTimelineFrameRange(right);
  if (!timelineFrameRangesIntersect(validLeft, validRight)) {
    return null;
  }
  return Object.freeze({
    start: Math.max(validLeft.start, validRight.start),
    endExclusive: Math.min(validLeft.endExclusive, validRight.endExclusive),
  });
}

/**
 * Converts exact rational time to the nearest representable logical pixel number without frame
 * rounding. Reverse conversion applies the requested rounding mode to that represented pixel.
 */
export function timeToPixel(time: RationalTime, viewport: TimelineViewport): number {
  assertTimelineViewport(viewport);
  const validTime = validateTime(time, "Timeline time");
  const delta = subtractFractions(timeFraction(validTime), timeFraction(viewport.scrollOrigin));
  return fractionToPixel(secondsToPixels(delta, viewport.zoomScale), "Timeline pixel position");
}

/**
 * Projects an exact frame boundary to the nearest representable logical pixel number and guarantees
 * a nearest-ties-away reverse conversion to the source frame. Floor or ceil operate on the
 * represented pixel and can select an adjacent frame when the exact pixel is not representable.
 */
export function frameToPixel(frame: number, viewport: TimelineViewport): number {
  assertTimelineViewport(viewport);
  const validFrame = validateFrame(frame, "Timeline frame");
  const delta = subtractFractions(
    frameFraction(validFrame, viewport.frameRate),
    timeFraction(viewport.scrollOrigin),
  );
  const pixel = fractionToPixel(
    secondsToPixels(delta, viewport.zoomScale),
    "Timeline pixel position",
  );
  const projectedFrame = absoluteFrameAtPixel(pixel, viewport);
  if (
    divideSigned(
      projectedFrame.numerator,
      projectedFrame.denominator,
      "nearestTiesAwayFromZero",
    ) !== BigInt(validFrame)
  ) {
    throw new VideoDomainError(
      "invalid_range",
      "Frame boundary cannot be represented safely in the logical pixel coordinate space",
      { frame: validFrame },
    );
  }
  return pixel;
}

/**
 * Converts a viewport-relative logical pixel to a signed frame index. Exact boundaries stay on
 * that frame. Fractions use mathematical floor/ceil, or nearest with exact half ties away from
 * zero.
 */
export function pixelToFrame(
  pixel: number,
  viewport: TimelineViewport,
  mode: RoundingMode,
): number {
  assertTimelineViewport(viewport);
  const frame = absoluteFrameAtPixel(pixel, viewport);
  return toSafeFrame(divideSigned(frame.numerator, frame.denominator, mode), "Timeline frame");
}

/**
 * Converts a viewport-relative logical pixel to an exact frame-rate time. Rounding matches
 * pixelToFrame; a rounded result before timeline zero is rejected because RationalTime is
 * non-negative.
 */
export function pixelToTime(
  pixel: number,
  viewport: TimelineViewport,
  mode: RoundingMode,
): RationalTime {
  const frame = pixelToFrame(pixel, viewport, mode);
  if (frame < 0) {
    throw new VideoDomainError("invalid_time", "Pixel position resolves before timeline zero", {
      pixel,
      frame,
    });
  }
  return createRationalTime(frame, viewport.frameRate);
}

export function createTimelineViewport(input: TimelineViewportInput): TimelineViewport {
  const frameRate = validateRate(input.frameRate, "Timeline frame rate");
  const zoomScale = validateRate(input.zoomScale, "Timeline zoom scale");
  const scrollOrigin = validateTime(input.scrollOrigin, "Timeline scroll origin");
  const viewportWidthPixels = validatePixelNumber(input.viewportWidthPixels, "Viewport width");
  const overscanPixels = validatePixelNumber(input.overscanPixels, "Viewport overscan");
  if (viewportWidthPixels <= 0) {
    throw new VideoDomainError("invalid_range", "Viewport width must be positive", {
      viewportWidthPixels,
    });
  }
  if (overscanPixels < 0) {
    throw new VideoDomainError("invalid_range", "Viewport overscan cannot be negative", {
      overscanPixels,
    });
  }

  const timelineRange = validateTimelineFrameRange(input.timelineRange);
  const effectiveOverscanPixels = Math.min(overscanPixels, viewportWidthPixels);
  const baseViewport = Object.freeze({
    frameRate,
    zoomScale,
    scrollOrigin,
    viewportWidthPixels,
    overscanPixels,
    timelineRange,
    effectiveOverscanPixels,
    visibleRange: timelineRange,
    overscanRange: timelineRange,
  }) as TimelineViewport;
  const zeroPixel = normalizeFraction(0n, 1n);
  const width = numberToFraction(viewportWidthPixels, "Viewport width");
  const overscan = numberToFraction(effectiveOverscanPixels, "Viewport overscan");
  const visibleRange = deriveClampedRange(zeroPixel, width, baseViewport, timelineRange);
  const overscanRange = deriveClampedRange(
    normalizeFraction(-overscan.numerator, overscan.denominator),
    addFractions(width, overscan),
    baseViewport,
    timelineRange,
  );
  const viewport = Object.freeze({ ...baseViewport, visibleRange, overscanRange });
  timelineViewportInstances.add(viewport);
  return viewport;
}
