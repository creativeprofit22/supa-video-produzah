import { mediaContentIdentityV1Schema, sha256DigestSchema } from "@supa-video/contracts";
import { z } from "zod";

import { sourceFingerprintV1Schema, type SourceFingerprintV1 } from "./identity.js";

const safeIntegerSchema = z.number().int().safe();
const nonNegativeIntegerSchema = safeIntegerSchema.nonnegative();
const positiveIntegerSchema = safeIntegerSchema.positive();
const identifierSchema = z.string().trim().min(1).max(512);
const chunkIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .min(1)
  .max(128);
const textSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((text) => text.trim().length > 0, "Transcript text cannot be blank");
const confidenceSchema = z.number().finite().min(0).max(1).nullable();

export const asrTaskV1Schema = z.enum(["transcribe", "translate"]);
export type AsrTaskV1 = z.infer<typeof asrTaskV1Schema>;

export const speakerDiarizationModeV1Schema = z.enum(["off", "optional", "required"]);
export type SpeakerDiarizationModeV1 = z.infer<typeof speakerDiarizationModeV1Schema>;

export const asrProviderSettingValueV1Schema = z.union([
  z.string().max(4_096),
  safeIntegerSchema,
  z.boolean(),
  z.null(),
]);
export type AsrProviderSettingValueV1 = z.infer<typeof asrProviderSettingValueV1Schema>;

export const asrProviderSettingV1Schema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .min(1)
      .max(128),
    value: asrProviderSettingValueV1Schema,
  })
  .strict();
export type AsrProviderSettingV1 = z.infer<typeof asrProviderSettingV1Schema>;

export const asrConfigurationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    engineId: identifierSchema,
    engineVersion: identifierSchema,
    modelId: identifierSchema,
    modelRevision: identifierSchema,
    requestedLanguage: identifierSchema.nullable(),
    task: asrTaskV1Schema,
    wordTimingRequired: z.boolean(),
    speakerDiarizationMode: speakerDiarizationModeV1Schema,
    chunkDurationUs: positiveIntegerSchema,
    chunkOverlapUs: nonNegativeIntegerSchema,
    providerSettings: z.array(asrProviderSettingV1Schema).max(128),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.chunkOverlapUs >= configuration.chunkDurationUs) {
      context.addIssue({
        code: "custom",
        path: ["chunkOverlapUs"],
        message: "Chunk overlap must be less than chunk duration",
      });
    }
    for (let index = 1; index < configuration.providerSettings.length; index += 1) {
      if (
        compareStrings(
          configuration.providerSettings[index - 1]!.key,
          configuration.providerSettings[index]!.key,
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["providerSettings", index, "key"],
          message: "Provider settings must have unique keys in ascending code-unit order",
        });
      }
    }
  });
export type AsrConfigurationV1 = z.infer<typeof asrConfigurationV1Schema>;

export const asrConfigurationIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("sha256"),
    digest: sha256DigestSchema,
  })
  .strict();
export type AsrConfigurationIdentityV1 = z.infer<typeof asrConfigurationIdentityV1Schema>;

export const timingProvenanceV1Schema = z.enum(["aligned", "estimated", "clamped"]);
export type TimingProvenanceV1 = z.infer<typeof timingProvenanceV1Schema>;

export const transcriptChunkWordInputV1Schema = z
  .object({
    text: textSchema,
    relativeStartUs: safeIntegerSchema,
    relativeEndUs: safeIntegerSchema,
    recognitionConfidence: confidenceSchema,
    speakerLabel: identifierSchema.nullable(),
    speakerConfidence: confidenceSchema,
    timingProvenance: timingProvenanceV1Schema,
  })
  .strict();
export type TranscriptChunkWordInputV1 = z.infer<typeof transcriptChunkWordInputV1Schema>;

export const transcriptChunkInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    chunkId: chunkIdSchema,
    chunkIndex: nonNegativeIntegerSchema,
    sourceStartUs: safeIntegerSchema,
    sourceEndUs: safeIntegerSchema,
    words: z.array(transcriptChunkWordInputV1Schema).max(100_000),
  })
  .strict()
  .refine((chunk) => chunk.sourceEndUs > chunk.sourceStartUs, {
    path: ["sourceEndUs"],
    message: "Input chunk must have a positive source span",
  });
export type TranscriptChunkInputV1 = z.infer<typeof transcriptChunkInputV1Schema>;

export const transcriptWordV1Schema = z
  .object({
    wordId: z.string().min(1).max(256),
    chunkId: chunkIdSchema,
    chunkIndex: nonNegativeIntegerSchema,
    wordIndex: nonNegativeIntegerSchema,
    text: textSchema,
    sourceStartUs: nonNegativeIntegerSchema,
    sourceEndUs: positiveIntegerSchema,
    recognitionConfidence: confidenceSchema,
    speakerLabel: identifierSchema.nullable(),
    speakerConfidence: confidenceSchema,
    timingProvenance: timingProvenanceV1Schema,
  })
  .strict()
  .superRefine((word, context) => {
    if (word.sourceEndUs <= word.sourceStartUs) {
      context.addIssue({
        code: "custom",
        path: ["sourceEndUs"],
        message: "Transcript words must have positive source spans",
      });
    }
    if (word.wordId !== `${word.chunkId}:${word.wordIndex}`) {
      context.addIssue({
        code: "custom",
        path: ["wordId"],
        message: "Word id must be stable from chunk id and word index",
      });
    }
  });
export type TranscriptWordV1 = z.infer<typeof transcriptWordV1Schema>;

export const normalizedTranscriptChunkV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    chunkId: chunkIdSchema,
    chunkIndex: nonNegativeIntegerSchema,
    sourceStartUs: nonNegativeIntegerSchema,
    sourceEndUs: positiveIntegerSchema,
    words: z.array(transcriptWordV1Schema).max(100_000),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.sourceEndUs <= chunk.sourceStartUs) {
      context.addIssue({
        code: "custom",
        path: ["sourceEndUs"],
        message: "Normalized chunk must have a positive source span",
      });
    }
    chunk.words.forEach((word, index) => {
      if (
        word.chunkId !== chunk.chunkId ||
        word.chunkIndex !== chunk.chunkIndex ||
        word.wordIndex !== index ||
        word.sourceStartUs < chunk.sourceStartUs ||
        word.sourceEndUs > chunk.sourceEndUs
      ) {
        context.addIssue({
          code: "custom",
          path: ["words", index],
          message: "Word identity and span must belong to its normalized chunk",
        });
      }
    });
  });
export type NormalizedTranscriptChunkV1 = z.infer<typeof normalizedTranscriptChunkV1Schema>;

export const transcriptUncertaintyCountsV1Schema = z
  .object({
    missingConfidenceWordCount: nonNegativeIntegerSchema,
    missingSpeakerWordCount: nonNegativeIntegerSchema,
    estimatedTimingWordCount: nonNegativeIntegerSchema,
    clampedTimingWordCount: nonNegativeIntegerSchema,
    retainedOverlapWordCount: nonNegativeIntegerSchema,
    removedExactDuplicateWordCount: nonNegativeIntegerSchema,
  })
  .strict();
export type TranscriptUncertaintyCountsV1 = z.infer<typeof transcriptUncertaintyCountsV1Schema>;

export const normalizedTranscriptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    chunks: z.array(normalizedTranscriptChunkV1Schema).max(10_000),
    words: z.array(transcriptWordV1Schema).max(1_000_000),
    uncertaintyCounts: transcriptUncertaintyCountsV1Schema,
  })
  .strict()
  .superRefine((transcript, context) => {
    validateNormalizedTranscriptContent(transcript, context);
  });
export type NormalizedTranscriptV1 = z.infer<typeof normalizedTranscriptV1Schema>;

export const transcriptArtifactIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    key: sha256DigestSchema,
    sourceIdentity: mediaContentIdentityV1Schema,
    sourceFingerprint: sourceFingerprintV1Schema,
    configurationIdentity: asrConfigurationIdentityV1Schema,
  })
  .strict();
export type TranscriptArtifactIdentityV1 = z.infer<typeof transcriptArtifactIdentityV1Schema>;

export const transcriptArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    identity: transcriptArtifactIdentityV1Schema,
    sourceDurationUs: positiveIntegerSchema,
    configuration: asrConfigurationV1Schema,
    chunks: z.array(normalizedTranscriptChunkV1Schema).max(10_000),
    words: z.array(transcriptWordV1Schema).max(1_000_000),
    uncertaintyCounts: transcriptUncertaintyCountsV1Schema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateNormalizedTranscriptContent(artifact, context, artifact.sourceDurationUs);
  });
export type TranscriptArtifactV1 = z.infer<typeof transcriptArtifactV1Schema>;

class FramedIdentityEncoder {
  readonly #parts: Uint8Array[] = [];

  string(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  bytes(value: Uint8Array): void {
    if (value.byteLength > 0xffff_ffff) throw new RangeError("Identity field exceeds u32 length");
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, value.byteLength, true);
    this.#parts.push(length, value);
  }

  integer(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Identity integer must be a non-negative safe integer");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    this.bytes(bytes);
  }

  signedInteger(value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Identity signed integer must be a safe integer");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
    this.bytes(bytes);
  }

  boolean(value: boolean): void {
    this.integer(value ? 1 : 0);
  }

  nullableString(value: string | null): void {
    this.boolean(value !== null);
    if (value !== null) this.string(value);
  }

  finish(): Uint8Array {
    const size = this.#parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

function digestBytes(digest: string): Uint8Array {
  sha256DigestSchema.parse(digest);
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeNamedString(encoder: FramedIdentityEncoder, key: string, value: string): void {
  encoder.string(key);
  encoder.string(value);
}

function encodeNamedInteger(encoder: FramedIdentityEncoder, key: string, value: number): void {
  encoder.string(key);
  encoder.integer(value);
}

export async function deriveAsrConfigurationIdentity(
  candidate: AsrConfigurationV1,
): Promise<AsrConfigurationIdentityV1> {
  const configuration = asrConfigurationV1Schema.parse(candidate);
  const encoder = new FramedIdentityEncoder();
  encoder.string("supa-video/asr-configuration/v1");
  encodeNamedString(encoder, "engineId", configuration.engineId);
  encodeNamedString(encoder, "engineVersion", configuration.engineVersion);
  encodeNamedString(encoder, "modelId", configuration.modelId);
  encodeNamedString(encoder, "modelRevision", configuration.modelRevision);
  encoder.string("requestedLanguage");
  encoder.nullableString(configuration.requestedLanguage);
  encodeNamedString(encoder, "task", configuration.task);
  encoder.string("wordTimingRequired");
  encoder.boolean(configuration.wordTimingRequired);
  encodeNamedString(encoder, "speakerDiarizationMode", configuration.speakerDiarizationMode);
  encodeNamedInteger(encoder, "chunkDurationUs", configuration.chunkDurationUs);
  encodeNamedInteger(encoder, "chunkOverlapUs", configuration.chunkOverlapUs);
  encodeNamedInteger(encoder, "providerSettingCount", configuration.providerSettings.length);
  for (const setting of configuration.providerSettings) {
    encoder.string(setting.key);
    const value = setting.value;
    if (value === null) {
      encoder.string("null");
    } else if (typeof value === "string") {
      encoder.string("string");
      encoder.string(value);
    } else if (typeof value === "boolean") {
      encoder.string("boolean");
      encoder.boolean(value);
    } else {
      encoder.string("number");
      encoder.signedInteger(value);
    }
  }
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: await sha256Hex(encoder.finish()),
  };
}

export interface DeriveTranscriptArtifactIdentityInput {
  sourceIdentity: z.infer<typeof mediaContentIdentityV1Schema>;
  sourceFingerprint: SourceFingerprintV1;
  configurationIdentity: AsrConfigurationIdentityV1;
}

export async function deriveTranscriptArtifactIdentity(
  candidate: DeriveTranscriptArtifactIdentityInput,
): Promise<TranscriptArtifactIdentityV1> {
  const sourceIdentity = mediaContentIdentityV1Schema.parse(candidate.sourceIdentity);
  const sourceFingerprint = sourceFingerprintV1Schema.parse(candidate.sourceFingerprint);
  const configurationIdentity = asrConfigurationIdentityV1Schema.parse(
    candidate.configurationIdentity,
  );
  const encoder = new FramedIdentityEncoder();
  encoder.string("supa-video/transcript-artifact/v1");
  encoder.string("sourceIdentity.digest");
  encoder.bytes(digestBytes(sourceIdentity.digest));
  encodeNamedInteger(encoder, "sourceIdentity.byteLength", sourceIdentity.byteLength);
  encoder.string("sourceFingerprint.digest");
  encoder.bytes(digestBytes(sourceFingerprint.digest));
  encodeNamedInteger(encoder, "sourceFingerprint.byteLength", sourceFingerprint.byteLength);
  encodeNamedInteger(
    encoder,
    "sourceFingerprint.modifiedUnixSeconds",
    sourceFingerprint.modifiedUnixSeconds,
  );
  encodeNamedInteger(
    encoder,
    "sourceFingerprint.modifiedNanoseconds",
    sourceFingerprint.modifiedNanoseconds,
  );
  encoder.string("configurationIdentity.digest");
  encoder.bytes(digestBytes(configurationIdentity.digest));
  return transcriptArtifactIdentityV1Schema.parse({
    schemaVersion: 1,
    key: await sha256Hex(encoder.finish()),
    sourceIdentity,
    sourceFingerprint,
    configurationIdentity,
  });
}

function compareStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function compareWords(first: TranscriptWordV1, second: TranscriptWordV1): number {
  return (
    first.sourceStartUs - second.sourceStartUs ||
    first.sourceEndUs - second.sourceEndUs ||
    first.chunkIndex - second.chunkIndex ||
    first.wordIndex - second.wordIndex ||
    compareStrings(first.wordId, second.wordId)
  );
}

function validateCanonicalWords(
  words: readonly TranscriptWordV1[],
  context: z.RefinementCtx,
): void {
  const exactDuplicates = new Set<string>();
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index]!;
    if (index > 0 && compareWords(words[index - 1]!, current) >= 0) {
      context.addIssue({
        code: "custom",
        path: ["words", index],
        message: "Merged words must be in stable chronological order",
      });
    }
    const duplicateKey = JSON.stringify([current.text, current.sourceStartUs, current.sourceEndUs]);
    if (exactDuplicates.has(duplicateKey)) {
      context.addIssue({
        code: "custom",
        path: ["words", index],
        message: "Merged words cannot contain exact text-and-span duplicates",
      });
    }
    exactDuplicates.add(duplicateKey);
  }
}

function countRetainedOverlaps(words: readonly TranscriptWordV1[]): number {
  let count = 0;
  let furthestEndUs = -1;
  for (const word of words) {
    if (word.sourceStartUs < furthestEndUs) count += 1;
    furthestEndUs = Math.max(furthestEndUs, word.sourceEndUs);
  }
  return count;
}

function countUncertainty(
  words: readonly TranscriptWordV1[],
  removedExactDuplicateWordCount: number,
): TranscriptUncertaintyCountsV1 {
  return {
    missingConfidenceWordCount: words.filter((word) => word.recognitionConfidence === null).length,
    missingSpeakerWordCount: words.filter((word) => word.speakerLabel === null).length,
    estimatedTimingWordCount: words.filter((word) => word.timingProvenance === "estimated").length,
    clampedTimingWordCount: words.filter((word) => word.timingProvenance === "clamped").length,
    retainedOverlapWordCount: countRetainedOverlaps(words),
    removedExactDuplicateWordCount,
  };
}

function preferDuplicate(first: TranscriptWordV1, second: TranscriptWordV1): TranscriptWordV1 {
  const firstConfidence = first.recognitionConfidence ?? -1;
  const secondConfidence = second.recognitionConfidence ?? -1;
  if (firstConfidence !== secondConfidence)
    return firstConfidence > secondConfidence ? first : second;
  return compareWords(first, second) <= 0 ? first : second;
}

function mergeNormalizedWords(chunks: readonly NormalizedTranscriptChunkV1[]): {
  words: TranscriptWordV1[];
  removedExactDuplicateWordCount: number;
} {
  const allWords = chunks.flatMap((chunk) => chunk.words).sort(compareWords);
  const byExactDuplicate = new Map<string, TranscriptWordV1>();
  for (const word of allWords) {
    const key = JSON.stringify([word.text, word.sourceStartUs, word.sourceEndUs]);
    const existing = byExactDuplicate.get(key);
    byExactDuplicate.set(key, existing === undefined ? word : preferDuplicate(existing, word));
  }
  const words = [...byExactDuplicate.values()].sort(compareWords);
  return {
    words,
    removedExactDuplicateWordCount: allWords.length - words.length,
  };
}

function wordsEqual(first: TranscriptWordV1, second: TranscriptWordV1): boolean {
  return (
    first.wordId === second.wordId &&
    first.chunkId === second.chunkId &&
    first.chunkIndex === second.chunkIndex &&
    first.wordIndex === second.wordIndex &&
    first.text === second.text &&
    first.sourceStartUs === second.sourceStartUs &&
    first.sourceEndUs === second.sourceEndUs &&
    first.recognitionConfidence === second.recognitionConfidence &&
    first.speakerLabel === second.speakerLabel &&
    first.speakerConfidence === second.speakerConfidence &&
    first.timingProvenance === second.timingProvenance
  );
}

interface NormalizedTranscriptContent {
  chunks: readonly NormalizedTranscriptChunkV1[];
  words: readonly TranscriptWordV1[];
  uncertaintyCounts: TranscriptUncertaintyCountsV1;
}

function validateNormalizedTranscriptContent(
  transcript: NormalizedTranscriptContent,
  context: z.RefinementCtx,
  sourceDurationUs?: number,
): void {
  validateCanonicalWords(transcript.words, context);
  const seenChunkIds = new Set<string>();
  transcript.chunks.forEach((chunk, index) => {
    if (seenChunkIds.has(chunk.chunkId)) {
      context.addIssue({
        code: "custom",
        path: ["chunks", index, "chunkId"],
        message: "Normalized chunk ids must be unique",
      });
    }
    seenChunkIds.add(chunk.chunkId);
    if (index > 0 && transcript.chunks[index - 1]!.chunkIndex >= chunk.chunkIndex) {
      context.addIssue({
        code: "custom",
        path: ["chunks", index, "chunkIndex"],
        message: "Normalized chunks must have unique indexes in ascending order",
      });
    }
    if (sourceDurationUs !== undefined && chunk.sourceEndUs > sourceDurationUs) {
      context.addIssue({
        code: "custom",
        path: ["chunks", index, "sourceEndUs"],
        message: "Chunk exceeds source duration",
      });
    }
  });

  const expected = mergeNormalizedWords(transcript.chunks);
  if (
    transcript.words.length !== expected.words.length ||
    transcript.words.some((word, index) => !wordsEqual(word, expected.words[index]!))
  ) {
    context.addIssue({
      code: "custom",
      path: ["words"],
      message: "Merged words must be the canonical merge of normalized chunk words",
    });
  }
  transcript.words.forEach((word, index) => {
    if (sourceDurationUs !== undefined && word.sourceEndUs > sourceDurationUs) {
      context.addIssue({
        code: "custom",
        path: ["words", index, "sourceEndUs"],
        message: "Word exceeds source duration",
      });
    }
  });

  const counts = countUncertainty(expected.words, expected.removedExactDuplicateWordCount);
  for (const key of Object.keys(counts) as (keyof TranscriptUncertaintyCountsV1)[]) {
    if (transcript.uncertaintyCounts[key] !== counts[key]) {
      context.addIssue({
        code: "custom",
        path: ["uncertaintyCounts", key],
        message: `${key} does not match the normalized transcript`,
      });
    }
  }
}

export function normalizeTranscriptChunks(
  candidates: readonly TranscriptChunkInputV1[],
  sourceDurationUsCandidate: number,
): NormalizedTranscriptV1 {
  const sourceDurationUs = positiveIntegerSchema.parse(sourceDurationUsCandidate);
  const chunks = z.array(transcriptChunkInputV1Schema).max(10_000).parse(candidates);
  const seenChunkIds = new Set<string>();
  const seenChunkIndexes = new Set<number>();
  const normalizedChunks: NormalizedTranscriptChunkV1[] = [];

  for (const chunk of chunks) {
    if (seenChunkIds.has(chunk.chunkId) || seenChunkIndexes.has(chunk.chunkIndex)) {
      throw new RangeError("Transcript chunk ids and indexes must be unique");
    }
    seenChunkIds.add(chunk.chunkId);
    seenChunkIndexes.add(chunk.chunkIndex);
    const sourceStartUs = Math.max(0, chunk.sourceStartUs);
    const sourceEndUs = Math.min(sourceDurationUs, chunk.sourceEndUs);
    if (sourceEndUs <= sourceStartUs) {
      throw new RangeError(`Transcript chunk ${chunk.chunkId} does not intersect the source`);
    }

    const words: TranscriptWordV1[] = chunk.words.map((rawWord, wordIndex) => {
      const rawStartUs = safeIntegerSchema.parse(chunk.sourceStartUs + rawWord.relativeStartUs);
      const rawEndUs = safeIntegerSchema.parse(chunk.sourceStartUs + rawWord.relativeEndUs);
      const wordStartUs = Math.max(sourceStartUs, rawStartUs);
      const wordEndUs = Math.min(sourceEndUs, rawEndUs);
      if (wordEndUs <= wordStartUs) {
        throw new RangeError(
          `Transcript word ${wordIndex} in chunk ${chunk.chunkId} has no positive source intersection`,
        );
      }
      const wasClamped = wordStartUs !== rawStartUs || wordEndUs !== rawEndUs;
      return transcriptWordV1Schema.parse({
        wordId: `${chunk.chunkId}:${wordIndex}`,
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        wordIndex,
        text: rawWord.text,
        sourceStartUs: wordStartUs,
        sourceEndUs: wordEndUs,
        recognitionConfidence: rawWord.recognitionConfidence,
        speakerLabel: rawWord.speakerLabel,
        speakerConfidence: rawWord.speakerConfidence,
        timingProvenance: wasClamped ? "clamped" : rawWord.timingProvenance,
      });
    });
    normalizedChunks.push({
      schemaVersion: 1,
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      sourceStartUs,
      sourceEndUs,
      words,
    });
  }

  normalizedChunks.sort((first, second) => first.chunkIndex - second.chunkIndex);
  const { words, removedExactDuplicateWordCount } = mergeNormalizedWords(normalizedChunks);
  return normalizedTranscriptV1Schema.parse({
    schemaVersion: 1,
    chunks: normalizedChunks,
    words,
    uncertaintyCounts: countUncertainty(words, removedExactDuplicateWordCount),
  });
}

export interface CreateTranscriptArtifactV1Input {
  sourceIdentity: z.infer<typeof mediaContentIdentityV1Schema>;
  sourceFingerprint: SourceFingerprintV1;
  sourceDurationUs: number;
  configuration: AsrConfigurationV1;
  chunks: readonly TranscriptChunkInputV1[];
}

export async function createTranscriptArtifactV1(
  candidate: CreateTranscriptArtifactV1Input,
): Promise<TranscriptArtifactV1> {
  const sourceDurationUs = positiveIntegerSchema.parse(candidate.sourceDurationUs);
  const configuration = asrConfigurationV1Schema.parse(candidate.configuration);
  const configurationIdentity = await deriveAsrConfigurationIdentity(configuration);
  const identity = await deriveTranscriptArtifactIdentity({
    sourceIdentity: candidate.sourceIdentity,
    sourceFingerprint: candidate.sourceFingerprint,
    configurationIdentity,
  });
  const normalized = normalizeTranscriptChunks(candidate.chunks, sourceDurationUs);
  return transcriptArtifactV1Schema.parse({
    schemaVersion: 1,
    identity,
    sourceDurationUs,
    configuration,
    chunks: normalized.chunks,
    words: normalized.words,
    uncertaintyCounts: normalized.uncertaintyCounts,
  });
}
