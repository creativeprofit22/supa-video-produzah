/**
 * Keyframe easing curves shared by graphics clips, motion presets and the graphics renderer.
 *
 * `cubicBezier`, `spring` and `steps` are exact ports of animejs 4.5.0 (via diffusion-studio-2
 * `lib/motion.ts`). The Rust renderer has the same math in `graphics-renderer/src/easing.rs`; both
 * sides are checked against `fixtures/easing-samples.json`. See docs/adr/0003-graphics-clips.md.
 */
import { z } from "zod";

export type EaseFunction = (progress: number) => number;

export const EASING_PRESET_NAMES = [
  "easeIn",
  "easeOut",
  "easeInOut",
  "gentle",
  "snappy",
  "bouncy",
  "strong",
] as const;
export const easingPresetNameSchema = z.enum(EASING_PRESET_NAMES);
export type EasingPresetName = z.infer<typeof easingPresetNameSchema>;

export const MAX_BEZIER_Y = 10;
export const MIN_SPRING_DURATION_MS = 10;
export const MAX_SPRING_DURATION_MS = 10_000;
export const MAX_EASING_STEPS = 1_000;

const unitSchema = z.number().finite().min(0).max(1);
const bezierYSchema = z.number().finite().min(-MAX_BEZIER_Y).max(MAX_BEZIER_Y);

export const easingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear") }).strict(),
  z.object({ kind: z.literal("preset"), name: easingPresetNameSchema }).strict(),
  z
    .object({
      kind: z.literal("cubicBezier"),
      x1: unitSchema,
      y1: bezierYSchema,
      x2: unitSchema,
      y2: bezierYSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("spring"),
      bounce: z.number().finite().min(-1).max(1),
      durationMs: z.number().int().safe().min(MIN_SPRING_DURATION_MS).max(MAX_SPRING_DURATION_MS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("steps"),
      count: z.number().int().safe().min(1).max(MAX_EASING_STEPS),
      fromStart: z.boolean().optional(),
    })
    .strict(),
]);
export type Easing = z.infer<typeof easingSchema>;

type PrimitiveEasing = Exclude<Easing, { kind: "preset" }>;

/** Preset → curve, as Diffusion Studio expands them (document.ts `EASINGS`). */
export const EASING_PRESETS: Readonly<Record<EasingPresetName, PrimitiveEasing>> = {
  easeIn: { kind: "cubicBezier", x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { kind: "cubicBezier", x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { kind: "cubicBezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  gentle: { kind: "spring", bounce: 0.5, durationMs: 628 },
  snappy: { kind: "spring", bounce: 0.15, durationMs: 300 },
  bouncy: { kind: "spring", bounce: 0.4, durationMs: 500 },
  strong: { kind: "spring", bounce: 0.65, durationMs: 400 },
};

const clampTo = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

// Cubic bezier: animejs 4 port of gre/bezier-easing (binary subdivision, 1e-7, 100 iterations).
const calcBezier = (t: number, a1: number, a2: number): number =>
  ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;

const binarySubdivide = (x: number, x1: number, x2: number): number => {
  let low = 0;
  let high = 1;
  let currentX: number;
  let currentT: number;
  let iteration = 0;
  do {
    currentT = low + (high - low) / 2;
    currentX = calcBezier(currentT, x1, x2) - x;
    if (currentX > 0) high = currentT;
    else low = currentT;
  } while (Math.abs(currentX) > 0.0000001 && ++iteration < 100);
  return currentT;
};

/** CSS-style cubic bezier through (0,0),(x1,y1),(x2,y2),(1,1). y may overshoot 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFunction {
  if (x1 === y1 && x2 === y2) return (t) => t;
  return (t) => (t === 0 || t === 1 ? t : calcBezier(binarySubdivide(t, x1, x2), y1, y2));
}

type SpringSolver = Readonly<{ solve: (seconds: number) => number; settlingSeconds: number }>;

function springSolver(bounce: number, durationMs: number): SpringSolver {
  const scale = 1e3;
  const minValue = 1e-11;
  const maxParam = scale * 10;
  const timeStep = 0.02;
  const maxRestSteps = 200 / timeStep / scale;
  const maxIterations = 60000 / timeStep / scale;
  const restThreshold = 0.0005;
  const round3 = (value: number): number => Math.round(value * 1000) / 1000;

  const clampedBounce = clampTo(bounce, -1, 1);
  const perceivedSeconds = clampTo(durationMs, 10, maxParam) / scale;
  const mass = 1;
  const velocity = 0;
  const stiffness = round3(clampTo(((2 * Math.PI) / perceivedSeconds) ** 2, minValue, maxParam));
  const rawDamping =
    clampedBounce >= 0
      ? ((1 - clampedBounce) * 4 * Math.PI) / perceivedSeconds
      : (4 * Math.PI) / (perceivedSeconds * (1 + clampedBounce));
  const damping = round3(clampTo(rawDamping, minValue, 300));

  const w0 = clampTo(Math.sqrt(stiffness / mass), minValue, scale);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd =
    zeta < 1 ? w0 * Math.sqrt(1 - zeta * zeta) : zeta === 1 ? 0 : w0 * Math.sqrt(zeta * zeta - 1);
  const b = zeta === 1 ? -velocity + w0 : (zeta * w0 + -velocity) / wd;

  const solve = (time: number): number => {
    let x: number;
    if (zeta < 1) {
      x = Math.exp(-time * zeta * w0) * (1 * Math.cos(wd * time) + b * Math.sin(wd * time));
    } else if (zeta === 1) {
      x = (1 + b * time) * Math.exp(-time * w0);
    } else {
      x =
        ((1 + b) * Math.exp((-zeta * w0 + wd) * time) +
          (1 - b) * Math.exp((-zeta * w0 - wd) * time)) /
        2;
    }
    return 1 - x;
  };

  // Settling time: first moment the spring stays within restThreshold for the rest duration.
  let settlingSeconds = 0;
  let solverTime = 0;
  let restSteps = 0;
  let iterations = 0;
  while (restSteps <= maxRestSteps && iterations <= maxIterations) {
    restSteps = Math.abs(1 - solve(solverTime)) < restThreshold ? restSteps + 1 : 0;
    settlingSeconds = solverTime;
    solverTime += timeStep;
    iterations++;
  }
  return { solve, settlingSeconds };
}

/**
 * Spring with a -1..1 bounce and a perceived duration in ms (animejs 4 `spring({bounce,duration}).ease`).
 * Input is 0..1 of the keyframe segment; output overshoots 1 when bounce > 0 and is exactly 0 / 1 at the ends.
 */
export function spring(bounce: number, durationMs: number): EaseFunction {
  const { solve, settlingSeconds } = springSolver(bounce, durationMs);
  return (t) => (t === 0 || t === 1 ? t : solve(t * settlingSeconds));
}

/** Seconds of simulated spring motion one keyframe segment is stretched over. */
export function springSettlingSeconds(bounce: number, durationMs: number): number {
  return springSolver(bounce, durationMs).settlingSeconds;
}

/** n discrete values (CSS jump-end; jump-start when fromStart). */
export function steps(count: number, fromStart = false): EaseFunction {
  const round = fromStart ? Math.ceil : Math.floor;
  return (t) => round(clampTo(t, 0, 1) * count) * (1 / count);
}

/** A preset expanded to the curve it stands for; other easings unchanged. */
export function resolveEasing(easing: Easing): PrimitiveEasing {
  return easing.kind === "preset" ? EASING_PRESETS[easing.name] : easing;
}

export function easeFunction(easing: Easing): EaseFunction {
  const resolved = resolveEasing(easing);
  switch (resolved.kind) {
    case "linear":
      return (t) => t;
    case "cubicBezier":
      return cubicBezier(resolved.x1, resolved.y1, resolved.x2, resolved.y2);
    case "spring":
      return spring(resolved.bounce, resolved.durationMs);
    case "steps":
      return steps(resolved.count, resolved.fromStart ?? false);
  }
}

/** One key of a sampled track; `easing` shapes the segment to the NEXT key (linear when absent). */
export type SampledKeyframe = Readonly<{
  time: number;
  value: number;
  easing?: Easing | undefined;
}>;

/**
 * Compiles keys with strictly increasing times into a function of time (same unit as the keys).
 * The first value holds before the first key and the last value after the last key.
 */
export function compileTrack(
  keys: readonly [SampledKeyframe, ...SampledKeyframe[]],
): (time: number) => number {
  const eases = keys.slice(0, -1).map((key) => easeFunction(key.easing ?? { kind: "linear" }));
  const first = keys[0];
  const last = keys[keys.length - 1] ?? first;
  return (time) => {
    if (keys.length === 1 || time <= first.time) return first.value;
    if (time >= last.time) return last.value;
    for (let index = 0; index < keys.length - 1; index++) {
      const from = keys[index];
      const to = keys[index + 1];
      const ease = eases[index];
      if (from === undefined || to === undefined || ease === undefined) break;
      if (time < from.time || time > to.time) continue;
      const span = to.time - from.time;
      if (span <= 0) continue;
      const progress = ease(clampTo((time - from.time) / span, 0, 1));
      return from.value + (to.value - from.value) * progress;
    }
    return last.value;
  };
}

export function sampleTrack(
  keys: readonly [SampledKeyframe, ...SampledKeyframe[]],
  time: number,
): number {
  return compileTrack(keys)(time);
}
