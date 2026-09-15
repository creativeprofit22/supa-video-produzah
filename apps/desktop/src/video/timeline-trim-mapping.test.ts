import type { ProjectClip } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";
import { minimumTimelineTrimStart, sourceFrameAtTimelineDelta } from "./timeline-trim-mapping";

const clip: ProjectClip = {
  id: "10000000-0000-4000-8000-000000000001",
  source: { kind: "asset", assetId: "10000000-0000-4000-8000-000000000002" },
  transform: {
    positionXPermille: 0,
    positionYPermille: 0,
    scaleXPermille: 1000,
    scaleYPermille: 1000,
    rotationMilliDegrees: 0,
    opacityPermille: 1000,
  },
  gainMilliDecibels: 0,
  timelineStart: { value: 10, rateNumerator: 30, rateDenominator: 1 },
  sourceIn: { value: 30, rateNumerator: 30, rateDenominator: 1 },
  sourceOut: { value: 330, rateNumerator: 30, rateDenominator: 1 },
  speed: { numerator: 3, denominator: 2 },
};

describe("retimed pointer trim mapping", () => {
  it("maps signed timeline deltas exactly rather than applying them as source frames", () => {
    expect(sourceFrameAtTimelineDelta(clip, 30, 2)).toBe(33);
    expect(sourceFrameAtTimelineDelta(clip, 30, -2)).toBe(27);
    expect(sourceFrameAtTimelineDelta(clip, 330, 2)).toBe(333);
    expect(() => sourceFrameAtTimelineDelta(clip, 30, 1)).toThrow("inexact frame boundary");
    expect(() => sourceFrameAtTimelineDelta(clip, 30, -22)).toThrow("outside the source range");
  });
  it("bounds source zero without rounding the actual edit boundary", () => {
    const nearZero = { ...clip, sourceIn: { ...clip.sourceIn, value: 1 } };
    expect(minimumTimelineTrimStart(nearZero)).toBe(10);
    const exact = { ...clip, sourceIn: { ...clip.sourceIn, value: 3 } };
    expect(minimumTimelineTrimStart(exact)).toBe(8);
    expect(sourceFrameAtTimelineDelta(exact, 3, -2)).toBe(0);
  });
  it("combines speed and differing rates before division", () => {
    const mixed = {
      ...clip,
      sourceIn: { ...clip.sourceIn, rateNumerator: 60 },
      speed: { numerator: 1, denominator: 2 },
    };
    expect(sourceFrameAtTimelineDelta(mixed, 30, 1)).toBe(31);
  });
});
