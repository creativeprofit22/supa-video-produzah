/**
 * Graphics clips: versioned, keyframed motion graphics stored on graphics tracks.
 * Mirrored by Rust `video/project/types.rs`; see docs/adr/0003-graphics-clips.md.
 */
import { z } from "zod";

import { easingSchema } from "./easing.js";
import { type VideoCommandError } from "./errors.js";
import { projectUuidSchema } from "./project.js";
import { renderCaptionFontKeySchema } from "./render-fonts.js";
import { rationalTimeSchema } from "./time.js";

export const GRAPHICS_CLIP_VERSION = 1;
export const MAX_GRAPHICS_LAYERS = 64;
export const MAX_GRAPHICS_KEYFRAMES = 256;
export const MAX_GRAPHICS_UNIT_KEYFRAMES = 16;
export const MAX_GRAPHICS_TEXT_CHARS = 500;
export const MAX_GRAPHICS_DURATION_FRAMES = 36_000;
export const MAX_GRAPHICS_CLIPS_PER_TRACK = 10_000;
/** Keyframes may sit past the clip end (they are never reached) but not beyond one hour. */
export const MAX_GRAPHICS_KEYFRAME_MICROSECONDS = 3_600_000_000;
export const MAX_GRAPHICS_LAYER_SIDE = 16_384;
export const MAX_GRAPHICS_POSITION = 32_768;
export const MAX_GRAPHICS_SCALE = 100;
export const MAX_GRAPHICS_ROTATION_DEGREES = 36_000;
export const MAX_GRAPHICS_FONT_SIZE = 1_000;

const finite = z.number().finite();

/** Inclusive value range of each keyframed property. */
export const GRAPHICS_PROPERTY_RANGES = {
  x: [-MAX_GRAPHICS_POSITION, MAX_GRAPHICS_POSITION],
  y: [-MAX_GRAPHICS_POSITION, MAX_GRAPHICS_POSITION],
  scale: [0, MAX_GRAPHICS_SCALE],
  rotation: [-MAX_GRAPHICS_ROTATION_DEGREES, MAX_GRAPHICS_ROTATION_DEGREES],
  opacity: [0, 1],
  offsetY: [-MAX_GRAPHICS_POSITION, MAX_GRAPHICS_POSITION],
} as const satisfies Record<string, readonly [number, number]>;
export type GraphicsProperty = keyof typeof GRAPHICS_PROPERTY_RANGES;

export const graphicsKeyframeSchema = z
  .object({
    /** Microseconds from the clip start. */
    timeMicroseconds: z.number().int().safe().min(0).max(MAX_GRAPHICS_KEYFRAME_MICROSECONDS),
    value: finite,
    /** Shapes the segment from this keyframe to the next; absent = linear. */
    easing: easingSchema.optional(),
  })
  .strict();
export type GraphicsKeyframe = z.infer<typeof graphicsKeyframeSchema>;

function keyframeTrackSchema(property: GraphicsProperty, maxKeyframes: number) {
  const [low, high] = GRAPHICS_PROPERTY_RANGES[property];
  return z
    .array(graphicsKeyframeSchema)
    .min(1)
    .max(maxKeyframes)
    .refine(
      (keys) =>
        keys.every(
          (key, index) =>
            index === 0 || key.timeMicroseconds > (keys[index - 1]?.timeMicroseconds ?? -1),
        ),
      "Keyframe times must strictly increase",
    )
    .refine(
      (keys) => keys.every((key) => key.value >= low && key.value <= high),
      `Keyframe values must be within ${String(low)}..${String(high)}`,
    );
}
export type GraphicsKeyframeTrack = GraphicsKeyframe[];

const layerTracks = {
  x: keyframeTrackSchema("x", MAX_GRAPHICS_KEYFRAMES),
  y: keyframeTrackSchema("y", MAX_GRAPHICS_KEYFRAMES),
  scale: keyframeTrackSchema("scale", MAX_GRAPHICS_KEYFRAMES),
  rotation: keyframeTrackSchema("rotation", MAX_GRAPHICS_KEYFRAMES),
  opacity: keyframeTrackSchema("opacity", MAX_GRAPHICS_KEYFRAMES),
};

const sideSchema = finite.positive().max(MAX_GRAPHICS_LAYER_SIDE);
const fillSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "Fill must be #RRGGBB");

/** Words are maximal runs of non-space characters (U+0020 separates); letters are non-space code points. */
export const graphicsTextSplitSchema = z.enum(["word", "letter"]);
export type GraphicsTextSplit = z.infer<typeof graphicsTextSplitSchema>;

export function splitGraphicsText(text: string, split: GraphicsTextSplit): string[] {
  return split === "word"
    ? text.split(" ").filter((word) => word.length > 0)
    : Array.from(text).filter((character) => character !== " ");
}

export const graphicsTextUnitsSchema = z
  .object({
    split: graphicsTextSplitSchema,
    /** One track per unit, multiplied with the layer opacity. */
    opacity: z
      .array(keyframeTrackSchema("opacity", MAX_GRAPHICS_UNIT_KEYFRAMES))
      .min(1)
      .max(MAX_GRAPHICS_TEXT_CHARS),
    /** One track per unit, added to the layer y in pixels. */
    offsetY: z
      .array(keyframeTrackSchema("offsetY", MAX_GRAPHICS_UNIT_KEYFRAMES))
      .min(1)
      .max(MAX_GRAPHICS_TEXT_CHARS),
  })
  .strict();
export type GraphicsTextUnits = z.infer<typeof graphicsTextUnitsSchema>;

/**
 * Geometry: `x`/`y` place the layer's top-left corner in sequence-canvas pixels (text: the
 * left end of the first line's box, `fontSize` tall). `scale` and `rotation` (degrees,
 * clockwise) apply around the layer's center.
 */
export const graphicsLayerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rect"),
      width: sideSchema,
      height: sideSchema,
      cornerRadius: finite.min(0).max(MAX_GRAPHICS_LAYER_SIDE / 2),
      fill: fillSchema,
      ...layerTracks,
    })
    .strict()
    .refine(
      (layer) => layer.cornerRadius <= Math.min(layer.width, layer.height) / 2,
      "Corner radius cannot exceed half the shorter side",
    ),
  z
    .object({
      kind: z.literal("text"),
      text: z
        .string()
        .min(1)
        .refine(
          (text) => Array.from(text).length <= MAX_GRAPHICS_TEXT_CHARS,
          `Text is limited to ${String(MAX_GRAPHICS_TEXT_CHARS)} characters`,
        )
        .refine((text) => !/\p{Cc}/u.test(text), "Text cannot contain control characters")
        .refine((text) => text.trim().length > 0, "Text cannot be blank"),
      fontSize: finite.min(1).max(MAX_GRAPHICS_FONT_SIZE),
      fill: fillSchema,
      units: graphicsTextUnitsSchema.optional(),
      ...layerTracks,
    })
    .strict()
    .superRefine((layer, context) => {
      if (layer.units === undefined) return;
      const count = splitGraphicsText(layer.text, layer.units.split).length;
      if (layer.units.opacity.length !== count || layer.units.offsetY.length !== count)
        context.addIssue({
          code: "custom",
          path: ["units"],
          message: `Text reveal needs exactly ${String(count)} unit tracks`,
        });
    }),
  z
    .object({
      kind: z.literal("image"),
      /** A still-image project asset (`probe.still === true`). */
      assetId: projectUuidSchema,
      width: sideSchema,
      height: sideSchema,
      ...layerTracks,
    })
    .strict(),
]);
export type GraphicsLayer = z.infer<typeof graphicsLayerSchema>;

export const graphicsLayersSchema = z.array(graphicsLayerSchema).max(MAX_GRAPHICS_LAYERS);

export const graphicsClipSchema = z
  .object({
    graphicsVersion: z.literal(GRAPHICS_CLIP_VERSION),
    id: projectUuidSchema,
    timelineStart: rationalTimeSchema,
    duration: rationalTimeSchema,
    fontKey: renderCaptionFontKeySchema,
    layers: graphicsLayersSchema,
  })
  .strict()
  .refine(
    (clip) =>
      clip.timelineStart.rateNumerator === clip.duration.rateNumerator &&
      clip.timelineStart.rateDenominator === clip.duration.rateDenominator,
    "Graphics clip start and duration must share a rate",
  )
  .refine(
    (clip) => clip.duration.value >= 1 && clip.duration.value <= MAX_GRAPHICS_DURATION_FRAMES,
    `Graphics clip duration must be 1..${String(MAX_GRAPHICS_DURATION_FRAMES)} frames`,
  );
export type GraphicsClip = z.infer<typeof graphicsClipSchema>;

export type GraphicsMigrationResult =
  | { readonly ok: true; readonly value: GraphicsClip }
  | { readonly ok: false; readonly error: VideoCommandError };

/**
 * Brings a stored graphics clip to the current entity version. Version 1 is current; any other
 * version fails with `unsupported_schema` so a newer file is never misread.
 */
export function migrateGraphicsClip(input: unknown): GraphicsMigrationResult {
  const version =
    typeof input === "object" && input !== null && "graphicsVersion" in input
      ? input.graphicsVersion
      : undefined;
  if (version !== GRAPHICS_CLIP_VERSION) {
    const supportedShape =
      typeof version === "number" && Number.isSafeInteger(version) && version > 0;
    return {
      ok: false,
      error: {
        code: supportedShape ? "unsupported_schema" : "invalid_project",
        message: supportedShape
          ? `Graphics clip version ${String(version)} is not supported by this version`
          : "Graphics clip graphicsVersion must be a positive safe integer",
        details: { graphicsVersion: version ?? null },
      },
    };
  }
  const parsed = graphicsClipSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: {
          code: "invalid_project",
          message: "Graphics clip failed strict validation",
          details: { issues: parsed.error.issues },
        },
      };
}

/** Clip end (exclusive) in sequence frames. */
export function graphicsClipEndFrame(clip: GraphicsClip): number {
  return clip.timelineStart.value + clip.duration.value;
}
