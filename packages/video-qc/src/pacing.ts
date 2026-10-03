/*
 * Pacing findings: shot rhythm and, when music beats exist, how cuts sit on
 * them. Ported from diffusion-studio-2 `checker/music-fit.ts` (`beatPacing`,
 * `cutsOnBeat`) and `checker/rules/timing-rules.ts` (1–7 s shots, steady
 * runs of four). All findings are `info`: they describe rhythm, not defects,
 * so they never change the QC status.
 *
 * Music beats here are timeline microseconds of detected music beats; they
 * are never narrative beats (see CONTEXT.md).
 */
import {
  clipTimelineDuration,
  type QcFindingKind,
  type QcRange,
  type QcSeverity,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { sequenceCutFrames } from "./motion.js";

export const SHOT_MIN_US = 1_000_000;
export const SHOT_MAX_US = 7_000_000;
/** This many consecutive shots of the same length (±1 frame) are a steady tick, not a rhythm. */
export const STEADY_SHOT_RUN = 4;
/** A cut within this distance of a music beat is on it: one frame, never below 40 ms. */
export const MIN_MUSIC_BEAT_TOLERANCE_US = 40_000;

/** Musical shot-to-music-beat ratios a cut pattern can lock to. */
const MUSICAL_RATIOS: readonly (readonly [string, number])[] = [
  ["1/4", 1 / 4],
  ["1/3", 1 / 3],
  ["1/2", 1 / 2],
  ["2/3", 2 / 3],
  ["1", 1],
  ["3/2", 3 / 2],
  ["2", 2],
  ["3", 3],
  ["4", 4],
];

export type PacingDraft = Readonly<{
  kind: Extract<
    QcFindingKind,
    "cut_off_music_beat" | "music_fit" | "shot_length_out_of_range" | "steady_shot_run"
  >;
  severity: QcSeverity;
  subject: string;
  range: QcRange;
  message: string;
}>;

/** One shot: the picture between two cuts, in timeline frames. */
export interface Shot {
  readonly index: number;
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface PacingInput {
  readonly sequence: VideoSequenceV2;
  /** Sorted timeline-microsecond music beats; [] when none were detected. */
  readonly musicBeatsUs: readonly number[];
  /** The music beats came from the in-app tempo fallback, not Beat This!. */
  readonly musicBeatsFromTempoFallback?: boolean;
}

function frameToUs(frame: number, sequence: VideoSequenceV2): number {
  return Math.round((frame * sequence.rate.denominator * 1_000_000) / sequence.rate.numerator);
}

function frameDurationUs(sequence: VideoSequenceV2): number {
  return (sequence.rate.denominator * 1_000_000) / sequence.rate.numerator;
}

/** Last frame covered by a visible video clip (0 when there is no picture). */
function pictureEndFrame(sequence: VideoSequenceV2): number {
  let end = 0;
  for (const track of sequence.tracks) {
    if (track.kind !== "video" || track.hidden === true) continue;
    for (const clip of track.clips) {
      const duration = clipTimelineDuration(
        { in: clip.sourceIn, out: clip.sourceOut },
        sequence.rate,
        clip.speed,
      );
      end = Math.max(end, clip.timelineStart.value + duration.value);
    }
  }
  return end;
}

/** Shots between frame 0, every cut and the picture end. */
export function shotsFromCuts(cutFrames: readonly number[], endFrame: number): readonly Shot[] {
  if (endFrame <= 0) return [];
  const bounds = [0, ...cutFrames.filter((cut) => cut > 0 && cut < endFrame), endFrame];
  const shots: Shot[] = [];
  for (let index = 1; index < bounds.length; index += 1) {
    const startFrame = bounds[index - 1] ?? 0;
    const endBound = bounds[index] ?? startFrame;
    if (endBound > startFrame) shots.push({ index: shots.length, startFrame, endFrame: endBound });
  }
  return shots;
}

/** The sequence's shots, cut where visible video clips start or end. */
export function sequenceShots(sequence: VideoSequenceV2): readonly Shot[] {
  return shotsFromCuts(sequenceCutFrames(sequence), pictureEndFrame(sequence));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest value to `target` in ascending `values` (earlier on ties). */
function nearest(values: readonly number[], target: number): number | undefined {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  const after = values[low];
  const before = values[low - 1];
  if (before === undefined) return after;
  if (after === undefined) return before;
  return target - before <= after - target ? before : after;
}

export type MusicBeatPacing = Readonly<{
  /** Median inter-music-beat interval (µs). */
  periodUs: number;
  /** Median shot length / period. */
  ratio: number;
  /** Nearest musical ratio label, such as "2" or "1/2". */
  nearest: string;
  /** log2(ratio / nearest): 0 = locked, ±0.585 is the widest gap. */
  deviation: number;
}>;

/**
 * Music beat period = median inter-beat interval; ratio = median shot length
 * / period, snapped to the nearest musical ratio in log2 space.
 */
export function musicBeatPacing(
  musicBeatsUs: readonly number[],
  shotMedianUs: number,
): MusicBeatPacing | undefined {
  if (musicBeatsUs.length < 2 || !(shotMedianUs > 0)) return undefined;
  const periodUs = median(
    musicBeatsUs.slice(1).map((time, index) => time - (musicBeatsUs[index] ?? 0)),
  );
  if (!(periodUs > 0)) return undefined;
  const ratio = shotMedianUs / periodUs;
  let best: readonly [string, number] = ["1", 1];
  for (const candidate of MUSICAL_RATIOS)
    if (Math.abs(Math.log2(ratio / candidate[1])) < Math.abs(Math.log2(ratio / best[1])))
      best = candidate;
  return { periodUs, ratio, nearest: best[0], deviation: Math.log2(ratio / best[1]) };
}

export type CutsOnMusicBeat = Readonly<{
  hits: number;
  total: number;
  /** hits / total; 0 when there are no cuts. */
  fraction: number;
  toleranceUs: number;
}>;

/** How many `cutsUs` lie within `toleranceUs` of a music beat. */
export function cutsOnMusicBeat(
  cutsUs: readonly number[],
  musicBeatsUs: readonly number[],
  toleranceUs: number,
): CutsOnMusicBeat {
  const hits = cutsUs.filter((cut) => {
    const musicBeat = nearest(musicBeatsUs, cut);
    return musicBeat !== undefined && Math.abs(musicBeat - cut) <= toleranceUs + 1e-6;
  }).length;
  return {
    hits,
    total: cutsUs.length,
    fraction: cutsUs.length === 0 ? 0 : hits / cutsUs.length,
    toleranceUs,
  };
}

export function musicBeatToleranceUs(sequence: VideoSequenceV2): number {
  return Math.max(Math.round(frameDurationUs(sequence)), MIN_MUSIC_BEAT_TOLERANCE_US);
}

const seconds = (us: number): string => (us / 1_000_000).toFixed(2);
const milliseconds = (us: number): string => String(Math.round(us / 1_000));
const signed = (value: number): string => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;

function shotRange(shot: Shot, sequence: VideoSequenceV2): QcRange {
  return {
    startUs: frameToUs(shot.startFrame, sequence),
    endUs: frameToUs(shot.endFrame, sequence),
  };
}

function shotLengthFindings(shots: readonly Shot[], sequence: VideoSequenceV2): PacingDraft[] {
  const epsilonUs = frameDurationUs(sequence) / 2;
  const drafts: PacingDraft[] = [];
  for (const shot of shots) {
    const range = shotRange(shot, sequence);
    const lengthUs = range.endUs - range.startUs;
    if (lengthUs >= SHOT_MIN_US - epsilonUs && lengthUs <= SHOT_MAX_US + epsilonUs) continue;
    drafts.push({
      kind: "shot_length_out_of_range",
      severity: "info",
      subject: `shot:${String(shot.startFrame)}`,
      range,
      message: `Shot ${String(shot.index + 1)} is ${seconds(lengthUs)} s; shots usually run 1–7 s`,
    });
  }
  return drafts;
}

function steadyRunFindings(shots: readonly Shot[], sequence: VideoSequenceV2): PacingDraft[] {
  const frames = shots.map((shot) => shot.endFrame - shot.startFrame);
  const drafts: PacingDraft[] = [];
  for (let start = 0; start < frames.length;) {
    const base = frames[start] ?? 0;
    let end = start;
    while (end + 1 < frames.length && Math.abs((frames[end + 1] ?? 0) - base) <= 1) end += 1;
    const run = end - start + 1;
    const first = shots[start];
    const last = shots[end];
    if (run >= STEADY_SHOT_RUN && first !== undefined && last !== undefined) {
      drafts.push({
        kind: "steady_shot_run",
        severity: "info",
        subject: `shots:${String(first.startFrame)}`,
        range: {
          startUs: frameToUs(first.startFrame, sequence),
          endUs: frameToUs(last.endFrame, sequence),
        },
        message: `${String(run)} shots in a row of ${seconds(frameToUs(base, sequence))} s ±1 frame make a steady tick, not a rhythm`,
      });
    }
    start = end + 1;
  }
  return drafts;
}

function musicFindings(input: PacingInput, shots: readonly Shot[]): PacingDraft[] {
  const { sequence, musicBeatsUs } = input;
  const last = shots.at(-1);
  if (musicBeatsUs.length === 0 || last === undefined) return [];
  const toleranceUs = musicBeatToleranceUs(sequence);
  const cutsUs = shots.slice(1).map((shot) => frameToUs(shot.startFrame, sequence));
  const drafts: PacingDraft[] = [];
  for (const cutUs of cutsUs) {
    const musicBeat = nearest(musicBeatsUs, cutUs);
    if (musicBeat === undefined || Math.abs(musicBeat - cutUs) <= toleranceUs + 1e-6) continue;
    drafts.push({
      kind: "cut_off_music_beat",
      severity: "info",
      subject: `cut:${String(cutUs)}`,
      range: { startUs: cutUs, endUs: cutUs },
      message: `Cut at ${seconds(cutUs)} s is ${milliseconds(Math.abs(musicBeat - cutUs))} ms from the nearest music beat (on-beat within ${milliseconds(toleranceUs)} ms)`,
    });
  }
  const onBeat = cutsOnMusicBeat(cutsUs, musicBeatsUs, toleranceUs);
  const shotLengthsUs = shots.map((shot) => {
    const range = shotRange(shot, sequence);
    return range.endUs - range.startUs;
  });
  const pacing = musicBeatPacing(musicBeatsUs, median(shotLengthsUs));
  const percent = Math.round(onBeat.fraction * 100);
  const ratioText =
    pacing === undefined
      ? "shot/music beat ratio needs two music beats"
      : `music beat ${seconds(pacing.periodUs)} s, shot/music beat ${pacing.ratio.toFixed(2)} (≈${pacing.nearest}, deviation ${signed(pacing.deviation)})`;
  const detector =
    input.musicBeatsFromTempoFallback === true
      ? " (music beats from the in-app tempo fallback)"
      : "";
  drafts.push({
    kind: "music_fit",
    severity: "info",
    subject: "music-fit",
    range: { startUs: 0, endUs: frameToUs(last.endFrame, sequence) },
    message: `Cuts on music beat ${String(onBeat.hits)}/${String(onBeat.total)} (${String(percent)}%, ±${milliseconds(toleranceUs)} ms); ${ratioText}${detector}`,
  });
  return drafts;
}

/** Shot length, steady run and (with music beats) music fit findings. */
export function pacingFindings(input: PacingInput): PacingDraft[] {
  const shots = sequenceShots(input.sequence);
  return [
    ...shotLengthFindings(shots, input.sequence),
    ...steadyRunFindings(shots, input.sequence),
    ...musicFindings(input, shots),
  ];
}
