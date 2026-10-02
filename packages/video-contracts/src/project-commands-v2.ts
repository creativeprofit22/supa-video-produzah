import { z } from "zod";

import { captionArtifactV1Schema } from "./caption.js";
import { clipSpeedSchema } from "./clip-timing.js";
import {
  graphicsClipSchema,
  graphicsLayersSchema,
  MAX_GRAPHICS_DURATION_FRAMES,
} from "./project-graphics.js";
import {
  clipTransformSchema,
  clipFadesSchema,
  sequenceFrameHeightSchema,
  sequenceFrameWidthSchema,
  sequenceLoudnessTargetSchema,
  trackAudioRoleSchema,
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
import { renderCaptionFontKeySchema } from "./render-fonts.js";
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
export const setTrackLockedCommandSchemaV2 = z
  .object({
    type: z.literal("SetTrackLocked"),
    ...commandId,
    ...target,
    locked: z.boolean(),
  })
  .strict();
export const setTrackMutedCommandSchemaV2 = z
  .object({
    type: z.literal("SetTrackMuted"),
    ...commandId,
    ...target,
    muted: z.boolean(),
  })
  .strict();
export const setTrackHiddenCommandSchemaV2 = z
  .object({
    type: z.literal("SetTrackHidden"),
    ...commandId,
    ...target,
    hidden: z.boolean(),
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
export const rippleDeleteClipCommandSchemaV2 = z
  .object({
    type: z.literal("RippleDeleteClip"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
  })
  .strict();
const restoreRippleDeletedClipCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreRippleDeletedClip"),
    ...commandId,
    ...target,
    index: z.number().int().safe().nonnegative(),
    clip: projectClipSchema,
  })
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
/**
 * Atomically replaces the complete clip transform.
 * Single-field editors must use field-specific commands to avoid overwriting stale sibling fields.
 */
export const setClipTransformCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipTransform"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    transform: clipTransformSchema,
  })
  .strict();
export const setClipOpacityCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipOpacity"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    opacityPermille: z.number().int().safe().min(0).max(1_000),
  })
  .strict();
export const setClipSpeedCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipSpeed"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    speed: clipSpeedSchema,
  })
  .strict();

export const restoreClipSpeedCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreClipSpeed"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    speed: clipSpeedSchema.nullable(),
  })
  .strict();

export const setClipFadesCommandSchemaV2 = z
  .object({
    type: z.literal("SetClipFades"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    fades: clipFadesSchema,
  })
  .strict();

export const restoreClipFadesCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreClipFades"),
    ...commandId,
    ...target,
    clipId: projectUuidSchema,
    fades: clipFadesSchema.nullable(),
  })
  .strict();

export const setTrackAudioRoleCommandSchemaV2 = z
  .object({
    type: z.literal("SetTrackAudioRole"),
    ...commandId,
    ...target,
    /** `null` clears the role (legacy: no role). The field itself is required. */
    role: trackAudioRoleSchema.nullable(),
  })
  .strict();

export const restoreTrackAudioRoleCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreTrackAudioRole"),
    ...commandId,
    ...target,
    role: trackAudioRoleSchema.nullable(),
  })
  .strict();

export const setSequenceLoudnessTargetCommandSchemaV2 = z
  .object({
    type: z.literal("SetSequenceLoudnessTarget"),
    ...commandId,
    sequenceId: projectUuidSchema,
    /** `null` clears the target (legacy: not normalized). The field itself is required. */
    target: sequenceLoudnessTargetSchema.nullable(),
  })
  .strict();

/** Changes the output frame; clips are fitted into it by the renderer. Self-inverse. */
export const setSequenceFrameSizeCommandSchemaV2 = z
  .object({
    type: z.literal("SetSequenceFrameSize"),
    ...commandId,
    sequenceId: projectUuidSchema,
    width: sequenceFrameWidthSchema,
    height: sequenceFrameHeightSchema,
  })
  .strict();

export const restoreSequenceLoudnessTargetCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreSequenceLoudnessTarget"),
    ...commandId,
    sequenceId: projectUuidSchema,
    target: sequenceLoudnessTargetSchema.nullable(),
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
export const addGraphicsClipCommandSchemaV2 = z
  .object({
    type: z.literal("AddGraphicsClip"),
    ...commandId,
    ...target,
    index: insertionIndex,
    graphicsClip: graphicsClipSchema,
  })
  .strict();
export const removeGraphicsClipCommandSchemaV2 = z
  .object({
    type: z.literal("RemoveGraphicsClip"),
    ...commandId,
    ...target,
    graphicsClipId: projectUuidSchema,
  })
  .strict();
/** Sets a graphics clip's timeline start and duration; its own inverse. */
export const moveGraphicsClipCommandSchemaV2 = z
  .object({
    type: z.literal("MoveGraphicsClip"),
    ...commandId,
    ...target,
    graphicsClipId: projectUuidSchema,
    timelineStart: rationalTimeSchema,
    duration: rationalTimeSchema,
  })
  .strict()
  .refine(
    (command) =>
      command.timelineStart.rateNumerator === command.duration.rateNumerator &&
      command.timelineStart.rateDenominator === command.duration.rateDenominator &&
      command.duration.value >= 1 &&
      command.duration.value <= MAX_GRAPHICS_DURATION_FRAMES,
    `Graphics clip duration must be 1..${String(MAX_GRAPHICS_DURATION_FRAMES)} frames at the start's rate`,
  );
/** Replaces a graphics clip's font and layers; its own inverse. Motion presets apply through it. */
export const setGraphicsClipLayersCommandSchemaV2 = z
  .object({
    type: z.literal("SetGraphicsClipLayers"),
    ...commandId,
    ...target,
    graphicsClipId: projectUuidSchema,
    fontKey: renderCaptionFontKeySchema,
    layers: graphicsLayersSchema,
  })
  .strict();
export const applyCaptionArtifactCommandSchemaV2 = z
  .object({
    type: z.literal("ApplyCaptionArtifact"),
    ...commandId,
    ...target,
    artifact: captionArtifactV1Schema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.artifact.trackLink.sequenceId !== command.sequenceId) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "trackLink", "sequenceId"],
        message: "Caption artifact sequence must match the command target",
      });
    }
    if (command.artifact.trackLink.captionTrackId !== command.trackId) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "trackLink", "captionTrackId"],
        message: "Caption artifact track must match the command target",
      });
    }
  });
const restoreActiveCaptionArtifactCommandSchemaV2 = z
  .object({
    type: z.literal("RestoreActiveCaptionArtifact"),
    ...commandId,
    ...target,
    artifact: captionArtifactV1Schema.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.artifact !== undefined &&
      command.artifact.trackLink.sequenceId !== command.sequenceId
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "trackLink", "sequenceId"],
        message: "Caption artifact sequence must match the command target",
      });
    }
    if (
      command.artifact !== undefined &&
      command.artifact.trackLink.captionTrackId !== command.trackId
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "trackLink", "captionTrackId"],
        message: "Caption artifact track must match the command target",
      });
    }
  });
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
  setTrackLockedCommandSchemaV2,
  setTrackMutedCommandSchemaV2,
  setTrackHiddenCommandSchemaV2,
  insertClipCommandSchemaV2,
  removeClipCommandSchemaV2,
  rippleDeleteClipCommandSchemaV2,
  restoreRippleDeletedClipCommandSchemaV2,
  splitClipCommandSchemaV2,
  moveClipCommandSchemaV2,
  trimClipCommandSchemaV2,
  setClipTransformCommandSchemaV2,
  setClipOpacityCommandSchemaV2,
  setClipGainCommandSchemaV2,
  setClipSpeedCommandSchemaV2,
  setClipFadesCommandSchemaV2,
  restoreClipFadesCommandSchemaV2,
  restoreClipSpeedCommandSchemaV2,
  setTrackAudioRoleCommandSchemaV2,
  restoreTrackAudioRoleCommandSchemaV2,
  setSequenceFrameSizeCommandSchemaV2,
  setSequenceLoudnessTargetCommandSchemaV2,
  restoreSequenceLoudnessTargetCommandSchemaV2,
  addMarkerCommandSchemaV2,
  removeMarkerCommandSchemaV2,
  addCaptionCommandSchemaV2,
  removeCaptionCommandSchemaV2,
  addGraphicsClipCommandSchemaV2,
  removeGraphicsClipCommandSchemaV2,
  moveGraphicsClipCommandSchemaV2,
  setGraphicsClipLayersCommandSchemaV2,
  applyCaptionArtifactCommandSchemaV2,
  restoreActiveCaptionArtifactCommandSchemaV2,
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
      if (
        command.type === "RestoreRippleDeletedClip" ||
        command.type === "RestoreActiveCaptionArtifact" ||
        command.type === "RestoreClipSpeed" ||
        command.type === "RestoreClipFades"
      ) {
        context.addIssue({
          code: "custom",
          message: "Private inverse commands cannot be submitted directly",
          path: ["commands", index, "type"],
        });
      }
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
