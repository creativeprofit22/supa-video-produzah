import { NORMAL_CLIP_SPEED } from "./clip-timing.js";
import type { ProjectClip, VideoSequenceV2 } from "./project-v2-entities.js";
import { rationalTimeToMicroseconds } from "./time.js";

/**
 * The music beat times of one music asset, in integer source-time
 * microseconds. Structurally the `beatsUs` of a music beat analysis; it is
 * never a narrative beat (see CONTEXT.md).
 */
export interface MusicBeatSourceTimes {
  readonly beatsUs: readonly number[];
}

/** Upper bound on music beat frames returned for one sequence. */
export const MAX_MUSIC_BEAT_TIMELINE_FRAMES = 100_000;

/** One music beat on the timeline and the music clip it comes from. */
export interface MusicBeatTimelineTarget {
  readonly frame: number;
  readonly clipId: string;
}

function clipMusicBeatFrames(
  clip: ProjectClip,
  sequence: VideoSequenceV2,
  beatsUs: readonly number[],
  out: MusicBeatTimelineTarget[],
): void {
  const sourceInUs = rationalTimeToMicroseconds(clip.sourceIn, "ceil");
  const sourceOutUs = rationalTimeToMicroseconds(clip.sourceOut, "floor");
  const speed = clip.speed ?? NORMAL_CLIP_SPEED;
  const rate = sequence.rate;
  // timeline offset = source offset / speed; frame = µs × rate / 1e6.
  const toFrameNumerator = BigInt(speed.denominator) * BigInt(rate.numerator);
  const toFrameDenominator = BigInt(speed.numerator) * BigInt(rate.denominator) * 1_000_000n;
  const clipDurationFrames =
    (BigInt(sourceOutUs - sourceInUs) * toFrameNumerator) / toFrameDenominator;
  for (const beatUs of beatsUs) {
    if (beatUs < sourceInUs) continue;
    if (beatUs >= sourceOutUs) break;
    // Round half up to the nearest timeline frame.
    const offsetFrames =
      (BigInt(beatUs - sourceInUs) * toFrameNumerator * 2n + toFrameDenominator) /
      (toFrameDenominator * 2n);
    if (offsetFrames >= clipDurationFrames) continue;
    out.push({ frame: clip.timelineStart.value + Number(offsetFrames), clipId: clip.id });
    if (out.length >= MAX_MUSIC_BEAT_TIMELINE_FRAMES) return;
  }
}

/**
 * Maps music beats of music assets into timeline frames of `sequence`, sorted
 * by frame then clip id. Only clips on unmuted audio tracks with audio role
 * `music` contribute; trims (`sourceIn`/`sourceOut`) and clip speed are
 * applied, and music beats outside the trimmed range are dropped. Each target
 * keeps its clip id so a dragged music clip does not snap to its own beats.
 */
export function musicBeatTimelineTargets(
  sequence: VideoSequenceV2,
  analysesByAssetId: ReadonlyMap<string, MusicBeatSourceTimes>,
): readonly MusicBeatTimelineTarget[] {
  const targets: MusicBeatTimelineTarget[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "audio" || track.audioRole !== "music" || track.muted === true) continue;
    for (const clip of track.clips) {
      if (clip.source.kind !== "asset") continue;
      const analysis = analysesByAssetId.get(clip.source.assetId);
      if (analysis === undefined || analysis.beatsUs.length === 0) continue;
      clipMusicBeatFrames(clip, sequence, analysis.beatsUs, targets);
    }
  }
  targets.sort((left, right) =>
    left.frame === right.frame
      ? left.clipId < right.clipId
        ? -1
        : left.clipId > right.clipId
          ? 1
          : 0
      : left.frame - right.frame,
  );
  return targets.slice(0, MAX_MUSIC_BEAT_TIMELINE_FRAMES);
}

/** Sorted, de-duplicated timeline frames of {@link musicBeatTimelineTargets}. */
export function musicBeatTimelineFrames(
  sequence: VideoSequenceV2,
  analysesByAssetId: ReadonlyMap<string, MusicBeatSourceTimes>,
): readonly number[] {
  const unique: number[] = [];
  for (const { frame } of musicBeatTimelineTargets(sequence, analysesByAssetId)) {
    if (unique.at(-1) !== frame) unique.push(frame);
  }
  return unique;
}

/** Timeline frames to timeline microseconds (nearest), for QC input. */
export function musicBeatFramesToMicroseconds(
  frames: readonly number[],
  sequence: VideoSequenceV2,
): readonly number[] {
  const { numerator, denominator } = sequence.rate;
  return frames.map((frame) =>
    Number(
      (BigInt(frame) * BigInt(denominator) * 2_000_000n + BigInt(numerator)) /
        (BigInt(numerator) * 2n),
    ),
  );
}
