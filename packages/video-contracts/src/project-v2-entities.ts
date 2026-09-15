import { z } from "zod";

import { captionArtifactV1Schema } from "./caption.js";
import { clipSpeedSchema, clipTimelineDuration } from "./clip-timing.js";
import { projectUuidSchema, videoAssetSchema } from "./project.js";
import { rationalRateSchema, rationalTimeSchema } from "./time.js";

const nonBlankSchema = z.string().trim().min(1).max(512);
const safePositiveIntegerSchema = z.number().int().safe().positive();
const languageTagSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);

export const clipSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: projectUuidSchema }).strict(),
  z.object({ kind: z.literal("sequence"), sequenceId: projectUuidSchema }).strict(),
]);
/**
 * Canonical clip geometry composition: contain-fit the source into a canvas-sized RGBA
 * layer, scale around its center, rotate around that center, then translate by a canvas
 * width/height permille offset. Positive rotation is visually clockwise. The canvas clips
 * the result; opacity and audio are independent of geometry.
 */
export const clipTransformGeometrySchema = z
  .object({
    positionXPermille: z.number().int().safe().min(-1_000_000).max(1_000_000),
    positionYPermille: z.number().int().safe().min(-1_000_000).max(1_000_000),
    scaleXPermille: z.number().int().safe().positive().max(1_000_000),
    scaleYPermille: z.number().int().safe().positive().max(1_000_000),
    rotationMilliDegrees: z.number().int().safe().min(-360_000_000).max(360_000_000),
  })
  .strict();
export type ClipTransformGeometry = z.infer<typeof clipTransformGeometrySchema>;

export const DEFAULT_CLIP_TRANSFORM_GEOMETRY: ClipTransformGeometry = Object.freeze({
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
});

function formatThousandths(value: number): string {
  if (!Number.isSafeInteger(value))
    throw new RangeError("Fixed-point values must be safe integers");
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  return `${sign}${Math.floor(magnitude / 1_000)}.${(magnitude % 1_000).toString().padStart(3, "0")}`;
}

/** Formats a permille value as an exact decimal multiplier without floating-point rounding. */
export function formatPermilleDecimal(value: number): string {
  return formatThousandths(value);
}

/** Formats a canvas-relative permille offset as an exact CSS percentage. */
export function formatPermillePercentage(value: number): string {
  return `${formatThousandths(value * 100)}%`;
}

/** Formats milli-degrees as exact decimal degrees without floating-point rounding. */
export function formatMilliDegreesAsDegrees(value: number): string {
  return formatThousandths(value);
}

export const clipTransformSchema = clipTransformGeometrySchema
  .extend({
    opacityPermille: z.number().int().safe().min(0).max(1_000),
  })
  .strict();
export type ClipTransform = z.infer<typeof clipTransformSchema>;

export const clipFadesSchema = z.object({
  inFrames: z.number().int().safe().nonnegative(),
  outFrames: z.number().int().safe().nonnegative(),
}).strict();
export type ClipFades = z.infer<typeof clipFadesSchema>;

export const projectClipSchema = z
  .object({
    id: projectUuidSchema,
    source: clipSourceSchema,
    timelineStart: rationalTimeSchema,
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
    transform: clipTransformSchema,
    gainMilliDecibels: z.number().int().safe().min(-96_000).max(24_000),
    speed: clipSpeedSchema.optional(),
    fades: clipFadesSchema.optional(),
  })
  .strict()
  .refine(
    (clip) => clip.sourceOut.value > clip.sourceIn.value,
    "Clip source range must be nonempty",
  ).refine((clip) => {
    if (clip.fades === undefined) return true;
    try {
      const duration = clipTimelineDuration({ in: clip.sourceIn, out: clip.sourceOut }, { numerator: clip.timelineStart.rateNumerator, denominator: clip.timelineStart.rateDenominator }, clip.speed);
      return BigInt(clip.fades.inFrames) + BigInt(clip.fades.outFrames) <= BigInt(duration.value);
    } catch { return false; }
  }, "Audio fades exceed exact clip duration");
export type ProjectClip = z.infer<typeof projectClipSchema>;

export const projectMarkerSchema = z
  .object({
    id: projectUuidSchema,
    time: rationalTimeSchema,
    label: nonBlankSchema,
    color: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).optional(),
  })
  .strict();
export type ProjectMarker = z.infer<typeof projectMarkerSchema>;

export const projectCaptionSchema = z
  .object({
    id: projectUuidSchema,
    start: rationalTimeSchema,
    end: rationalTimeSchema,
    text: z.string().trim().min(1).max(16_384),
    language: languageTagSchema.optional(),
  })
  .strict()
  .refine((caption) => caption.end.value > caption.start.value, "Caption range must be nonempty");
export type ProjectCaption = z.infer<typeof projectCaptionSchema>;

const trackBase = { id: projectUuidSchema, name: nonBlankSchema, locked: z.boolean().optional() };
export const projectTrackSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...trackBase,
      kind: z.literal("video"),
      muted: z.boolean().optional(),
      hidden: z.boolean().optional(),
      clips: z.array(projectClipSchema).max(100_000),
    })
    .strict(),
  z
    .object({
      ...trackBase,
      kind: z.literal("audio"),
      muted: z.boolean().optional(),
      clips: z.array(projectClipSchema).max(100_000),
    })
    .strict(),
  z
    .object({
      ...trackBase,
      kind: z.literal("caption"),
      hidden: z.boolean().optional(),
      captions: z.array(projectCaptionSchema).max(100_000),
      activeCaptionArtifact: captionArtifactV1Schema.optional(),
    })
    .strict(),
]);
export type ProjectTrack = z.infer<typeof projectTrackSchema>;

/** Tracks persisted before locking was introduced are semantically unlocked. */
export function isTrackLocked(track: ProjectTrack): boolean {
  return track.locked ?? false;
}

/** Tracks persisted before muting was introduced are semantically audible. */
export function isTrackMuted(track: ProjectTrack): boolean {
  return track.kind === "caption" ? false : (track.muted ?? false);
}

/** Visual tracks persisted before visibility was introduced are semantically shown. */
export function isTrackHidden(track: ProjectTrack): boolean {
  return track.kind === "audio" ? false : (track.hidden ?? false);
}

export function canToggleTrackVisibility(track: ProjectTrack): boolean {
  return track.kind === "video" || track.kind === "caption";
}

export const videoSequenceV2Schema = z
  .object({
    id: projectUuidSchema,
    name: nonBlankSchema,
    rate: rationalRateSchema,
    width: safePositiveIntegerSchema
      .max(16_384)
      .refine((value) => value % 2 === 0, "Width must be even"),
    height: safePositiveIntegerSchema
      .max(16_384)
      .refine((value) => value % 2 === 0, "Height must be even"),
    audioSampleRate: safePositiveIntegerSchema.max(768_000),
    tracks: z.array(projectTrackSchema).max(10_000),
    markers: z.array(projectMarkerSchema).max(100_000),
  })
  .strict();
export type VideoSequenceV2 = z.infer<typeof videoSequenceV2Schema>;

export const videoProjectStateV2Schema = z
  .object({
    assets: z.array(videoAssetSchema).max(100_000),
    sequences: z.array(videoSequenceV2Schema).max(10_000),
    activeSequenceId: projectUuidSchema.nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const assetIds = new Set(state.assets.map((asset) => asset.id));
    const sequenceIds = new Set(state.sequences.map((sequence) => sequence.id));
    const assetsById = new Map(state.assets.map((asset) => [asset.id, asset]));
    const nestedIds = new Set<string>();
    for (const sequence of state.sequences)
      for (const track of sequence.tracks) {
        if (track.kind === "caption") continue;
        for (const clip of track.clips)
          if (clip.source.kind === "sequence") nestedIds.add(clip.source.sequenceId);
      }
    state.sequences.forEach((sequence, sequenceIndex) => {
      const managedSources = new Set(
        sequence.tracks.flatMap((track) => {
          if (track.kind !== "caption" || track.activeCaptionArtifact === undefined) return [];
          const identity = track.activeCaptionArtifact.sourceIdentity;
          return [`${identity.digest}:${identity.byteLength}`];
        }),
      );
      sequence.tracks.forEach((track, trackIndex) => {
        if (track.kind === "caption") {
          const artifact = track.activeCaptionArtifact;
          if (artifact !== undefined) {
            if (artifact.trackLink.sequenceId !== sequence.id) {
              context.addIssue({
                code: "custom",
                path: [
                  "sequences",
                  sequenceIndex,
                  "tracks",
                  trackIndex,
                  "activeCaptionArtifact",
                  "trackLink",
                  "sequenceId",
                ],
                message: "Active caption artifact sequence must match its containing sequence",
              });
            }
            if (artifact.trackLink.captionTrackId !== track.id) {
              context.addIssue({
                code: "custom",
                path: [
                  "sequences",
                  sequenceIndex,
                  "tracks",
                  trackIndex,
                  "activeCaptionArtifact",
                  "trackLink",
                  "captionTrackId",
                ],
                message: "Active caption artifact track must match its containing track",
              });
            }
            if (
              artifact.timelineRate.numerator !== sequence.rate.numerator ||
              artifact.timelineRate.denominator !== sequence.rate.denominator
            ) {
              context.addIssue({
                code: "custom",
                path: [
                  "sequences",
                  sequenceIndex,
                  "tracks",
                  trackIndex,
                  "activeCaptionArtifact",
                  "timelineRate",
                ],
                message: "Active caption artifact rate must match its containing sequence",
              });
            }
          }
          return;
        }
        track.clips.forEach((clip, clipIndex) => {
          if (clip.speed !== undefined && clip.speed.numerator !== clip.speed.denominator) {
            let reason: string | null = null;
            if (track.kind !== "video" || clip.source.kind !== "asset") {
              reason = "Speed requires a direct-asset video clip";
            } else if (nestedIds.has(sequence.id)) {
              reason = "Speed in referenced child sequences is unsupported";
            } else if (managedSources.size > 0) {
              const identity = assetsById.get(clip.source.assetId)?.contentIdentity;
              if (
                identity === undefined ||
                managedSources.has(`${identity.digest}:${identity.byteLength}`)
              ) {
                reason = "Speed with matching or unresolved managed captions is unsupported";
              }
            }
            try {
              clipTimelineDuration(
                { in: clip.sourceIn, out: clip.sourceOut },
                sequence.rate,
                clip.speed,
              );
            } catch {
              reason ??= "Speed requires a positive exact timeline duration";
            }
            if (reason !== null)
              context.addIssue({
                code: "custom",
                path: [
                  "sequences",
                  sequenceIndex,
                  "tracks",
                  trackIndex,
                  "clips",
                  clipIndex,
                  "speed",
                ],
                message: reason,
              });
          }
          const referenceExists =
            clip.source.kind === "asset"
              ? assetIds.has(clip.source.assetId)
              : sequenceIds.has(clip.source.sequenceId);
          if (!referenceExists) {
            context.addIssue({
              code: "custom",
              path: [
                "sequences",
                sequenceIndex,
                "tracks",
                trackIndex,
                "clips",
                clipIndex,
                "source",
                clip.source.kind === "asset" ? "assetId" : "sequenceId",
              ],
              message:
                clip.source.kind === "asset"
                  ? "Clip asset must resolve"
                  : "Nested sequence must resolve",
            });
          }
        });
      });
    });
    if (
      state.activeSequenceId === null
        ? state.sequences.length !== 0
        : !sequenceIds.has(state.activeSequenceId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeSequenceId"],
        message: "Active sequence must resolve, or be null only for an empty project",
      });
    }
    const edges = new Map(
      state.sequences.map((sequence) => [
        sequence.id,
        sequence.tracks.flatMap((track) =>
          track.kind === "caption"
            ? []
            : track.clips.flatMap((clip) =>
                clip.source.kind === "sequence" ? [clip.source.sequenceId] : [],
              ),
        ),
      ]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const cyclic = (edges.get(id) ?? []).some(hasCycle);
      visiting.delete(id);
      visited.add(id);
      return cyclic;
    };
    if (state.sequences.some((sequence) => hasCycle(sequence.id))) {
      context.addIssue({
        code: "custom",
        path: ["sequences"],
        message: "Nested sequences must be acyclic",
      });
    }
  });
export type VideoProjectStateV2 = z.infer<typeof videoProjectStateV2Schema>;
