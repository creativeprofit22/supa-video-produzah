import { z } from "zod";

import { projectCommandSchemaV2 } from "./project-commands-v2.js";
import { projectUuidSchema } from "./project.js";
import { rationalTimeSchema } from "./time.js";
import { videoProjectStateV2Schema } from "./project-v2-entities.js";

export * from "./project-v2-entities.js";

const dateTimeSchema = z.string().datetime({ offset: true });
const nonBlankSchema = z.string().trim().min(1).max(512);
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const stateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const projectRevisionDescriptorV2Schema = z
  .object({
    number: safeNonNegativeIntegerSchema,
    id: projectUuidSchema,
    parentId: projectUuidSchema.nullable(),
    committedAt: dateTimeSchema,
    operationId: projectUuidSchema,
    stateHash: stateHashSchema,
  })
  .strict();
export type ProjectRevisionDescriptorV2 = z.infer<typeof projectRevisionDescriptorV2Schema>;

export const affectedRangeSchema = z
  .object({
    sequenceId: projectUuidSchema,
    start: rationalTimeSchema,
    end: rationalTimeSchema,
  })
  .strict()
  .refine((range) => range.end.value > range.start.value, "Affected range must be nonempty");
export const cacheInvalidationSchema = z.enum([
  "timeline",
  "preview",
  "audio_mix",
  "captions",
  "render_plan",
  "asset_source",
]);

export const projectHistoryEntryV2Schema = z
  .object({
    groupId: projectUuidSchema,
    summary: nonBlankSchema,
    forwardCommands: z.array(projectCommandSchemaV2).min(1).max(100),
    inverseCommands: z.array(projectCommandSchemaV2).min(1).max(100),
    affectedRanges: z.array(affectedRangeSchema).max(10_000),
    cacheInvalidations: z.array(cacheInvalidationSchema).max(6),
  })
  .strict();
export type ProjectHistoryEntryV2 = z.infer<typeof projectHistoryEntryV2Schema>;

export const projectHistoryV2Schema = z
  .object({
    undoStack: z.array(projectHistoryEntryV2Schema).max(10_000),
    redoStack: z.array(projectHistoryEntryV2Schema).max(10_000),
  })
  .strict();

export const videoProjectSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: projectUuidSchema,
    name: nonBlankSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    storageGenerationId: projectUuidSchema,
    revision: projectRevisionDescriptorV2Schema,
    state: videoProjectStateV2Schema,
    history: projectHistoryV2Schema,
    lastAppliedRecordNumber: safeNonNegativeIntegerSchema,
    lastRecordHash: stateHashSchema,
  })
  .strict()
  .refine(
    (snapshot) => Date.parse(snapshot.updatedAt) >= Date.parse(snapshot.createdAt),
    "Project update time cannot precede creation",
  );
export type VideoProjectSnapshotV2 = z.infer<typeof videoProjectSnapshotV2Schema>;
