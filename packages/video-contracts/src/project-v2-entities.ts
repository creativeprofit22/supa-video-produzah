import { z } from "zod";

import { captionArtifactV1Schema } from "./caption.js";
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
export const clipTransformSchema = z
  .object({
    positionXPermille: z.number().int().safe().min(-1_000_000).max(1_000_000),
    positionYPermille: z.number().int().safe().min(-1_000_000).max(1_000_000),
    scaleXPermille: z.number().int().safe().positive().max(1_000_000),
    scaleYPermille: z.number().int().safe().positive().max(1_000_000),
    rotationMilliDegrees: z.number().int().safe().min(-360_000_000).max(360_000_000),
    opacityPermille: z.number().int().safe().min(0).max(1_000),
  })
  .strict();
export type ClipTransform = z.infer<typeof clipTransformSchema>;

export const projectClipSchema = z
  .object({
    id: projectUuidSchema,
    source: clipSourceSchema,
    timelineStart: rationalTimeSchema,
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
    transform: clipTransformSchema,
    gainMilliDecibels: z.number().int().safe().min(-96_000).max(24_000),
  })
  .strict()
  .refine(
    (clip) => clip.sourceOut.value > clip.sourceIn.value,
    "Clip source range must be nonempty",
  );
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
    state.sequences.forEach((sequence, sequenceIndex) => {
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
