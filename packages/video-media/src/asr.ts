import { z } from "zod";

import { mediaJobStateSchema } from "./jobs.js";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const uuidSchema = z.uuid();
const boundedTextSchema = z.string().min(1).max(1_024);
const fileNameSchema = z.string().min(1).max(255);

/** Why a runtime folder did not match the pinned manifest. */
export const asrRuntimeProblemSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("folderMissing") }).strict(),
  z.object({ reason: z.literal("linkedPath") }).strict(),
  z.object({ reason: z.literal("tooManyEntries") }).strict(),
  z.object({ reason: z.literal("missingFile"), name: fileNameSchema }).strict(),
  z.object({ reason: z.literal("sizeMismatch"), name: fileNameSchema }).strict(),
  z.object({ reason: z.literal("unexpectedExecutable"), name: fileNameSchema }).strict(),
  z.object({ reason: z.literal("integrityFailed") }).strict(),
]);
export type AsrRuntimeProblem = z.infer<typeof asrRuntimeProblemSchema>;

export const asrRuntimeAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("notConfigured") }).strict(),
  z.object({ state: z.literal("ready") }).strict(),
  z.object({ state: z.literal("unavailable"), problem: asrRuntimeProblemSchema }).strict(),
]);
export type AsrRuntimeAvailability = z.infer<typeof asrRuntimeAvailabilitySchema>;

export const asrConsentStateSchema = z.enum(["missing", "stale", "accepted"]);
export type AsrConsentState = z.infer<typeof asrConsentStateSchema>;

export const asrLicenseSummarySchema = z
  .object({
    modelId: boundedTextSchema,
    modelRevision: boundedTextSchema,
    modelLicenseSpdx: boundedTextSchema,
    modelLicenseUrl: z.url({ protocol: /^https$/u }),
    modelAttribution: boundedTextSchema,
    runtimeLicenseSpdx: boundedTextSchema,
    runtimeLicenseUrl: z.url({ protocol: /^https$/u }),
    runtimeAttribution: boundedTextSchema,
    commercialUse: z.boolean(),
    device: boundedTextSchema,
  })
  .strict();
export type AsrLicenseSummary = z.infer<typeof asrLicenseSummarySchema>;

export const asrRuntimeStatusSchema = z
  .object({
    runtimeFolder: z.string().min(1).max(1_024).nullable(),
    runtime: asrRuntimeAvailabilitySchema,
    consent: asrConsentStateSchema,
    manifestSha256: sha256HexSchema,
    license: asrLicenseSummarySchema,
  })
  .strict();
export type AsrRuntimeStatus = z.infer<typeof asrRuntimeStatusSchema>;

export const asrConsentRequestSchema = z
  .object({ accepted: z.boolean(), manifestSha256: z.union([sha256HexSchema, z.literal("")]) })
  .strict();
export type AsrConsentRequest = z.infer<typeof asrConsentRequestSchema>;

export const startTranscriptionRequestSchema = z
  .object({
    projectId: uuidSchema,
    assetId: uuidSchema,
    sourcePath: z.string().min(1).max(32_767),
  })
  .strict();
export type StartTranscriptionRequest = z.infer<typeof startTranscriptionRequestSchema>;

export const transcriptionStartedSchema = z
  .object({
    jobId: uuidSchema,
    state: mediaJobStateSchema,
  })
  .strict();
export type TranscriptionStarted = z.infer<typeof transcriptionStartedSchema>;

export const transcriptionResultRequestSchema = z.object({ jobId: uuidSchema }).strict();
export type TranscriptionResultRequest = z.infer<typeof transcriptionResultRequestSchema>;

export const transcriptionJobResultSchema = z
  .object({
    transcriptKey: sha256HexSchema,
    wordCount: z.number().int().nonnegative().safe(),
    reused: z.boolean(),
  })
  .strict();
export type TranscriptionJobResult = z.infer<typeof transcriptionJobResultSchema>;
