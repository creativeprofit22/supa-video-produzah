import { z } from "zod";

import {
  clipTransformSchema,
  projectCaptionSchema,
  projectClipSchema,
  projectMarkerSchema,
  projectTrackSchema,
  videoSequenceV2Schema,
} from "./project-v2-entities.js";
import {
  assetLocatorSchema,
  mediaProbeSchema,
  projectUuidSchema,
  videoAssetSchema,
} from "./project.js";
import { mediaContentIdentityV1Schema } from "./source-content.js";
import { rationalTimeSchema } from "./time.js";

const commandId = { commandId: projectUuidSchema };
const target = { sequenceId: projectUuidSchema, trackId: projectUuidSchema };
const insertionIndex = z.number().int().safe().nonnegative().optional();

export const importAssetCommandSchemaV2 = z
  .object({
    type: z.literal("ImportAsset"),
    ...commandId,
    index: insertionIndex,
    asset: videoAssetSchema,
  })
  .strict();
export const createSequenceCommandSchemaV2 = z
  .object({
    type: z.literal("CreateSequence"),
    ...commandId,
    index: insertionIndex,
    activeSequenceId: projectUuidSchema.optional(),
    sequence: videoSequenceV2Schema,
  })
  .strict();
export const removeSequenceCommandSchemaV2 = z
  .object({
    type: z.literal("RemoveSequence"),
    ...commandId,
    sequenceId: projectUuidSchema,
    activeSequenceId: projectUuidSchema.optional(),
  })
  .strict();
export const insertTrackCommandSchemaV2 = z
  .object({
    type: z.literal("InsertTrack"),
    ...commandId,
    sequenceId: projectUuidSchema,
    index: z.number().int().safe().nonnegative(),
    track: projectTrackSchema,
  })
  .strict();
export const removeTrackCommandSchemaV2 = z
  .object({
    type: z.literal("RemoveTrack"),
    ...commandId,
    sequenceId: projectUuidSchema,
    trackId: projectUuidSchema,
  })
  .strict();
export const insertClipCommandSchemaV2 = z
  .object({
    type: z.literal("InsertClip"),
    ...commandId,
    ...target,
    index: insertionIndex,
    clip: projectClipSchema,
  })
  .strict();
export const removeClipCommandSchemaV2 = z
  .object({ type: z.literal("RemoveClip"), ...commandId, ...target, clipId: projectUuidSchema })
  .strict();
export const splitClipCommandSchemaV2 = z
  .object({
    type: z.literal("SplitClip"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    splitAt: rationalTimeSchema,
    rightClipId: projectUuidSchema,
  })
  .strict();
export const moveClipCommandSchemaV2 = z
  .object({
    type: z.literal("MoveClip"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    timelineStart: rationalTimeSchema,
  })
  .strict();
export const trimClipCommandSchemaV2 = z
  .object({
    type: z.literal("TrimClip"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
  })
  .strict();
export const setClipTransformCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipTransform"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    transform: clipTransformSchema,
  })
  .strict();
export const setClipGainCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipGain"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    gainMilliDecibels: z.number().int().safe().min(-96_000).max(24_000),
  })
  .strict();
export const addMarkerCommandSchemaV2 = z
  .object({
    type: z.literal("AddMarker"),
    ...commandId,
    sequenceId: projectUuidSchema,
    index: insertionIndex,
    marker: projectMarkerSchema,
  })
  .strict();
export const removeMarkerCommandSchemaV2 = z
  .object({
    type: z.literal("RemoveMarker"),
    ...commandId,
    sequenceId: projectUuidSchema,
    markerId: projectUuidSchema,
  })
  .strict();
export const addCaptionCommandSchemaV2 = z
  .object({
    type: z.literal("AddCaption"),
    ...commandId,
    ...target,
    index: insertionIndex,
    caption: projectCaptionSchema,
  })
  .strict();
export const removeCaptionCommandSchemaV2 = z
  .object({
    type: z.literal("RemoveCaption"),
    ...commandId,
    ...target,
    captionId: projectUuidSchema,
  })
  .strict();
export const relinkAssetCommandSchemaV2 = z
  .object({
    type: z.literal("RelinkAsset"),
    ...commandId,
    assetId: projectUuidSchema,
    locator: assetLocatorSchema,
    probe: mediaProbeSchema,
    contentIdentity: mediaContentIdentityV1Schema.optional(),
  })
  .strict();
export const removeAssetCommandSchemaV2 = z
  .object({ type: z.literal("RemoveAsset"), ...commandId, assetId: projectUuidSchema })
  .strict();

export const projectCommandSchemaV2 = z.discriminatedUnion("type", [
  importAssetCommandSchemaV2,
  createSequenceCommandSchemaV2,
  removeSequenceCommandSchemaV2,
  insertTrackCommandSchemaV2,
  removeTrackCommandSchemaV2,
  insertClipCommandSchemaV2,
  removeClipCommandSchemaV2,
  splitClipCommandSchemaV2,
  moveClipCommandSchemaV2,
  trimClipCommandSchemaV2,
  setClipTransformCommandSchemaV2,
  setClipGainCommandSchemaV2,
  addMarkerCommandSchemaV2,
  removeMarkerCommandSchemaV2,
  addCaptionCommandSchemaV2,
  removeCaptionCommandSchemaV2,
  relinkAssetCommandSchemaV2,
  removeAssetCommandSchemaV2,
]);
export type ProjectCommandV2 = z.infer<typeof projectCommandSchemaV2>;

export const commandGroupRequestSchema = z
  .object({
    groupId: projectUuidSchema,
    projectId: projectUuidSchema,
    baseRevision: z.number().int().safe().nonnegative(),
    commands: z.array(projectCommandSchemaV2).min(1).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    for (const [index, command] of request.commands.entries()) {
      if (command.type === "ImportAsset" && command.asset.contentIdentity === undefined) {
        context.addIssue({
          code: "custom",
          message: "Live asset imports require a content identity",
          path: ["commands", index, "asset", "contentIdentity"],
        });
      }
    }
  });
export type CommandGroupRequest = z.infer<typeof commandGroupRequestSchema>;
