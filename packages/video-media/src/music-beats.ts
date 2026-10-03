import { z } from "zod";

import { mediaJobStateSchema } from "./jobs.js";

/**
 * Music beat analysis (`music_beats` derived media, format `music-beats-v1`).
 * Music beats are detected pulses in a music asset; they are never narrative
 * beats. Times are integer source-time microseconds.
 */

/** Upper bounds that keep the artifact small and the IPC payload bounded. */
export const MUSIC_BEAT_ANALYSIS_LIMITS = {
  maxMusicBeats: 20_000,
  maxDownbeats: 20_000,
  maxOnsets: 60_000,
  /** One hour of audio; mirrors MAX_MUSIC_BEAT_DURATION_US in apps/desktop/src-tauri/src/video/music_beats.rs. */
  maxDurationUs: 3_600_000_000,
  minTempoBpm: 20,
  maxTempoBpm: 400,
} as const;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const uuidSchema = z.uuid();
const microsecondsSchema = z.number().int().safe().nonnegative();

function sortedTimesSchema(max: number): z.ZodType<readonly number[]> {
  return z
    .array(microsecondsSchema)
    .max(max)
    .refine(
      (times) => times.every((time, index) => index === 0 || time > (times[index - 1] ?? -1)),
      "Times must be strictly increasing",
    )
    .readonly();
}

export const musicBeatDetectorKindSchema = z.enum(["beat_this", "tempo_fallback"]);
export type MusicBeatDetectorKind = z.infer<typeof musicBeatDetectorKindSchema>;

export const musicBeatDetectorSchema = z
  .object({
    kind: musicBeatDetectorKindSchema,
    version: z.string().min(1).max(64),
    checkpointSha256: sha256HexSchema.nullable(),
  })
  .strict()
  .refine(
    (detector) => (detector.kind === "beat_this") === (detector.checkpointSha256 !== null),
    "Only Beat This! analyses record a checkpoint digest",
  );
export type MusicBeatDetector = z.infer<typeof musicBeatDetectorSchema>;

export const musicBeatAnalysisV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    detector: musicBeatDetectorSchema,
    durationUs: microsecondsSchema.max(MUSIC_BEAT_ANALYSIS_LIMITS.maxDurationUs),
    tempoBpm: z
      .number()
      .min(MUSIC_BEAT_ANALYSIS_LIMITS.minTempoBpm)
      .max(MUSIC_BEAT_ANALYSIS_LIMITS.maxTempoBpm)
      .nullable(),
    beatsUs: sortedTimesSchema(MUSIC_BEAT_ANALYSIS_LIMITS.maxMusicBeats),
    downbeatsUs: sortedTimesSchema(MUSIC_BEAT_ANALYSIS_LIMITS.maxDownbeats),
    onsetsUs: sortedTimesSchema(MUSIC_BEAT_ANALYSIS_LIMITS.maxOnsets),
  })
  .strict()
  .refine(
    (analysis) =>
      [analysis.beatsUs, analysis.downbeatsUs, analysis.onsetsUs].every(
        (times) => (times.at(-1) ?? 0) <= analysis.durationUs,
      ),
    "Times must lie within the analysed duration",
  )
  .refine(
    (analysis) => analysis.beatsUs.length > 0 || analysis.tempoBpm === null,
    "A tempo needs at least one music beat",
  );
export type MusicBeatAnalysisV1 = z.infer<typeof musicBeatAnalysisV1Schema>;

export const startMusicBeatDetectionRequestSchema = z
  .object({
    projectId: uuidSchema,
    assetId: uuidSchema,
    sourcePath: z.string().min(1).max(32_767),
  })
  .strict();
export type StartMusicBeatDetectionRequest = z.infer<typeof startMusicBeatDetectionRequestSchema>;

export const musicBeatDetectionStartedSchema = z
  .object({ jobId: uuidSchema, state: mediaJobStateSchema })
  .strict();
export type MusicBeatDetectionStarted = z.infer<typeof musicBeatDetectionStartedSchema>;

export const musicBeatDetectionResultRequestSchema = z.object({ jobId: uuidSchema }).strict();
export type MusicBeatDetectionResultRequest = z.infer<typeof musicBeatDetectionResultRequestSchema>;

export const musicBeatDetectionResultSchema = z
  .object({
    analysisKey: sha256HexSchema,
    detector: musicBeatDetectorKindSchema,
    musicBeatCount: z.number().int().safe().nonnegative(),
    reused: z.boolean(),
  })
  .strict();
export type MusicBeatDetectionResult = z.infer<typeof musicBeatDetectionResultSchema>;

export const loadMusicBeatAnalysisRequestSchema = z
  .object({ analysisKey: sha256HexSchema })
  .strict();
export type LoadMusicBeatAnalysisRequest = z.infer<typeof loadMusicBeatAnalysisRequestSchema>;

/** Why a music-beat runtime folder cannot be used. */
export const musicBeatRuntimeProblemSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("folderMissing") }).strict(),
  z.object({ reason: z.literal("linkedPath") }).strict(),
  /** A pinned model file is missing from `models/`. */
  z.object({ reason: z.literal("modelMissing") }).strict(),
  /** A model file does not match the pinned SHA-256 and size. */
  z.object({ reason: z.literal("modelMismatch") }).strict(),
  /** This build does not include the beat detector program. */
  z.object({ reason: z.literal("detectorMissing") }).strict(),
  /** The beat detector could not load the models. */
  z.object({ reason: z.literal("probeFailed") }).strict(),
]);
export type MusicBeatRuntimeProblem = z.infer<typeof musicBeatRuntimeProblemSchema>;

/** Why a ready runtime runs on the CPU instead of the GPU. */
export const musicBeatCpuReasonSchema = z.enum(["noGpuPack", "gpuPackMismatch", "cudaInitFailed"]);
export type MusicBeatCpuReason = z.infer<typeof musicBeatCpuReasonSchema>;

/** The device a ready runtime runs on. */
export const musicBeatAcceleratorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cuda") }).strict(),
  z.object({ kind: z.literal("cpu"), reason: musicBeatCpuReasonSchema }).strict(),
]);
export type MusicBeatAccelerator = z.infer<typeof musicBeatAcceleratorSchema>;

export const musicBeatRuntimeAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("notConfigured") }).strict(),
  z.object({ state: z.literal("ready") }).strict(),
  z.object({ state: z.literal("unavailable"), problem: musicBeatRuntimeProblemSchema }).strict(),
]);
export type MusicBeatRuntimeAvailability = z.infer<typeof musicBeatRuntimeAvailabilitySchema>;

export const musicBeatRuntimeStatusSchema = z
  .object({
    runtimeFolder: z.string().min(1).max(1_024).nullable(),
    runtime: musicBeatRuntimeAvailabilitySchema,
    /** Set when `runtime` is ready. */
    accelerator: musicBeatAcceleratorSchema.nullable(),
    manifestSha256: sha256HexSchema,
    beatThisVersion: z.string().min(1).max(64),
    checkpointSha256: sha256HexSchema,
  })
  .strict();
export type MusicBeatRuntimeStatus = z.infer<typeof musicBeatRuntimeStatusSchema>;
