import { describe, expect, it } from "vitest";

import { VideoDomainError } from "./errors.js";
import {
  compareRationalTimes,
  createRationalRate,
  createRationalTime,
  frameRangeDuration,
  microsecondsToSourceFrames,
  rationalRateSchema,
  rationalTimeToMicroseconds,
  rescaleRationalTime,
  validateFrameRange,
} from "./time.js";

const requiredRates = [
  [24, 1],
  [25, 1],
  [30, 1],
  [30_000, 1_001],
  [60_000, 1_001],
] as const;

describe("rational time", () => {
  it.each(requiredRates)("round-trips one frame at %i/%i", (numerator, denominator) => {
    const rate = createRationalRate(numerator, denominator);
    const oneFrame = createRationalTime(1, rate);
    const microseconds = rationalTimeToMicroseconds(oneFrame, "nearestTiesAwayFromZero");
    expect(microsecondsToSourceFrames(microseconds, rate).value).toBeGreaterThanOrEqual(1);
    expect(frameRangeDuration({ in: createRationalTime(0, rate), out: oneFrame })).toEqual(
      oneFrame,
    );
  });

  it("reduces rates and rejects unreduced persisted rates", () => {
    expect(createRationalRate(60_000, 2_002)).toEqual({ numerator: 30_000, denominator: 1_001 });
    expect(() => rationalRateSchema.parse({ numerator: 60_000, denominator: 2_002 })).toThrow(
      "reduced",
    );
  });

  it("keeps a partial final source frame addressable", () => {
    const rate = createRationalRate(30, 1);
    expect(microsecondsToSourceFrames(33_334, rate).value).toBe(2);
  });

  it("uses explicit floor, ceil, ties-away, and exact rescaling", () => {
    const source = createRationalTime(1, createRationalRate(2, 1));
    const target = createRationalRate(1, 1);
    expect(rescaleRationalTime(source, target, "floor").value).toBe(0);
    expect(rescaleRationalTime(source, target, "ceil").value).toBe(1);
    expect(rescaleRationalTime(source, target, "nearestTiesAwayFromZero").value).toBe(1);
    expect(
      rescaleRationalTime(createRationalTime(2, createRationalRate(2, 1)), target, "exact").value,
    ).toBe(1);
    expect(() => rescaleRationalTime(source, target, "exact")).toThrow(
      "cannot be represented exactly",
    );
  });

  it("rejects mixed-rate comparisons and sub-frame ranges", () => {
    const at24 = createRationalTime(1, createRationalRate(24, 1));
    const at25 = createRationalTime(1, createRationalRate(25, 1));
    expect(() => compareRationalTimes(at24, at25)).toThrowError(VideoDomainError);
    expect(() => validateFrameRange({ in: at24, out: at24 })).toThrow("at least one frame");
  });

  it("supports long durations without floating-point drift", () => {
    const rate = createRationalRate(60_000, 1_001);
    const eightHours = microsecondsToSourceFrames(8 * 60 * 60 * 1_000_000, rate);
    expect(eightHours.value).toBe(1_726_274);
    expect(rationalTimeToMicroseconds(eightHours, "floor")).toBeLessThanOrEqual(
      8 * 60 * 60 * 1_000_000 + 16_684,
    );
  });

  it("rejects unsafe integer values", () => {
    expect(() =>
      createRationalTime(Number.MAX_SAFE_INTEGER + 1, createRationalRate(24, 1)),
    ).toThrow();
    expect(() => microsecondsToSourceFrames(-1, createRationalRate(24, 1))).toThrow();
  });
});
