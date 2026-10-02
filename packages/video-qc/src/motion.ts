/*
 * Motion smoothness of graphics layers, scored from their keyframe tracks.
 *
 * Ported from diffusion-studio-2 `checker/rules/motion-rules.ts` (commit eb91afe), which was
 * tuned at 25 fps. Here frame counts become durations and px/frame speeds become px/s, then
 * both are converted back to frames at the sequence rate (`motionThresholds`). SPARC and LDLJ
 * are sampled at the sequence rate; their thresholds hold at 24–60 fps unchanged
 * (smoothness-metrics.test.ts).
 *
 * The speed signal is the layer's x/y position only: `hypot(dx, dy)` per sequence frame while
 * the clip is on screen. Scale, rotation, opacity and text-unit offsetY are not scored, so a
 * layer moving while fully transparent still counts as moving.
 *
 * A cut is a start or end frame of a clip on a visible video track, strictly inside the
 * picture. A speed sample ending on a cut compares two shots, so it is dropped and the move
 * splits there; if the layer is moving on both sides it is flagged as a jump across the cut.
 *
 * Departure from the source: a spring overshoot reverses direction, so one speed sample can
 * fall to rest and split the settle wobble off as its own slow move. Such a settle tail — a
 * move starting under `maxSlowSeconds` after a fast move (or after another settle tail of
 * it), with no cut in between — is exempt from the peak-speed drift check. Its slow stretches
 * are still held to `maxSlowSeconds`.
 */
import {
  clipTimelineDuration,
  compileTrack,
  createRationalTime,
  type GraphicsClip,
  type GraphicsKeyframeTrack,
  type QcFindingKind,
  type QcRange,
  type QcSeverity,
  type RationalRate,
  rationalTimeToMicroseconds,
  type VideoSequenceV2,
} from "@supa-video/contracts";

import {
  LDLJ_MIN,
  logDimensionlessJerk,
  SPARC_MIN,
  sparc,
  withRest,
} from "./smoothness-metrics.js";

/** The source's 25 fps tuning, expressed in rate-independent units. */
export const MOTION_TUNING = {
  /** Below this a sample is at rest (0.01 px/frame at 25 fps). */
  restPxPerSecond: 0.25,
  /** Slowest motion that reads as intended movement (1 px/frame at 25 fps). */
  driftPxPerSecond: 25,
  /** Slow stretches shorter than this are allowed ease tails. */
  maxSlowSeconds: 0.5,
  /** Moves shorter than this are not scored for smoothness (5 frames at 25 fps). */
  minMoveSeconds: 0.2,
} as const;

export interface MotionThresholds {
  readonly fps: number;
  readonly restPerFrame: number;
  readonly driftPerFrame: number;
  readonly minMoveFrames: number;
  readonly maxSlowFrames: number;
}

export function motionThresholds(rate: RationalRate): MotionThresholds {
  const fps = rate.numerator / rate.denominator;
  return {
    fps,
    restPerFrame: MOTION_TUNING.restPxPerSecond / fps,
    driftPerFrame: MOTION_TUNING.driftPxPerSecond / fps,
    minMoveFrames: Math.max(3, Math.round(MOTION_TUNING.minMoveSeconds * fps)),
    maxSlowFrames: Math.max(1, Math.round(MOTION_TUNING.maxSlowSeconds * fps)),
  };
}

/** Per-frame speeds of one layer; `speed[k]` spans sequence frames (f0+k−1 → f0+k), in px/frame. */
export interface LayerSpeeds {
  readonly f0: number;
  readonly speed: readonly number[];
}

/**
 * Samples a track at increasing times. Each segment is compiled on its own with
 * `compileTrack`, so values match the renderer while sampling stays linear in frames.
 */
function monotonicSampler(track: GraphicsKeyframeTrack): (time: number) => number {
  const keys = track.map((key) => ({
    time: key.timeMicroseconds,
    value: key.value,
    easing: key.easing,
  }));
  const first = keys[0];
  if (first === undefined) return () => 0;
  const segments = keys.length === 1 ? [compileTrack([first])] : [];
  for (let index = 0; index + 1 < keys.length; index++) {
    const from = keys[index];
    const to = keys[index + 1];
    if (from !== undefined && to !== undefined) segments.push(compileTrack([from, to]));
  }
  let segment = 0;
  return (time) => {
    while (segment + 1 < segments.length && time > (keys[segment + 1]?.time ?? Infinity)) segment++;
    return segments[segment]?.(time) ?? first.value;
  };
}

export function layerSpeeds(
  clip: GraphicsClip,
  layerIndex: number,
  rate: RationalRate,
): LayerSpeeds {
  const layer = clip.layers[layerIndex];
  if (layer === undefined) return { f0: clip.timelineStart.value + 1, speed: [] };
  const x = monotonicSampler(layer.x);
  const y = monotonicSampler(layer.y);
  const microsecondsPerFrame = (1e6 * rate.denominator) / rate.numerator;
  const speed: number[] = [];
  let previousX = x(0);
  let previousY = y(0);
  for (let frame = 1; frame < clip.duration.value; frame++) {
    const time = frame * microsecondsPerFrame;
    const nextX = x(time);
    const nextY = y(time);
    speed.push(Math.hypot(nextX - previousX, nextY - previousY));
    previousX = nextX;
    previousY = nextY;
  }
  return { f0: clip.timelineStart.value + 1, speed };
}

/** Start/end frames of clips on visible video tracks, strictly inside the picture. Sorted. */
export function sequenceCutFrames(sequence: VideoSequenceV2): number[] {
  const boundaries: number[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "video" || track.hidden === true) continue;
    for (const clip of track.clips) {
      const duration = clipTimelineDuration(
        { in: clip.sourceIn, out: clip.sourceOut },
        sequence.rate,
        clip.speed,
      );
      boundaries.push(clip.timelineStart.value, clip.timelineStart.value + duration.value);
    }
  }
  const end = maxOf(boundaries);
  return [...new Set(boundaries)].filter((frame) => frame > 0 && frame < end).sort((a, b) => a - b);
}

/** One move: contiguous samples above rest, never across a cut. Same indexing as `LayerSpeeds`. */
export interface Move {
  readonly f0: number;
  readonly speed: readonly number[];
}

export function splitMoves(
  speeds: LayerSpeeds,
  cutFrames: ReadonlySet<number>,
  restPerFrame: number,
): Move[] {
  const moves: Move[] = [];
  let start = -1;
  const flush = (end: number): void => {
    if (start >= 0) moves.push({ f0: speeds.f0 + start, speed: speeds.speed.slice(start, end) });
    start = -1;
  };
  speeds.speed.forEach((value, k) => {
    const moving = value > restPerFrame && !cutFrames.has(speeds.f0 + k);
    if (moving && start < 0) start = k;
    if (!moving) flush(k);
  });
  flush(speeds.speed.length);
  return moves;
}

export type MotionDraft = Readonly<{
  kind: Extract<QcFindingKind, "motion_stutter" | "motion_drift" | "motion_cut_jump">;
  severity: QcSeverity;
  subject: string;
  range: QcRange;
  message: string;
}>;

const fmt = (value: number, digits = 2): string => value.toFixed(digits);

function frameRange(startFrame: number, endFrame: number, rate: RationalRate): QcRange {
  return {
    startUs: rationalTimeToMicroseconds(createRationalTime(Math.max(0, startFrame), rate), "floor"),
    endUs: rationalTimeToMicroseconds(createRationalTime(Math.max(0, endFrame), rate), "ceil"),
  };
}

function maxOf(values: readonly number[]): number {
  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  return peak;
}

/** Whether a cut drops a speed sample in frames `from` (inclusive) to `to` (exclusive). */
function cutBetween(cuts: readonly number[], from: number, to: number): boolean {
  return cuts.some((cut) => cut >= from && cut < to);
}

function layerFindings(
  subject: string,
  label: string,
  speeds: LayerSpeeds,
  cuts: readonly number[],
  rate: RationalRate,
  limits: MotionThresholds,
): MotionDraft[] {
  const drafts: MotionDraft[] = [];
  const perSecond = (perFrame: number): string => `${fmt(perFrame * limits.fps, 1)} px/s`;
  /** Frames from the one before sample `a` to the end of sample `b − 1`. */
  const rangeOf = (move: Move, a = 0, b = move.speed.length): QcRange =>
    frameRange(move.f0 + a - 1, move.f0 + b - 1, rate);

  /** End frame of the previous move, and whether a slow move right after it is a settle tail. */
  let previous: { readonly end: number; readonly settles: boolean } | undefined;
  for (const move of splitMoves(speeds, new Set(cuts), limits.restPerFrame)) {
    const peak = maxOf(move.speed);
    const settleTail =
      previous !== undefined &&
      previous.settles &&
      move.f0 - previous.end < limits.maxSlowFrames &&
      !cutBetween(cuts, previous.end, move.f0);
    previous = {
      end: move.f0 + move.speed.length,
      settles: peak >= limits.driftPerFrame || settleTail,
    };

    if (move.speed.length >= limits.minMoveFrames) {
      const profile = withRest(move.speed);
      const s = sparc(profile, limits.fps);
      const j = logDimensionlessJerk(profile, limits.fps);
      const bad = [
        s < SPARC_MIN ? `SPARC ${fmt(s)}` : "",
        j < LDLJ_MIN ? `LDLJ ${fmt(j)}` : "",
      ].filter((part) => part.length > 0);
      if (bad.length > 0)
        drafts.push({
          kind: "motion_stutter",
          severity: "warning",
          subject,
          range: rangeOf(move),
          message: `${label} stutters: ${bad.join(", ")} over ${String(move.speed.length)} frames (allowed SPARC ≥ ${String(SPARC_MIN)}, LDLJ ≥ ${String(LDLJ_MIN)})`,
        });
    }

    if (peak < limits.driftPerFrame && !settleTail) {
      drafts.push({
        kind: "motion_drift",
        severity: "warning",
        subject,
        range: rangeOf(move),
        message: `${label} drifts: peak ${perSecond(peak)} (allowed ≥ ${String(MOTION_TUNING.driftPxPerSecond)} px/s)`,
      });
      continue;
    }
    for (let k = 0; k < move.speed.length;) {
      if ((move.speed[k] ?? 0) >= limits.driftPerFrame) {
        k++;
        continue;
      }
      let e = k;
      while (e < move.speed.length && (move.speed[e] ?? 0) < limits.driftPerFrame) e++;
      if (e - k >= limits.maxSlowFrames)
        drafts.push({
          kind: "motion_drift",
          severity: "warning",
          subject,
          range: rangeOf(move, k, e),
          message: `${label} drifts: ${fmt((e - k) / limits.fps)} s under ${String(MOTION_TUNING.driftPxPerSecond)} px/s (allowed < ${String(MOTION_TUNING.maxSlowSeconds)} s)`,
        });
      k = e;
    }
  }

  for (const cut of cuts) {
    const k = cut - speeds.f0;
    const before = speeds.speed[k - 1];
    const after = speeds.speed[k + 1];
    if (before === undefined || after === undefined) continue;
    if (before > limits.restPerFrame && after > limits.restPerFrame)
      drafts.push({
        kind: "motion_cut_jump",
        severity: "warning",
        subject,
        range: frameRange(cut - 1, cut + 1, rate),
        message: `${label} keeps moving across a picture cut: ${perSecond(before)} before, ${perSecond(after)} after (allowed: at rest on the cut)`,
      });
  }
  return drafts;
}

/** Motion findings for every layer of every graphics clip on a visible graphics track. */
export function motionFindings(sequence: VideoSequenceV2): MotionDraft[] {
  const limits = motionThresholds(sequence.rate);
  const cuts = sequenceCutFrames(sequence);
  const drafts: MotionDraft[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "graphics" || track.hidden === true) continue;
    for (const clip of track.graphicsClips) {
      const start = clip.timelineStart.value;
      const end = start + clip.duration.value;
      const inside = cuts.filter((cut) => cut > start && cut < end);
      clip.layers.forEach((layer, layerIndex) => {
        const label = `Graphics ${layer.kind} layer ${String(layerIndex + 1)}`;
        drafts.push(
          ...layerFindings(
            `${clip.id}:${String(layerIndex)}`,
            label,
            layerSpeeds(clip, layerIndex, sequence.rate),
            inside,
            sequence.rate,
            limits,
          ),
        );
      });
    }
  }
  return drafts;
}
