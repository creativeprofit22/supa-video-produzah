// Test-only fixtures for proposal producer, rule and lifecycle tests.
// Not exported from the package entry point.
import {
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectClip,
  type ProjectProjection,
} from "@supa-video/contracts";
import { transcriptArtifactV1Schema, type TranscriptArtifactV1 } from "@supa-video/media";

export const fixtureRate = { numerator: 10, denominator: 1 } as const;

export function fixtureId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

export const fixtureSourceIdentity: MediaContentIdentityV1 = Object.freeze({
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
});

export interface FixtureWord {
  readonly startUs: number;
  readonly endUs: number;
  readonly text?: string;
}

export function fixtureArtifact(
  words: readonly FixtureWord[],
  language: string | null = "en",
): TranscriptArtifactV1 {
  const duration = Math.max(1_000_000, ...words.map(({ endUs }) => endUs + 100_000));
  const normalizedWords = words.map((word, wordIndex) => ({
    wordId: `words:${wordIndex}`,
    chunkId: "words",
    chunkIndex: 0,
    wordIndex,
    text: word.text ?? `word-${wordIndex}`,
    sourceStartUs: word.startUs,
    sourceEndUs: word.endUs,
    recognitionConfidence: 1,
    speakerLabel: "speaker-1",
    speakerConfidence: 1,
    timingProvenance: "aligned" as const,
  }));
  let retainedOverlapWordCount = 0;
  let furthestEndUs = -1;
  for (const word of normalizedWords) {
    if (word.sourceStartUs < furthestEndUs) retainedOverlapWordCount += 1;
    furthestEndUs = Math.max(furthestEndUs, word.sourceEndUs);
  }
  return transcriptArtifactV1Schema.parse({
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      key: "ab".repeat(32),
      sourceIdentity: fixtureSourceIdentity,
      sourceFingerprint: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "23".repeat(32),
        byteLength: fixtureSourceIdentity.byteLength,
        modifiedUnixSeconds: 1_720_000_000,
        modifiedNanoseconds: 123_456_789,
      },
      configurationIdentity: { schemaVersion: 1, algorithm: "sha256", digest: "34".repeat(32) },
    },
    sourceDurationUs: duration,
    configuration: {
      schemaVersion: 1,
      engineId: "fixture-asr",
      engineVersion: "1.0.0",
      modelId: "fixture-model",
      modelRevision: "fixture-revision",
      requestedLanguage: language,
      task: "transcribe",
      wordTimingRequired: true,
      speakerDiarizationMode: "optional",
      chunkDurationUs: duration,
      chunkOverlapUs: 0,
      providerSettings: [],
    },
    chunks: [
      {
        schemaVersion: 1,
        chunkId: "words",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: duration,
        words: normalizedWords,
      },
    ],
    words: normalizedWords,
    uncertaintyCounts: {
      missingConfidenceWordCount: 0,
      missingSpeakerWordCount: 0,
      estimatedTimingWordCount: 0,
      clampedTimingWordCount: 0,
      retainedOverlapWordCount,
      removedExactDuplicateWordCount: 0,
    },
  });
}

export function fixtureClip(
  value: number,
  sourceIn: number,
  sourceOut: number,
  timelineStart = 0,
): ProjectClip {
  return {
    id: fixtureId(value),
    source: { kind: "asset", assetId: fixtureId(1) },
    timelineStart: createRationalTime(timelineStart, fixtureRate),
    sourceIn: createRationalTime(sourceIn, fixtureRate),
    sourceOut: createRationalTime(sourceOut, fixtureRate),
    transform: {
      positionXPermille: 0,
      positionYPermille: 0,
      scaleXPermille: 1_000,
      scaleYPermille: 1_000,
      rotationMilliDegrees: 0,
      opacityPermille: 1_000,
    },
    gainMilliDecibels: 0,
  };
}

export function fixtureProjection(
  clips: readonly ProjectClip[] = [fixtureClip(100, 0, 100)],
  options: { readonly revisionNumber?: number; readonly locked?: boolean } = {},
): ProjectProjection {
  const revisionNumber = options.revisionNumber ?? 7;
  return {
    projectId: fixtureId(900_001),
    name: "Proposal fixture",
    revision: {
      number: revisionNumber,
      id: fixtureId(900_100 + revisionNumber),
      parentId: revisionNumber === 0 ? null : fixtureId(900_099 + revisionNumber),
      committedAt: `2026-08-${String(revisionNumber + 1).padStart(2, "0")}T12:00:00.000Z`,
      operationId: fixtureId(900_200 + revisionNumber),
      stateHash: revisionNumber.toString(16).padStart(64, "0"),
    },
    state: {
      assets: [
        {
          id: fixtureId(1),
          displayName: "source.mp4",
          locator: { absolutePath: "/media/source.mp4" },
          probe: {
            durationMicroseconds: 100_000_000,
            averageFrameRate: fixtureRate,
            realFrameRate: fixtureRate,
            variableFrameRate: false,
            width: 1920,
            height: 1080,
            videoCodecName: "h264",
            audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
            fileSizeBytes: fixtureSourceIdentity.byteLength,
          },
          contentIdentity: fixtureSourceIdentity,
        },
      ],
      sequences: [
        {
          id: fixtureId(2),
          name: "Main sequence",
          rate: fixtureRate,
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks: [
            {
              id: fixtureId(10),
              name: "Video",
              kind: "video",
              ...(options.locked === undefined ? {} : { locked: options.locked }),
              clips: [...clips],
            },
          ],
          markers: [],
        },
      ],
      activeSequenceId: fixtureId(2),
    },
    canUndo: true,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: revisionNumber,
    recoveryStatus: "clean",
    replayedRecordCount: revisionNumber,
  };
}

export function fixtureScope(
  artifact: TranscriptArtifactV1,
  projection: ProjectProjection,
): {
  readonly artifact: TranscriptArtifactV1;
  readonly projection: ProjectProjection;
  readonly sequenceId: string;
  readonly trackId: string;
} {
  return { artifact, projection, sequenceId: fixtureId(2), trackId: fixtureId(10) };
}
