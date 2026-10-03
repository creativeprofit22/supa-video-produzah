/**
 * Snapping a graphics clip's keyframes to music beats in one step: the result
 * is exactly one `SetGraphicsClipLayers` command, so the change is a single
 * undoable history entry (the command is its own inverse).
 */
import {
  type GraphicsKeyframe,
  type GraphicsLayer,
  isTrackLocked,
  MAX_GRAPHICS_KEYFRAME_MICROSECONDS,
  type ProjectCommandV2,
  rationalTimeToMicroseconds,
  type VideoProjectStateV2,
} from "@supa-video/contracts";

import type { GraphicsClipRef } from "./apply-motion-preset.js";

export type SnapGraphicsToMusicBeatsError =
  | { readonly code: "unknown_graphics_clip"; readonly message: string }
  | { readonly code: "track_locked"; readonly message: string }
  | { readonly code: "invalid_tolerance"; readonly message: string }
  | { readonly code: "nothing_to_snap"; readonly message: string };

export type SnapGraphicsToMusicBeatsResult =
  | {
      readonly ok: true;
      readonly command: Extract<ProjectCommandV2, { type: "SetGraphicsClipLayers" }>;
      /** Keyframes that moved onto a music beat. */
      readonly snappedKeyframes: number;
    }
  | { readonly ok: false; readonly error: SnapGraphicsToMusicBeatsError };

/** Index of the first value `>= target` in an ascending array. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Nearest value to `target` (earlier on ties), or `null` if `values` is empty. */
function nearest(values: readonly number[], target: number): number | null {
  const index = lowerBound(values, target);
  const after = values[index];
  const before = values[index - 1];
  if (before === undefined) return after ?? null;
  if (after === undefined) return before;
  return target - before <= after - target ? before : after;
}

interface SnapContext {
  readonly musicBeatsUs: readonly number[];
  readonly clipStartUs: number;
  readonly clipEndUs: number;
  readonly toleranceUs: number;
  moved: number;
}

/**
 * Moves each keyframe to its nearest music beat within tolerance and inside
 * the clip. A key moves only if its new time stays strictly after the
 * previous key's (new) time and strictly before the next key's time, so keys
 * never reorder and two keys never merge; on a collision the key stays.
 */
function snapTrack(keys: readonly GraphicsKeyframe[], context: SnapContext): GraphicsKeyframe[] {
  const snapped: GraphicsKeyframe[] = [];
  keys.forEach((key, index) => {
    const previousUs = snapped.at(-1)?.timeMicroseconds ?? -1;
    const nextUs = keys[index + 1]?.timeMicroseconds ?? Number.POSITIVE_INFINITY;
    const absoluteUs = context.clipStartUs + key.timeMicroseconds;
    const musicBeatUs = nearest(context.musicBeatsUs, absoluteUs);
    const targetUs = musicBeatUs === null ? null : musicBeatUs - context.clipStartUs;
    if (
      musicBeatUs === null ||
      targetUs === null ||
      targetUs === key.timeMicroseconds ||
      Math.abs(musicBeatUs - absoluteUs) > context.toleranceUs ||
      musicBeatUs > context.clipEndUs ||
      targetUs < 0 ||
      targetUs > MAX_GRAPHICS_KEYFRAME_MICROSECONDS ||
      targetUs <= previousUs ||
      targetUs >= nextUs
    ) {
      snapped.push(key);
      return;
    }
    context.moved += 1;
    snapped.push({ ...key, timeMicroseconds: targetUs });
  });
  return snapped;
}

function snapLayer(layer: GraphicsLayer, context: SnapContext): GraphicsLayer {
  const tracks = {
    x: snapTrack(layer.x, context),
    y: snapTrack(layer.y, context),
    scale: snapTrack(layer.scale, context),
    rotation: snapTrack(layer.rotation, context),
    opacity: snapTrack(layer.opacity, context),
  };
  if (layer.kind !== "text" || layer.units === undefined) return { ...layer, ...tracks };
  return {
    ...layer,
    ...tracks,
    units: {
      ...layer.units,
      opacity: layer.units.opacity.map((track) => snapTrack(track, context)),
      offsetY: layer.units.offsetY.map((track) => snapTrack(track, context)),
    },
  };
}

/**
 * Snaps every keyframe of a graphics clip to the nearest music beat within
 * `toleranceUs`. `musicBeatTimelineUs` are sorted timeline microseconds (see
 * `musicBeatTimelineFrames` / `musicBeatFramesToMicroseconds`).
 */
export function snapGraphicsKeyframesToMusicBeats(
  state: VideoProjectStateV2,
  clip: GraphicsClipRef,
  musicBeatTimelineUs: readonly number[],
  toleranceUs: number,
  commandId: string,
): SnapGraphicsToMusicBeatsResult {
  if (!Number.isSafeInteger(toleranceUs) || toleranceUs < 0)
    return {
      ok: false,
      error: { code: "invalid_tolerance", message: "Tolerance must be whole microseconds" },
    };
  const sequence = state.sequences.find(({ id }) => id === clip.sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === clip.trackId);
  const target =
    track?.kind === "graphics"
      ? track.graphicsClips.find(({ id }) => id === clip.graphicsClipId)
      : undefined;
  if (track === undefined || target === undefined)
    return {
      ok: false,
      error: { code: "unknown_graphics_clip", message: "The graphics clip no longer exists" },
    };
  if (isTrackLocked(track))
    return {
      ok: false,
      error: { code: "track_locked", message: "Unlock the track to snap keyframes" },
    };
  const clipStartUs = rationalTimeToMicroseconds(target.timelineStart, "nearestTiesAwayFromZero");
  const clipEndUs = clipStartUs + rationalTimeToMicroseconds(target.duration, "floor");
  const context: SnapContext = {
    musicBeatsUs: [...musicBeatTimelineUs].sort((left, right) => left - right),
    clipStartUs,
    clipEndUs,
    toleranceUs,
    moved: 0,
  };
  const layers = target.layers.map((layer) => snapLayer(layer, context));
  if (context.moved === 0)
    return {
      ok: false,
      error: { code: "nothing_to_snap", message: "No keyframe is near a music beat" },
    };
  return {
    ok: true,
    snappedKeyframes: context.moved,
    command: {
      type: "SetGraphicsClipLayers",
      commandId,
      sequenceId: clip.sequenceId,
      trackId: clip.trackId,
      graphicsClipId: clip.graphicsClipId,
      fontKey: target.fontKey,
      layers,
    },
  };
}
