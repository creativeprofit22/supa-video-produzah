/**
 * Applying a motion preset to a graphics clip in one step: the result is exactly one
 * `SetGraphicsClipLayers` command, so the change is a single undoable history entry.
 */
import {
  type GraphicsLayer,
  type GraphicsTextSplit,
  isTrackLocked,
  type ProjectCommandV2,
  type VideoProjectStateV2,
} from "@supa-video/contracts";

import {
  applyPresetToLayer,
  type MotionPresetError,
  type MotionPresetName,
  type MotionPresetResult,
  staggeredEntrance,
  textReveal,
} from "./motion-presets.js";

export interface GraphicsClipRef {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly graphicsClipId: string;
}

export type GraphicsPresetRequest =
  /** Every layer (or one, by index) enters with the named preset at the clip start. */
  | { readonly kind: "entrance"; readonly name: MotionPresetName; readonly layerIndex?: number }
  /** Layers enter one after another in stacking order. */
  | {
      readonly kind: "staggeredEntrance";
      readonly name: MotionPresetName;
      readonly staggerMicroseconds: number;
    }
  /** A text layer (the first one unless indexed) reveals word by word or letter by letter. */
  | {
      readonly kind: "textReveal";
      readonly split: GraphicsTextSplit;
      readonly layerIndex?: number;
    };

export type ApplyMotionPresetError =
  | { readonly code: "unknown_graphics_clip"; readonly message: string }
  | { readonly code: "track_locked"; readonly message: string }
  | {
      readonly code: "preset_does_not_fit";
      readonly message: string;
      readonly cause: MotionPresetError;
    };

export type ApplyMotionPresetResult =
  | {
      readonly ok: true;
      readonly command: Extract<ProjectCommandV2, { type: "SetGraphicsClipLayers" }>;
    }
  | { readonly ok: false; readonly error: ApplyMotionPresetError };

function replaceAt(
  layers: readonly GraphicsLayer[],
  index: number,
  apply: (layer: GraphicsLayer) => MotionPresetResult<GraphicsLayer>,
): MotionPresetResult<GraphicsLayer[]> {
  const layer = layers[index];
  if (layer === undefined)
    return {
      ok: false,
      error: { code: "invalid_option", message: `No layer at index ${String(index)}` },
    };
  const result = apply(layer);
  if (!result.ok) return result;
  return {
    ok: true,
    value: layers.map((item, itemIndex) => (itemIndex === index ? result.value : item)),
  };
}

function presetLayers(
  layers: readonly GraphicsLayer[],
  request: GraphicsPresetRequest,
  clipDurationMicroseconds: number,
): MotionPresetResult<GraphicsLayer[]> {
  const fit = { clipDurationMicroseconds };
  switch (request.kind) {
    case "entrance": {
      if (request.layerIndex !== undefined)
        return replaceAt(layers, request.layerIndex, (layer) =>
          applyPresetToLayer(layer, request.name, fit),
        );
      if (layers.length === 0)
        return { ok: false, error: { code: "no_layers", message: "The clip has no layers" } };
      return staggeredEntrance(layers, request.name, { ...fit, staggerMicroseconds: 0 });
    }
    case "staggeredEntrance":
      return staggeredEntrance(layers, request.name, {
        ...fit,
        staggerMicroseconds: request.staggerMicroseconds,
      });
    case "textReveal": {
      const index = request.layerIndex ?? layers.findIndex((layer) => layer.kind === "text");
      if (index < 0)
        return {
          ok: false,
          error: { code: "no_text_layer", message: "The clip has no text layer" },
        };
      return replaceAt(layers, index, (layer) =>
        textReveal(layer, { ...fit, split: request.split }),
      );
    }
  }
}

/** Builds the one command that applies `request` to the referenced clip; nothing is executed. */
export function applyMotionPreset(
  state: VideoProjectStateV2,
  clip: GraphicsClipRef,
  request: GraphicsPresetRequest,
  commandId: string,
): ApplyMotionPresetResult {
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
      error: { code: "track_locked", message: "Unlock the track to apply a preset" },
    };
  const clipDurationMicroseconds = Math.floor(
    (target.duration.value * 1_000_000 * target.duration.rateDenominator) /
      target.duration.rateNumerator,
  );
  const layers = presetLayers(target.layers, request, clipDurationMicroseconds);
  if (!layers.ok)
    return {
      ok: false,
      error: { code: "preset_does_not_fit", message: layers.error.message, cause: layers.error },
    };
  return {
    ok: true,
    command: {
      type: "SetGraphicsClipLayers",
      commandId,
      sequenceId: clip.sequenceId,
      trackId: clip.trackId,
      graphicsClipId: clip.graphicsClipId,
      fontKey: target.fontKey,
      layers: layers.value,
    },
  };
}
