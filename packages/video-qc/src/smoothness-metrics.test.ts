// Ported from diffusion-studio-2 `checker/smoothness-metrics.test.ts` (commit eb91afe). Its
// calibration ran at 25 fps only; here the same cases run at 24, 25, 30 and 60 fps with move
// durations kept in seconds (8–100 frames at 25 fps = 0.32–4 s) and the rest speed kept in px/s.
import { easeFunction } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  dimensionlessJerk,
  fftMagnitude,
  LDLJ_MIN,
  logDimensionlessJerk,
  SPARC_MIN,
  sparc,
  withRest,
} from "./smoothness-metrics.js";

const RATES = [24, 25, 30, 60] as const;
/** The source's 25 fps durations, in seconds. */
const DURATION_SECONDS = [8, 12, 25, 50, 100].map((frames) => frames / 25);
/** 0.01 px/frame at 25 fps. */
const REST_PX_PER_SECOND = 0.25;

const minJerk = (u: number): number => 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
const twoStep = (u: number): number =>
  u < 0.5 ? minJerk(u * 2) / 2 : 0.5 + minJerk((u - 0.5) * 2) / 2;

/** Per-frame speed of a 400 px move shaped by `pos` over `frames`, with rest frames around it. */
function speedOf(pos: (u: number) => number, frames: number, fps: number): number[] {
  const speeds: number[] = [];
  for (let i = 1; i <= frames; i++)
    speeds.push(Math.abs(pos(i / frames) - pos((i - 1) / frames)) * 400);
  return withRest(speeds.filter((v) => v > REST_PX_PER_SECOND / fps));
}

const framesAt = (seconds: number, fps: number): number => Math.round(seconds * fps);

const smooth: readonly (readonly [string, (u: number) => number])[] = [
  ["minimum jerk", minJerk],
  ["easeInOut", easeFunction({ kind: "preset", name: "easeInOut" })],
  ["gentle spring", easeFunction({ kind: "preset", name: "gentle" })],
  ["inOutCubic", (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)],
];

describe("smoothness metrics", () => {
  it("matches the reference docstring values (siva82kb/SPARC)", () => {
    const move: number[] = [];
    for (let i = 0; i < 200; i++) move.push(Math.exp(-5 * (-1 + i * 0.01) ** 2));
    expect(sparc(move, 100).toFixed(5)).toBe("-1.41403");
    expect(dimensionlessJerk(move, 100).toFixed(5)).toBe("-335.74684");
    expect(logDimensionlessJerk(move, 100).toFixed(5)).toBe("-5.81636");
  });

  it("fft magnitude of an impulse is flat, of a constant is a spike", () => {
    expect(fftMagnitude([1], 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const constant = fftMagnitude([1, 1, 1, 1], 4);
    expect(constant[0]).toBe(4);
    for (const v of constant.slice(1)) expect(Math.abs(v)).toBeLessThan(1e-12);
  });

  it("handles a spectrum too large to spread into Math.max", () => {
    const long = Array.from({ length: 70_000 }, (_, i) => Math.sin((Math.PI * i) / 70_000));
    expect(Number.isFinite(sparc(long, 30))).toBe(true);
    expect(Number.isFinite(logDimensionlessJerk(long, 30))).toBe(true);
  });

  it.each([[[]], [[3]], [[0, 0, 0]]])("scores the degenerate profile %j as 0, not NaN", (s) => {
    expect(sparc(s, 25)).toBe(0);
    expect(logDimensionlessJerk(s, 25)).toBe(0);
  });

  describe.each(RATES)("at %i fps", (fps) => {
    it.each(smooth.flatMap(([name, pos]) => DURATION_SECONDS.map((s) => [name, pos, s] as const)))(
      "%s over %s passes both thresholds",
      (_name, pos, seconds) => {
        const speeds = speedOf(pos, framesAt(seconds, fps), fps);
        expect(sparc(speeds, fps)).toBeGreaterThanOrEqual(SPARC_MIN);
        expect(logDimensionlessJerk(speeds, fps)).toBeGreaterThanOrEqual(LDLJ_MIN);
      },
    );

    it.each(DURATION_SECONDS)(
      "linear start/stop and a two-step stutter over %ss fail SPARC",
      (s) => {
        const frames = framesAt(s, fps);
        expect(
          sparc(
            speedOf((u) => u, frames, fps),
            fps,
          ),
        ).toBeLessThan(SPARC_MIN);
        expect(sparc(speedOf(twoStep, frames, fps), fps)).toBeLessThan(SPARC_MIN);
      },
    );

    it.each([1, 2, 4])("frame-rate jitter over %is fails LDLJ", (seconds) => {
      const speeds = speedOf(minJerk, framesAt(seconds, fps), fps).map(
        (v, i) => v * (1 + 0.3 * (i % 2 ? 1 : -1)),
      );
      expect(logDimensionlessJerk(speeds, fps)).toBeLessThan(LDLJ_MIN);
    });
  });
});
