import { z } from "zod";

import { mediaJobTimestampSchema } from "./jobs.js";

const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const boundedMessageSchema = z.string().trim().min(1).max(512);

export const mediaCachePressureSchema = z.enum(["normal", "over_budget", "pinned"]);
export type MediaCachePressure = z.infer<typeof mediaCachePressureSchema>;

export const mediaCacheStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    budgetBytes: safeNonNegativeIntegerSchema,
    managedBytes: safeNonNegativeIntegerSchema,
    leasedBytes: safeNonNegativeIntegerSchema,
    reclaimableBytes: safeNonNegativeIntegerSchema,
    artifactCount: safeNonNegativeIntegerSchema,
    leasedArtifactCount: safeNonNegativeIntegerSchema,
    pressure: mediaCachePressureSchema,
    legacyBytes: safeNonNegativeIntegerSchema,
    legacyEntryCount: safeNonNegativeIntegerSchema,
    legacyUnsafeEntryCount: safeNonNegativeIntegerSchema,
    legacyClearAvailable: z.boolean(),
    recoveryWarning: boundedMessageSchema.nullable(),
    refreshedAt: mediaJobTimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.leasedBytes > status.managedBytes) {
      context.addIssue({
        code: "custom",
        path: ["leasedBytes"],
        message: "Leased bytes cannot exceed managed bytes",
      });
    }
    if (status.reclaimableBytes > status.managedBytes - status.leasedBytes) {
      context.addIssue({
        code: "custom",
        path: ["reclaimableBytes"],
        message: "Reclaimable bytes exceed unleased managed bytes",
      });
    }
    if (status.leasedArtifactCount > status.artifactCount) {
      context.addIssue({
        code: "custom",
        path: ["leasedArtifactCount"],
        message: "Leased artifact count exceeds artifact count",
      });
    }
    if (status.pressure === "normal" && status.managedBytes > status.budgetBytes) {
      context.addIssue({
        code: "custom",
        path: ["pressure"],
        message: "Usage above budget must report cache pressure",
      });
    }
    if (status.legacyClearAvailable !== status.legacyEntryCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["legacyClearAvailable"],
        message: "Legacy clear availability must match inventoried entries",
      });
    }
  });
export type MediaCacheStatus = z.infer<typeof mediaCacheStatusSchema>;

export const getMediaCacheStatusRequestSchema = z.object({}).strict();
export type GetMediaCacheStatusRequest = z.infer<typeof getMediaCacheStatusRequestSchema>;

export const clearLegacyMediaCacheRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export type ClearLegacyMediaCacheRequest = z.infer<typeof clearLegacyMediaCacheRequestSchema>;

export const clearLegacyMediaCacheResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    clearedBytes: safeNonNegativeIntegerSchema,
    clearedEntryCount: safeNonNegativeIntegerSchema,
    skippedUnsafeEntryCount: safeNonNegativeIntegerSchema,
    status: mediaCacheStatusSchema,
  })
  .strict();
export type ClearLegacyMediaCacheResponse = z.infer<typeof clearLegacyMediaCacheResponseSchema>;
