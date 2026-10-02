/**
 * Motion presets: named entrance motions (fitted from reference videos in diffusion-studio-2),
 * staggered entrances across layers, and per-word / per-letter text reveal. Each preset is a pure
 * function of the clip duration and the layer's bounds and rest pose, and returns layers ready
 * for one `SetGraphicsClipLayers` command. See docs/adr/0003-graphics-clips.md.
 */
import {
  type Easing,
  type GraphicsKeyframe,
  type GraphicsLayer,
  graphicsLayerSchema,
  type GraphicsTextSplit,
  splitGraphicsText,
} from "@supa-video/contracts";

import { MOTION_PRESET_DATA } from "./motion-presets.data.js";

export const MOTION_PRESET_NAMES = ["slam", "pop", "tiltIn", "cursorDrag", "rockSlide"] as const;
export type MotionPresetName = (typeof MOTION_PRESET_NAMES)[number];

const LAYER_PROPERTIES = ["x", "y", "scale", "rotation", "opacity"] as const;
type LayerProperty = (typeof LAYER_PROPERTIES)[number];

export interface MotionPresetKey {
  readonly timeMicroseconds: number;
  readonly value: number;
  readonly easing?: Easing;
}

export interface MotionPresetData {
  readonly source: string;
  readonly durationMicroseconds: number;
  readonly tracks: Partial<Record<LayerProperty, readonly MotionPresetKey[]>>;
}

export type MotionPresetErrorCode =
  "clip_too_short" | "no_layers" | "no_text_layer" | "invalid_option" | "invalid_result";

export interface MotionPresetError {
  readonly code: MotionPresetErrorCode;
  readonly message: string;
}

export type MotionPresetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MotionPresetError };

const fail = <T>(code: MotionPresetErrorCode, message: string): MotionPresetResult<T> => ({
  ok: false,
  error: { code, message },
});

/**
 * Text box estimate (0.55 em per character, one font size tall) used to size motion-preset
 * offsets. Export measures text with the real font and may shrink or wrap it to the safe area
 * (ADR 0003), so this estimate can differ from the drawn box.
 */
const TEXT_ADVANCE_EM = 0.55;

export interface LayerBounds {
  readonly width: number;
  readonly height: number;
}

export function graphicsLayerBounds(layer: GraphicsLayer): LayerBounds {
  if (layer.kind !== "text") return { width: layer.width, height: layer.height };
  const characters = Array.from(layer.text).length;
  return {
    width: Math.max(1, characters * TEXT_ADVANCE_EM * layer.fontSize),
    height: layer.fontSize,
  };
}

/** The value a track settles on (its last keyframe); presets animate into this rest pose. */
function restValue(track: readonly GraphicsKeyframe[], fallback: number): number {
  return track.at(-1)?.value ?? fallback;
}

const tidy = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * Integer times, strictly increasing, starting at `start` and stretched by `scale`. Returns null
 * when the keys cannot fit in `[0, clipDuration]`.
 */
function fitTimes(
  times: readonly number[],
  start: number,
  scale: number,
  clipDurationMicroseconds: number,
): number[] | null {
  const fitted: number[] = [];
  for (const time of times) {
    const previous = fitted.at(-1);
    const placed = start + Math.round(time * scale);
    fitted.push(previous === undefined ? placed : Math.max(placed, previous + 1));
  }
  return fitted.every((time) => time >= 0 && time <= clipDurationMicroseconds) ? fitted : null;
}

interface Placement {
  readonly startMicroseconds: number;
  /** ≤ 1: compresses the preset so it ends inside the clip. */
  readonly timeScale: number;
  readonly clipDurationMicroseconds: number;
}

function placePreset(
  layer: GraphicsLayer,
  name: MotionPresetName,
  placement: Placement,
): MotionPresetResult<GraphicsLayer> {
  const preset: MotionPresetData = MOTION_PRESET_DATA[name];
  const bounds = graphicsLayerBounds(layer);
  const rest = {
    x: restValue(layer.x, 0),
    y: restValue(layer.y, 0),
    scale: restValue(layer.scale, 1),
    rotation: restValue(layer.rotation, 0),
    opacity: restValue(layer.opacity, 1),
  };
  const valueOf: Record<LayerProperty, (value: number) => number> = {
    x: (value) => rest.x + value * bounds.width,
    y: (value) => rest.y + value * bounds.height,
    scale: (value) => rest.scale * value,
    rotation: (value) => rest.rotation + value,
    opacity: (value) => Math.min(1, Math.max(0, rest.opacity * value)),
  };
  const tracks: Partial<Record<LayerProperty, GraphicsKeyframe[]>> = {};
  for (const property of LAYER_PROPERTIES) {
    const source = preset.tracks[property] ?? [
      { timeMicroseconds: 0, value: property === "scale" || property === "opacity" ? 1 : 0 },
    ];
    const times = fitTimes(
      source.map((key) => key.timeMicroseconds),
      placement.startMicroseconds,
      placement.timeScale,
      placement.clipDurationMicroseconds,
    );
    if (times === null) return fail("clip_too_short", `${name} does not fit in the clip`);
    tracks[property] = source.map((key, index) => ({
      timeMicroseconds: times[index] ?? 0,
      value: tidy(valueOf[property](key.value)),
      ...(key.easing === undefined || index === source.length - 1 ? {} : { easing: key.easing }),
    }));
  }
  return validLayer({ ...layer, ...tracks });
}

function validLayer(candidate: unknown): MotionPresetResult<GraphicsLayer> {
  const parsed = graphicsLayerSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : fail("invalid_result", parsed.error.issues[0]?.message ?? "Preset produced an invalid layer");
}

function validDuration(clipDurationMicroseconds: number): boolean {
  return Number.isSafeInteger(clipDurationMicroseconds) && clipDurationMicroseconds >= 1;
}

export interface PresetFitOptions {
  readonly clipDurationMicroseconds: number;
}

/**
 * One layer animating into its rest pose with a named preset, starting at the clip start. The
 * preset plays at its natural speed and is compressed when the clip is shorter than it.
 */
export function applyPresetToLayer(
  layer: GraphicsLayer,
  name: MotionPresetName,
  { clipDurationMicroseconds }: PresetFitOptions,
): MotionPresetResult<GraphicsLayer> {
  if (!validDuration(clipDurationMicroseconds))
    return fail("invalid_option", "Clip duration must be a positive whole number of microseconds");
  const natural = MOTION_PRESET_DATA[name].durationMicroseconds;
  return placePreset(layer, name, {
    startMicroseconds: 0,
    timeScale: Math.min(1, clipDurationMicroseconds / natural),
    clipDurationMicroseconds,
  });
}

export interface StaggerOptions extends PresetFitOptions {
  /** Delay between consecutive layers' starts at natural speed. */
  readonly staggerMicroseconds: number;
}

/**
 * Every layer enters with the same preset, each `staggerMicroseconds` after the previous. When the
 * whole sequence is longer than the clip, stagger and motion are compressed by the same factor.
 */
export function staggeredEntrance(
  layers: readonly GraphicsLayer[],
  name: MotionPresetName,
  { clipDurationMicroseconds, staggerMicroseconds }: StaggerOptions,
): MotionPresetResult<GraphicsLayer[]> {
  if (layers.length === 0) return fail("no_layers", "Staggered entrance needs at least one layer");
  if (
    !validDuration(clipDurationMicroseconds) ||
    !Number.isSafeInteger(staggerMicroseconds) ||
    staggerMicroseconds < 0
  )
    return fail("invalid_option", "Durations must be whole, non-negative microseconds");
  const natural = MOTION_PRESET_DATA[name].durationMicroseconds;
  const total = (layers.length - 1) * staggerMicroseconds + natural;
  const timeScale = Math.min(1, clipDurationMicroseconds / total);
  const stagger = Math.floor(staggerMicroseconds * timeScale);
  const placed: GraphicsLayer[] = [];
  for (const [index, layer] of layers.entries()) {
    const result = placePreset(layer, name, {
      startMicroseconds: index * stagger,
      timeScale,
      clipDurationMicroseconds,
    });
    if (!result.ok) return result;
    placed.push(result.value);
  }
  return { ok: true, value: placed };
}

export interface TextRevealOptions extends PresetFitOptions {
  readonly split: GraphicsTextSplit;
  /** Fade-and-rise time of one unit at natural speed. */
  readonly unitDurationMicroseconds?: number;
  /** Delay between consecutive units at natural speed. */
  readonly staggerMicroseconds?: number;
  /** How far below rest each unit starts, in em. */
  readonly riseEm?: number;
}

export const TEXT_REVEAL_DEFAULTS = {
  unitDurationMicroseconds: 300_000,
  staggerMicroseconds: { word: 120_000, letter: 40_000 },
  riseEm: 0.5,
} as const;

const REVEAL_OPACITY_EASING: Easing = { kind: "preset", name: "easeOut" };
const REVEAL_RISE_EASING: Easing = { kind: "preset", name: "snappy" };

/**
 * Splits a text layer into words or letters that fade in and rise into place one after another.
 * Stagger and unit motion are compressed together when the reveal is longer than the clip.
 */
export function textReveal(
  layer: GraphicsLayer,
  options: TextRevealOptions,
): MotionPresetResult<GraphicsLayer> {
  if (layer.kind !== "text") return fail("no_text_layer", "Text reveal needs a text layer");
  const unitDuration =
    options.unitDurationMicroseconds ?? TEXT_REVEAL_DEFAULTS.unitDurationMicroseconds;
  const staggerOption =
    options.staggerMicroseconds ?? TEXT_REVEAL_DEFAULTS.staggerMicroseconds[options.split];
  const riseEm = options.riseEm ?? TEXT_REVEAL_DEFAULTS.riseEm;
  if (
    !validDuration(options.clipDurationMicroseconds) ||
    !Number.isSafeInteger(unitDuration) ||
    unitDuration < 1 ||
    !Number.isSafeInteger(staggerOption) ||
    staggerOption < 0 ||
    !Number.isFinite(riseEm)
  )
    return fail("invalid_option", "Reveal timings must be whole microseconds and the rise finite");
  const units = splitGraphicsText(layer.text, options.split);
  const total = (units.length - 1) * staggerOption + unitDuration;
  const timeScale = Math.min(1, options.clipDurationMicroseconds / total);
  const stagger = Math.floor(staggerOption * timeScale);
  const duration = Math.max(1, Math.floor(unitDuration * timeScale));
  const rise = tidy(riseEm * layer.fontSize);
  const opacity: GraphicsKeyframe[][] = [];
  const offsetY: GraphicsKeyframe[][] = [];
  for (const index of units.keys()) {
    const start = Math.min(index * stagger, options.clipDurationMicroseconds - duration);
    if (start < 0) return fail("clip_too_short", "Text reveal does not fit in the clip");
    const end = start + duration;
    opacity.push([
      { timeMicroseconds: start, value: 0, easing: REVEAL_OPACITY_EASING },
      { timeMicroseconds: end, value: 1 },
    ]);
    offsetY.push([
      { timeMicroseconds: start, value: rise, easing: REVEAL_RISE_EASING },
      { timeMicroseconds: end, value: 0 },
    ]);
  }
  return validLayer({ ...layer, units: { split: options.split, opacity, offsetY } });
}
