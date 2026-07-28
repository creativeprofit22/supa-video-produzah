import { projectUuidSchema } from "@supa-video/contracts";
import { z } from "zod";

const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const safePositiveIntegerSchema = z.number().int().safe().positive();
const boundedLabelSchema = z.string().trim().min(1).max(512);
const boundedCodeSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .min(1)
  .max(64);
export const mediaJobTimestampSchema = z
  .string()
  .max(64)
  .datetime({ offset: true })
  .refine((value) => {
    const timestamp = Date.parse(value);
    return timestamp >= 0 && timestamp <= 253_402_300_799_999;
  }, "Timestamp must be between the Unix epoch and year 9999");

export const mediaJobKindSchema = z.enum([
  "asset_preparation",
  "proxy",
  "thumbnail_tile",
  "final_render",
]);
export type MediaJobKind = z.infer<typeof mediaJobKindSchema>;

export const mediaJobStateSchema = z.enum([
  "queued",
  "probing",
  "running",
  "blocked",
  "retrying",
  "cancelled",
  "failed",
  "complete",
]);
export type MediaJobState = z.infer<typeof mediaJobStateSchema>;

export const mediaJobPrioritySchema = z.enum(["interactive", "export", "background"]);
export type MediaJobPriority = z.infer<typeof mediaJobPrioritySchema>;

export const mediaJobProgressUnitSchema = z.enum([
  "items",
  "bytes",
  "frames",
  "microseconds",
  "stages",
]);
export type MediaJobProgressUnit = z.infer<typeof mediaJobProgressUnitSchema>;

export const mediaJobProgressSchema = z
  .object({
    completed: safeNonNegativeIntegerSchema,
    total: safeNonNegativeIntegerSchema,
    unit: mediaJobProgressUnitSchema,
  })
  .strict()
  .refine(
    (progress) => progress.total === 0 || progress.completed <= progress.total,
    "Completed progress cannot exceed total progress",
  );
export type MediaJobProgress = z.infer<typeof mediaJobProgressSchema>;

export const mediaJobErrorCategorySchema = z.enum([
  "authorization_required",
  "canonical_object_missing",
  "toolchain_unavailable",
  "output_authorization_required",
  "cache_pressure",
  "transient_io",
  "process_failed",
  "invalid_media",
  "integrity_failed",
  "policy_rejected",
  "database_recovered",
]);
export type MediaJobErrorCategory = z.infer<typeof mediaJobErrorCategorySchema>;

export const mediaJobRecoveryActionSchema = z.enum([
  "reauthorize_source",
  "reauthorize_output",
  "verify_toolchain",
  "free_cache",
  "retry",
]);
export type MediaJobRecoveryAction = z.infer<typeof mediaJobRecoveryActionSchema>;

export const mediaJobErrorSchema = z
  .object({
    code: boundedCodeSchema,
    category: mediaJobErrorCategorySchema,
    message: boundedLabelSchema,
    retryable: z.boolean(),
    action: mediaJobRecoveryActionSchema.nullable(),
  })
  .strict();
export type MediaJobError = z.infer<typeof mediaJobErrorSchema>;

const jobRecordBaseShape = {
  schemaVersion: z.literal(1),
  id: projectUuidSchema,
  kind: mediaJobKindSchema,
  parentId: projectUuidSchema.nullable(),
  projectId: projectUuidSchema.nullable(),
  assetId: projectUuidSchema.nullable(),
  revisionId: z.string().trim().min(1).max(128).nullable(),
  priority: mediaJobPrioritySchema,
  stage: boundedCodeSchema,
  progress: mediaJobProgressSchema,
  attempt: safeNonNegativeIntegerSchema.max(100),
  maxAttempts: safePositiveIntegerSchema.max(100),
  summary: boundedLabelSchema,
  createdAt: mediaJobTimestampSchema,
  updatedAt: mediaJobTimestampSchema,
  startedAt: mediaJobTimestampSchema.nullable(),
  cancellationRequested: z.boolean(),
} as const;

const unsettledJobShape = {
  ...jobRecordBaseShape,
  settledAt: z.null(),
  resultAvailable: z.literal(false),
} as const;

export const mediaJobRecordSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        ...unsettledJobShape,
        state: z.literal("queued"),
        retryAt: z.null(),
        error: z.null(),
      })
      .strict(),
    z
      .object({
        ...unsettledJobShape,
        state: z.literal("probing"),
        retryAt: z.null(),
        error: z.null(),
      })
      .strict(),
    z
      .object({
        ...unsettledJobShape,
        state: z.literal("running"),
        retryAt: z.null(),
        error: z.null(),
      })
      .strict(),
    z
      .object({
        ...unsettledJobShape,
        state: z.literal("blocked"),
        retryAt: z.null(),
        error: mediaJobErrorSchema,
      })
      .strict(),
    z
      .object({
        ...unsettledJobShape,
        state: z.literal("retrying"),
        retryAt: mediaJobTimestampSchema,
        error: mediaJobErrorSchema,
      })
      .strict(),
    z
      .object({
        ...jobRecordBaseShape,
        state: z.literal("cancelled"),
        settledAt: mediaJobTimestampSchema,
        retryAt: z.null(),
        error: z.null(),
        resultAvailable: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...jobRecordBaseShape,
        state: z.literal("failed"),
        settledAt: mediaJobTimestampSchema,
        retryAt: z.null(),
        error: mediaJobErrorSchema,
        resultAvailable: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...jobRecordBaseShape,
        state: z.literal("complete"),
        settledAt: mediaJobTimestampSchema,
        retryAt: z.null(),
        error: z.null(),
        resultAvailable: z.literal(true),
      })
      .strict(),
  ])
  .superRefine((job, context) => {
    const createdAt = Date.parse(job.createdAt);
    if (Date.parse(job.updatedAt) < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt precedes createdAt",
      });
    }
    for (const key of ["startedAt", "settledAt"] as const) {
      const value = job[key];
      if (value !== null && Date.parse(value) < createdAt) {
        context.addIssue({ code: "custom", path: [key], message: `${key} precedes createdAt` });
      }
    }
    if (job.attempt > job.maxAttempts) {
      context.addIssue({
        code: "custom",
        path: ["attempt"],
        message: "attempt exceeds maxAttempts",
      });
    }
  });
export type MediaJobRecord = z.infer<typeof mediaJobRecordSchema>;

export const mediaJobEventTypeSchema = z.enum([
  "created",
  "state_changed",
  "progress",
  "retry_scheduled",
  "cancellation_requested",
  "recovered",
  "cache_hit",
]);
export type MediaJobEventType = z.infer<typeof mediaJobEventTypeSchema>;

export const mediaJobEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: safePositiveIntegerSchema,
    jobId: projectUuidSchema,
    eventType: mediaJobEventTypeSchema,
    state: mediaJobStateSchema,
    stage: boundedCodeSchema,
    progress: mediaJobProgressSchema,
    message: boundedLabelSchema.nullable(),
    category: mediaJobErrorCategorySchema.nullable(),
    createdAt: mediaJobTimestampSchema,
  })
  .strict();
export type MediaJobEvent = z.infer<typeof mediaJobEventSchema>;

export const mediaJobRecoveryReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    requeuedCount: safeNonNegativeIntegerSchema,
    blockedCount: safeNonNegativeIntegerSchema,
    cancelledCount: safeNonNegativeIntegerSchema,
    staleLeaseCount: safeNonNegativeIntegerSchema,
    databaseRecovered: z.boolean(),
    warning: boundedLabelSchema.nullable(),
    recoveredAt: mediaJobTimestampSchema,
  })
  .strict();
export type MediaJobRecoveryReport = z.infer<typeof mediaJobRecoveryReportSchema>;

export const listMediaJobsRequestSchema = z
  .object({
    limit: safePositiveIntegerSchema.max(100).default(100),
    includeSettled: z.boolean().default(true),
    projectId: projectUuidSchema.nullable().default(null),
    beforeUpdatedAt: mediaJobTimestampSchema.nullable().default(null),
  })
  .strict();
export type ListMediaJobsRequest = z.input<typeof listMediaJobsRequestSchema>;

export const mediaJobListSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobs: z.array(mediaJobRecordSchema).max(100),
    nextBeforeUpdatedAt: mediaJobTimestampSchema.nullable(),
    latestEventId: safeNonNegativeIntegerSchema,
    recovery: mediaJobRecoveryReportSchema.nullable(),
  })
  .strict();
export type MediaJobList = z.infer<typeof mediaJobListSchema>;

export const getMediaJobEventsRequestSchema = z
  .object({
    jobId: projectUuidSchema.nullable().default(null),
    afterEventId: safeNonNegativeIntegerSchema.default(0),
    limit: safePositiveIntegerSchema.max(500).default(500),
  })
  .strict();
export type GetMediaJobEventsRequest = z.input<typeof getMediaJobEventsRequestSchema>;

export const mediaJobEventListSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(mediaJobEventSchema).max(500),
    latestEventId: safeNonNegativeIntegerSchema,
    hasMore: z.boolean(),
  })
  .strict();
export type MediaJobEventList = z.infer<typeof mediaJobEventListSchema>;

export const mediaJobActionRequestSchema = z.object({ jobId: projectUuidSchema }).strict();
export type MediaJobActionRequest = z.infer<typeof mediaJobActionRequestSchema>;

export const mediaJobActionResponseSchema = z
  .object({ schemaVersion: z.literal(1), job: mediaJobRecordSchema })
  .strict();
export type MediaJobActionResponse = z.infer<typeof mediaJobActionResponseSchema>;
