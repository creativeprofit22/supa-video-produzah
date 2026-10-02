import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileTrack,
  cubicBezier,
  easeFunction,
  easingSchema,
  spring,
  springSettlingSeconds,
  steps,
} from "./easing.js";

const samplesSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      easing: easingSchema,
      points: z.array(z.object({ t: z.number(), animejs: z.number(), expected: z.number() })),
    }),
  ),
  springSettling: z.array(
    z.object({ bounce: z.number(), durationMs: z.number(), settlingSeconds: z.number() }),
  ),
  tracks: z.array(
    z.object({
      name: z.string(),
      keys: z
        .array(z.object({ time: z.number(), value: z.number(), easing: easingSchema.optional() }))
        .min(1),
      samples: z.array(z.object({ time: z.number(), value: z.number() })),
    }),
  ),
});

const samples = samplesSchema.parse(
  JSON.parse(readFileSync(new URL("../fixtures/easing-samples.json", import.meta.url), "utf8")),
);

const CROSS_LANGUAGE_TOLERANCE = 1e-6;
const ANIMEJS_TOLERANCE = 1e-3;

describe("easing curves against the shared fixture", () => {
  it.each(samples.cases)("$name matches animejs and the recorded samples", ({ easing, points }) => {
    const ease = easeFunction(easing);

    for (const point of points) {
      const actual = ease(point.t);
      expect(Math.abs(actual - point.expected)).toBeLessThanOrEqual(CROSS_LANGUAGE_TOLERANCE);
      expect(Math.abs(actual - point.animejs)).toBeLessThanOrEqual(ANIMEJS_TOLERANCE);
    }
  });

  it.each(samples.springSettling)(
    "spring($bounce, $durationMs) settles after the recorded time",
    ({ bounce, durationMs, settlingSeconds }) => {
      expect(springSettlingSeconds(bounce, durationMs)).toBeCloseTo(settlingSeconds, 9);
    },
  );

  it.each(samples.tracks)("track $name samples match", ({ keys, samples: expected }) => {
    const [first, ...rest] = keys;
    if (first === undefined) throw new Error("fixture track has no keys");
    const track = compileTrack([first, ...rest]);

    for (const sample of expected) {
      expect(Math.abs(track(sample.time) - sample.value)).toBeLessThanOrEqual(
        CROSS_LANGUAGE_TOLERANCE,
      );
    }
  });
});

describe("easing properties", () => {
  const curves = [
    ["linear", easeFunction({ kind: "linear" })],
    ["easeInOut", easeFunction({ kind: "preset", name: "easeInOut" })],
    ["cubicBezier overshoot", cubicBezier(0.34, 1.56, 0.64, 1)],
    ["spring snappy", spring(0.15, 300)],
    ["spring heavy bounce", spring(0.9, 2000)],
    ["steps 4", steps(4)],
    ["steps 4 from start", steps(4, true)],
  ] as const;

  it.each(curves)("%s starts at 0 and ends at 1", (_name, ease) => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it.each([
    [0.42, 0, 0.58, 1],
    [0, 0, 1, 1],
    [0.25, 0.1, 0.25, 1],
    [0.7, 0, 0.84, 0],
    [1, 0, 0, 1],
  ])("cubicBezier(%f, %f, %f, %f) with y in 0..1 never decreases", (x1, y1, x2, y2) => {
    const ease = cubicBezier(x1, y1, x2, y2);
    let previous = ease(0);

    for (let index = 1; index <= 1000; index++) {
      const value = ease(index / 1000);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it.each([
    [0, 100],
    [0.3, 400],
    [0.65, 400],
    [0.9, 1000],
  ])("spring(%f, %i) is within 1e-3 of 1 once settled", (bounce, durationMs) => {
    const ease = spring(bounce, durationMs);

    for (const t of [0.95, 0.97, 0.99, 0.999]) {
      expect(Math.abs(ease(t) - 1)).toBeLessThan(1e-3);
    }
  });

  it("bouncy springs overshoot and critically damped ones do not", () => {
    const bouncy = spring(0.65, 400);
    const damped = spring(0, 400);
    const peak = (ease: (t: number) => number): number =>
      Math.max(...Array.from({ length: 200 }, (_, index) => ease(index / 200)));

    expect(peak(bouncy)).toBeGreaterThan(1.05);
    expect(peak(damped)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("steps jump at the end of each step, or at the start when fromStart", () => {
    expect([0.1, 0.3, 0.6, 0.9].map(steps(4))).toEqual([0, 0.25, 0.5, 0.75]);
    expect([0.1, 0.3, 0.6, 0.9].map(steps(4, true))).toEqual([0.25, 0.5, 0.75, 1]);
  });
});

describe("easing schema", () => {
  it.each([
    { kind: "spring", bounce: 2, durationMs: 300 },
    { kind: "spring", bounce: 0.2, durationMs: 5 },
    { kind: "steps", count: 0 },
    { kind: "cubicBezier", x1: 1.5, y1: 0, x2: 0.5, y2: 1 },
    { kind: "preset", name: "wobbly" },
    { kind: "linear", extra: true },
    { kind: "cubicBezier", x1: 0.5, y1: Number.NaN, x2: 0.5, y2: 1 },
  ])("rejects %o", (input) => {
    expect(easingSchema.safeParse(input).success).toBe(false);
  });
});
