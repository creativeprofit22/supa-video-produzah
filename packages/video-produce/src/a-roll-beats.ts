import type { RationalTime, VideoProjectStateV2 } from "@supa-video/contracts";
import { isMediaTrack } from "@supa-video/contracts";

import type { NarrativeBeat } from "./narrative-beat.js";
import {
  type TranscriptWordInput,
  planBeatsFromTranscript,
  rematerializeBeats,
} from "./plan-beats.js";
import type { Result } from "./result.js";

/*
 * Podcast beats for the A-roll clips in a project: finds the clips, converts
 * their rational timing to microseconds and plans sentence beats from each
 * clip's transcript words. Speed-changed clips are refused because transcript
 * source times would no longer map one-to-one onto the timeline. Transcript
 * edits split the A-roll into several clips of one asset; those are planned
 * clip by clip and joined into one contiguous plan.
 */

export type ARollBeatError =
  | { readonly code: "no-clips" }
  | { readonly code: "clip-not-found" }
  | { readonly code: "clip-not-asset" }
  | { readonly code: "clip-speed-changed" }
  | { readonly code: "clips-mixed-assets" }
  | { readonly code: "clips-not-contiguous"; readonly clipId: string }
  | { readonly code: "beats"; readonly reason: string };

/** Microsecond rounding of three rational times can drift by this much. */
const CONTIGUITY_TOLERANCE_US = 2;

function toMicroseconds(time: RationalTime): number {
  return Math.round((time.value * 1_000_000 * time.rateDenominator) / time.rateNumerator);
}

interface ResolvedClip {
  readonly clipId: string;
  readonly assetId: string;
  readonly timelineStartUs: number;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

function resolveClip(
  state: VideoProjectStateV2,
  clipId: string,
): Result<ResolvedClip, ARollBeatError> {
  const sequence = state.sequences.find((item) => item.id === state.activeSequenceId);
  const clip = sequence?.tracks
    .flatMap((track) => (isMediaTrack(track) ? track.clips : []))
    .find((item) => item.id === clipId);
  if (clip === undefined) return { ok: false, error: { code: "clip-not-found" } };
  if (clip.source.kind !== "asset") return { ok: false, error: { code: "clip-not-asset" } };
  if (clip.speed !== undefined && clip.speed.numerator !== clip.speed.denominator) {
    return { ok: false, error: { code: "clip-speed-changed" } };
  }
  return {
    ok: true,
    value: {
      clipId,
      assetId: clip.source.assetId,
      timelineStartUs: toMicroseconds(clip.timelineStart),
      sourceInUs: toMicroseconds(clip.sourceIn),
      sourceOutUs: toMicroseconds(clip.sourceOut),
    },
  };
}

function planResolved(
  clip: ResolvedClip,
  words: readonly TranscriptWordInput[],
  language: string,
): Result<NarrativeBeat[], ARollBeatError> {
  const result = planBeatsFromTranscript(words, clip, { language });
  return result.ok ? result : { ok: false, error: { code: "beats", reason: result.error.code } };
}

export function planBeatsForARollClip(
  state: VideoProjectStateV2,
  clipId: string,
  words: readonly TranscriptWordInput[],
  language: string,
): Result<NarrativeBeat[], ARollBeatError> {
  const clip = resolveClip(state, clipId);
  return clip.ok ? planResolved(clip.value, words, language) : clip;
}

/**
 * Plans every A-roll clip of one asset as one contiguous beat plan ordered by
 * timeline start. Each beat's a-roll intent names the clip it came from.
 * Clips separated by a timeline gap or overlap are refused with
 * `clips-not-contiguous` because a first cut must cover one unbroken range.
 */
export function planBeatsForARollClips(
  state: VideoProjectStateV2,
  clipIds: readonly string[],
  words: readonly TranscriptWordInput[],
  language: string,
): Result<NarrativeBeat[], ARollBeatError> {
  const resolved: ResolvedClip[] = [];
  for (const clipId of new Set(clipIds)) {
    const clip = resolveClip(state, clipId);
    if (!clip.ok) return clip;
    resolved.push(clip.value);
  }
  const first = resolved[0];
  if (first === undefined) return { ok: false, error: { code: "no-clips" } };
  if (resolved.some((clip) => clip.assetId !== first.assetId)) {
    return { ok: false, error: { code: "clips-mixed-assets" } };
  }
  if (resolved.length === 1) return planResolved(first, words, language);

  const ordered = resolved.sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs || (left.clipId < right.clipId ? -1 : 1),
  );
  const beats: NarrativeBeat[] = [];
  let previousEndUs: number | null = null;
  for (const clip of ordered) {
    if (
      previousEndUs !== null &&
      Math.abs(clip.timelineStartUs - previousEndUs) > CONTIGUITY_TOLERANCE_US
    ) {
      return { ok: false, error: { code: "clips-not-contiguous", clipId: clip.clipId } };
    }
    const planned = planResolved(clip, words, language);
    if (!planned.ok) return planned;
    beats.push(...planned.value);
    previousEndUs = clip.timelineStartUs + clip.sourceOutUs - clip.sourceInUs;
  }
  const joined = rematerializeBeats(beats, language);
  return joined.ok ? joined : { ok: false, error: { code: "beats", reason: joined.error.code } };
}
