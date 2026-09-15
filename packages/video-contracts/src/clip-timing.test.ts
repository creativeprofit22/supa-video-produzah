import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clipSpeedPercent,
  clipSpeedSchema,
  clipTimelineDuration,
  parseClipSpeedPercent,
  normalizeClipSpeed,
  sourceOffsetToTimeline,
  timelineOffsetToSource,
  type ClipSpeed,
} from "./clip-timing.js";
import { createRationalTime, type RationalRate, type RationalTime } from "./time.js";

interface Fixture {
  name: string;
  sourceIn: RationalTime;
  sourceOut: RationalTime;
  sequenceRate: RationalRate;
  speed?: ClipSpeed;
  expected: number | null;
}
const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../fixtures/clip-speed-timing.json", import.meta.url), "utf8"),
);
const rate = { numerator: 30, denominator: 1 };

describe("exact clip speed timing", () => {
  it.each(fixtures)("shared fixture: $name", (fixture) => {
    const original = structuredClone(fixture);
    const calculate = () =>
      clipTimelineDuration(
        { in: fixture.sourceIn, out: fixture.sourceOut },
        fixture.sequenceRate,
        fixture.speed,
      );
    if (fixture.expected === null) expect(calculate).toThrow();
    else expect(calculate().value).toBe(fixture.expected);
    expect(fixture).toEqual(original);
  });

  it("normalizes normal-speed edits to omission without mutating the input", () => {
    const normal = { numerator: 1, denominator: 1 };
    expect(normalizeClipSpeed(normal)).toBeUndefined();
    expect(normal).toEqual({ numerator: 1, denominator: 1 });
    expect(normalizeClipSpeed(parseClipSpeedPercent("150"))).toEqual({
      numerator: 3,
      denominator: 2,
    });
  });

  it("parses every whole percentage exactly and reduces fractions", () => {
    for (let percent = 50; percent <= 200; percent++) {
      expect(clipSpeedPercent(parseClipSpeedPercent(String(percent)))).toBe(percent);
    }
    expect(parseClipSpeedPercent("150")).toEqual({ numerator: 3, denominator: 2 });
    expect(parseClipSpeedPercent("100")).toEqual({ numerator: 1, denominator: 1 });
  });

  it.each(["", " 50", "50 ", "050", "1e2", "100.5", "-100", "0", "49", "201", "Infinity"])(
    "rejects invalid UI percentage %s without clamping",
    (text) => {
      expect(() => parseClipSpeedPercent(text)).toThrow();
    },
  );

  it.each([
    null,
    { numerator: -1, denominator: 1 },
    { numerator: 1, denominator: 0 },
    { numerator: 0, denominator: 1 },
    { numerator: 1, denominator: -1 },
    { numerator: 1, denominator: 1.5 },
    { numerator: 1.5, denominator: 1 },
    { numerator: 1, denominator: 1, extra: true },
    { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 },
  ])("rejects invalid speed shape %j", (speed) => {
    expect(clipSpeedSchema.safeParse(speed).success).toBe(false);
  });

  it("distinguishes exact edit boundaries from floor-sampled display offsets", () => {
    const speed = parseClipSpeedPercent("150");
    const one = createRationalTime(1, rate);
    expect(() => timelineOffsetToSource(one, rate, speed)).toThrow("inexact");
    expect(timelineOffsetToSource(one, rate, speed, "floor").value).toBe(1);
    expect(() => sourceOffsetToTimeline(one, rate, speed)).toThrow("inexact");
    expect(sourceOffsetToTimeline(one, rate, speed, "floor").value).toBe(0);
    expect(timelineOffsetToSource(createRationalTime(0, rate), rate, speed).value).toBe(0);
  });

  it("rejects an unknown sampling policy instead of silently rounding edits", () => {
    expect(() =>
      timelineOffsetToSource(
        createRationalTime(1, rate),
        rate,
        parseClipSpeedPercent("150"),
        "nearest" as "exact",
      ),
    ).toThrow("Unknown frame sampling policy");
  });

  it("round trips exact source offsets at every supported percentage", () => {
    for (let percent = 50; percent <= 200; percent++) {
      const speed = parseClipSpeedPercent(String(percent));
      const source = createRationalTime(percent * 3, rate);
      const timeline = sourceOffsetToTimeline(source, rate, speed);
      expect(timeline.value).toBe(300);
      expect(timelineOffsetToSource(timeline, rate, speed)).toEqual(source);
    }
  });
});
