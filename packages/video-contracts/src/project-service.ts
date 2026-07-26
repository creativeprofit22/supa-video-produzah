import { z } from "zod";

import { videoSourceRecordSchema } from "./project-io.js";
import {
  affectedRangeSchema,
  cacheInvalidationSchema,
  projectRevisionDescriptorV2Schema,
  videoProjectStateV2Schema,
} from "./project-v2.js";
import { projectUuidSchema } from "./project.js";

const nonBlankSchema = z.string().trim().min(1).max(512);
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const stateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const journalHealthSchema = z.enum(["healthy", "snapshot_pending", "unhealthy"]);
export type JournalHealth = z.infer<typeof journalHealthSchema>;
export const recoveryStatusSchema = z.enum([
  "clean",
  "recovered",
  "degraded",
  "journal_recreated",
  "migrated_v1",
]);
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

export const recoveryReportSchema = z
  .object({
    status: recoveryStatusSchema,
    recoveredRevision: safeNonNegativeIntegerSchema,
    replayedRecordCount: safeNonNegativeIntegerSchema,
    discardedTailBytes: safeNonNegativeIntegerSchema,
    message: nonBlankSchema,
    legacyHistoryReset: z.boolean(),
  })
  .strict();
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;

export const lastCommandMetadataSchema = z
  .object({ operationId: projectUuidSchema, groupId: projectUuidSchema, summary: nonBlankSchema })
  .strict();

export const projectProjectionSchema = z
  .object({
    projectId: projectUuidSchema,
    name: nonBlankSchema,
    revision: projectRevisionDescriptorV2Schema,
    state: videoProjectStateV2Schema,
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    lastCommand: lastCommandMetadataSchema.nullable(),
    sources: z.array(videoSourceRecordSchema).max(100_000),
    journalHealth: journalHealthSchema,
    snapshotRevision: safeNonNegativeIntegerSchema,
    recoveryStatus: recoveryStatusSchema,
    replayedRecordCount: safeNonNegativeIntegerSchema,
  })
  .strict();
export type ProjectProjection = z.infer<typeof projectProjectionSchema>;

export const projectEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("project_changed"),
      projectId: projectUuidSchema,
      revision: safeNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("history_changed"), canUndo: z.boolean(), canRedo: z.boolean() })
    .strict(),
  z.object({ type: z.literal("snapshot_warning"), message: nonBlankSchema }).strict(),
  z.object({ type: z.literal("recovery_changed"), status: recoveryStatusSchema }).strict(),
]);
export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const commandResultSchema = z
  .object({
    projectId: projectUuidSchema,
    operationId: projectUuidSchema,
    groupId: projectUuidSchema,
    priorRevision: projectRevisionDescriptorV2Schema,
    newRevision: projectRevisionDescriptorV2Schema,
    stateHash: stateHashSchema,
    projection: projectProjectionSchema,
    affectedRanges: z.array(affectedRangeSchema).max(10_000),
    cacheInvalidations: z.array(cacheInvalidationSchema).max(6),
    events: z.array(projectEventSchema).max(100),
  })
  .strict();
export type CommandResult = z.infer<typeof commandResultSchema>;

export const openedProjectV2Schema = z
  .object({ projection: projectProjectionSchema, recovery: recoveryReportSchema })
  .strict();
export type OpenedProjectV2 = z.infer<typeof openedProjectV2Schema>;

export const projectInspectorSchema = z
  .object({
    projectId: projectUuidSchema,
    revision: projectRevisionDescriptorV2Schema,
    lastCommand: lastCommandMetadataSchema.nullable(),
    snapshotRevision: safeNonNegativeIntegerSchema,
    journalHealth: journalHealthSchema,
    replayedRecordCount: safeNonNegativeIntegerSchema,
    recoveryStatus: recoveryStatusSchema,
  })
  .strict();
export type ProjectInspector = z.infer<typeof projectInspectorSchema>;
