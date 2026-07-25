import { z } from "zod";

import {
  compareRationalTimes,
  rationalRateSchema,
  rationalTimeSchema,
  rateOf,
  ratesEqual,
} from "./time.js";

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const safePositiveIntegerSchema = z.number().int().safe().positive();
const nonBlankSchema = z.string().trim().min(1).max(512);
const pathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"), {
    message: "Paths cannot contain NUL characters",
  });

function isSafeRelativePath(path: string): boolean {
  if (/^[a-zA-Z]:/.test(path) || /^[\\/]/.test(path)) {
    return false;
  }
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment !== ".." && segment !== "");
}

function isRecognizableAbsolutePath(path: string): boolean {
  const driveRooted = /^[a-zA-Z]:[\\/]/.test(path);
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(path);
  const posixRooted = path.startsWith("/");
  return driveRooted || unc || posixRooted;
}

export const assetLocatorSchema = z
  .object({
    relativePath: pathSchema
      .refine(isSafeRelativePath, "Project-relative path cannot escape")
      .optional(),
    absolutePath: pathSchema
      .refine(isRecognizableAbsolutePath, "Fallback path must be absolute")
      .optional(),
  })
  .strict()
  .refine((locator) => locator.relativePath !== undefined || locator.absolutePath !== undefined, {
    message: "A source locator requires a project-relative path or absolute fallback",
  });

export type AssetLocator = z.infer<typeof assetLocatorSchema>;

export const mediaAudioShapeSchema = z
  .object({
    codecName: nonBlankSchema,
    channels: safePositiveIntegerSchema.max(64),
    sampleRate: safePositiveIntegerSchema.max(768_000),
  })
  .strict();

export const mediaProbeSchema = z
  .object({
    durationMicroseconds: safePositiveIntegerSchema,
    averageFrameRate: rationalRateSchema,
    realFrameRate: rationalRateSchema,
    variableFrameRate: z.boolean(),
    width: safePositiveIntegerSchema,
    height: safePositiveIntegerSchema,
    videoCodecName: nonBlankSchema,
    audio: mediaAudioShapeSchema.nullable(),
    fileSizeBytes: safePositiveIntegerSchema,
  })
  .strict();

export type MediaProbe = z.infer<typeof mediaProbeSchema>;

export const videoAssetSchema = z
  .object({
    id: uuidSchema,
    displayName: nonBlankSchema,
    locator: assetLocatorSchema,
    probe: mediaProbeSchema,
  })
  .strict();

export type VideoAsset = z.infer<typeof videoAssetSchema>;

export const videoClipSchema = z
  .object({
    id: uuidSchema,
    assetId: uuidSchema,
    timelineStart: rationalTimeSchema,
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
  })
  .strict()
  .superRefine((clip, context) => {
    const timelineRate = rateOf(clip.timelineStart);
    if (clip.timelineStart.value !== 0) {
      context.addIssue({
        code: "custom",
        message: "Phase 1 clips must start at timeline frame zero",
      });
    }
    if (
      !ratesEqual(timelineRate, rateOf(clip.sourceIn)) ||
      !ratesEqual(timelineRate, rateOf(clip.sourceOut))
    ) {
      context.addIssue({ code: "custom", message: "Clip times must use one exact rate" });
      return;
    }
    if (compareRationalTimes(clip.sourceIn, clip.sourceOut) >= 0) {
      context.addIssue({
        code: "custom",
        message: "Clip source range must contain at least one frame",
      });
    }
  });

export type VideoClip = z.infer<typeof videoClipSchema>;

export const videoTrackSchema = z
  .object({
    id: uuidSchema,
    clips: z.array(videoClipSchema).max(1),
  })
  .strict();

export type VideoTrack = z.infer<typeof videoTrackSchema>;

export const videoSequenceSchema = z
  .object({
    id: uuidSchema,
    rate: rationalRateSchema,
    width: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Width must be even"),
    height: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Height must be even"),
    audioSampleRate: z.literal(48_000),
    videoTracks: z.tuple([videoTrackSchema]),
  })
  .strict()
  .superRefine((sequence, context) => {
    for (const clip of sequence.videoTracks[0].clips) {
      if (!ratesEqual(sequence.rate, rateOf(clip.timelineStart))) {
        context.addIssue({ code: "custom", message: "Sequence and clip rates must match" });
      }
    }
  });

export type VideoSequence = z.infer<typeof videoSequenceSchema>;

export const videoProjectStateSchema = z
  .object({
    asset: videoAssetSchema.nullable(),
    sequence: videoSequenceSchema.nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const clips = state.sequence?.videoTracks[0].clips ?? [];
    if (clips.length > 0 && state.asset === null) {
      context.addIssue({ code: "custom", message: "A clip requires the project asset" });
    }
    if (state.asset !== null && clips.some((clip) => clip.assetId !== state.asset?.id)) {
      context.addIssue({
        code: "custom",
        message: "Clip asset identity must match the project asset",
      });
    }
  });

export type VideoProjectState = z.infer<typeof videoProjectStateSchema>;

export const projectRevisionSchema = z
  .object({
    id: uuidSchema,
    parentRevisionId: uuidSchema.nullable(),
    sequenceNumber: safeNonNegativeIntegerSchema,
    committedAt: dateTimeSchema,
    commandSummary: nonBlankSchema,
    state: videoProjectStateSchema,
  })
  .strict();

export type ProjectRevision = z.infer<typeof projectRevisionSchema>;

export const videoProjectFileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuidSchema,
    name: nonBlankSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    currentRevisionId: uuidSchema,
    revisions: z.array(projectRevisionSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((document, context) => {
    if (!document.revisions.some((revision) => revision.id === document.currentRevisionId)) {
      context.addIssue({
        code: "custom",
        message: "Current revision must exist in the revision list",
      });
    }
    if (Date.parse(document.updatedAt) < Date.parse(document.createdAt)) {
      context.addIssue({ code: "custom", message: "Project update time cannot precede creation" });
    }
    const ids = new Set<string>();
    for (const [index, revision] of document.revisions.entries()) {
      if (ids.has(revision.id)) {
        context.addIssue({ code: "custom", message: "Revision IDs must be unique" });
      }
      ids.add(revision.id);
      if (revision.sequenceNumber !== index) {
        context.addIssue({
          code: "custom",
          message: "Revision sequence numbers must be contiguous",
        });
      }
      const expectedParent = index === 0 ? null : document.revisions[index - 1]?.id;
      if (revision.parentRevisionId !== expectedParent) {
        context.addIssue({ code: "custom", message: "Revisions must form one linear history" });
      }
    }
  });

export type VideoProjectFileV1 = z.infer<typeof videoProjectFileV1Schema>;
export type VideoProjectFile = VideoProjectFileV1;
