import {
  VideoDomainError,
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type ProjectTrack,
} from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  transcriptArtifactV1Schema,
  type CaptionArtifactV1,
  type TranscriptArtifactV1,
} from "@supa-video/media";
import { describe, expect, it } from "vitest";

import {
  prepareMoveClipCaptionLifecycleV1,
  type MoveClipCommandV2,
} from "./move-clip-caption-lifecycle.js";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const ids = {
  project: id(1),
  asset: id(2),
  sequence: id(3),
  sourceTrack: id(4),
  captionTrack: id(5),
  secondCaptionTrack: id(6),
  clip: id(7),
  moveCommand: id(8),
} as const;
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};
const transcriptKey = "ab".repeat(32);

function revision(number: number): ProjectRevisionDescriptorV2 {
  return {
    number,
    id: id(100 + number),
    parentId: number === 0 ? null : id(99 + number),
    committedAt: `2026-08-${String(number + 1).padStart(2, "0")}T12:00:00.000Z`,
    operationId: id(200 + number),
    stateHash: number.toString(16).padStart(64, "0"),
  };
}

function transcript(): TranscriptArtifactV1 {
  const word = {
    wordId: "chunk-0:0",
    chunkId: "chunk-0",
    chunkIndex: 0,
    wordIndex: 0,
    text: "caption",
    sourceStartUs: 0,
    sourceEndUs: 600_000,
    recognitionConfidence: 1,
    speakerLabel: "speaker-1",
    speakerConfidence: 1,
    timingProvenance: "aligned" as const,
  };
  return transcriptArtifactV1Schema.parse({
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      key: transcriptKey,
      sourceIdentity,
      sourceFingerprint: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "23".repeat(32),
        byteLength: sourceIdentity.byteLength,
        modifiedUnixSeconds: 1_720_000_000,
        modifiedNanoseconds: 123_456_789,
      },
      configurationIdentity: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "34".repeat(32),
      },
    },
    sourceDurationUs: 1_000_000,
    configuration: {
      schemaVersion: 1,
      engineId: "fixture-asr",
      engineVersion: "1.0.0",
      modelId: "fixture-model",
      modelRevision: "fixture-revision",
      requestedLanguage: "en",
      task: "transcribe",
      wordTimingRequired: true,
      speakerDiarizationMode: "optional",
      chunkDurationUs: 1_000_000,
      chunkOverlapUs: 0,
      providerSettings: [],
    },
    chunks: [
      {
        schemaVersion: 1,
        chunkId: "chunk-0",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: 1_000_000,
        words: [word],
      },
    ],
    words: [word],
    uncertaintyCounts: {
      missingConfidenceWordCount: 0,
      missingSpeakerWordCount: 0,
      estimatedTimingWordCount: 0,
      clampedTimingWordCount: 0,
      retainedOverlapWordCount: 0,
      removedExactDuplicateWordCount: 0,
    },
  });
}

function captionArtifact(captionTrackId: string): CaptionArtifactV1 {
  return captionArtifactV1Schema.parse({
    schemaVersion: 1,
    trackLink: {
      schemaVersion: 1,
      projectId: ids.project,
      projectRevision: revision(7),
      sequenceId: ids.sequence,
      captionTrackId,
    },
    sourceIdentity,
    transcriptArtifactIdentityKey: transcriptKey,
    language: "en-US",
    timelineRate: rate,
    style: {
      schemaVersion: 1,
      typography: {
        fontFamily: "Inter",
        fontSizePx: 48,
        fontWeight: 600,
        fontStyle: "normal",
        lineHeightPermille: 1_200,
        foregroundColorRgba: "#ffffffff",
      },
      alignment: { horizontal: "center", vertical: "bottom" },
    },
    validationProfile: {
      schemaVersion: 1,
      maxLinesPerCue: 2,
      maxCharactersPerLine: 100,
      maxCharactersPerSecond: 1_000,
      minimumCueDuration: createRationalTime(0, rate),
      maximumCueDuration: createRationalTime(100, rate),
      safeArea: {
        topPermille: 30,
        rightPermille: 80,
        bottomPermille: 70,
        leftPermille: 40,
      },
    },
    cues: [
      {
        schemaVersion: 1,
        cueId: "cue-1",
        start: createRationalTime(10, rate),
        end: createRationalTime(16, rate),
        lines: ["caption"],
        anchor: { xPermille: 500, yPermille: 900 },
        sourceLinks: [
          {
            transcriptArtifactIdentityKey: transcriptKey,
            sourceStartUs: 0,
            sourceEndUs: 600_000,
            transcriptWordIds: ["chunk-0:0"],
          },
        ],
      },
    ],
  });
}

function projection(captionTrackIds: readonly string[] = [ids.captionTrack]): ProjectProjection {
  const tracks: ProjectTrack[] = [
    {
      id: ids.sourceTrack,
      name: "Video",
      kind: "video",
      clips: [
        {
          id: ids.clip,
          source: { kind: "asset", assetId: ids.asset },
          timelineStart: createRationalTime(10, rate),
          sourceIn: createRationalTime(0, rate),
          sourceOut: createRationalTime(6, rate),
          transform: {
            positionXPermille: 0,
            positionYPermille: 0,
            scaleXPermille: 1_000,
            scaleYPermille: 1_000,
            rotationMilliDegrees: 0,
            opacityPermille: 1_000,
          },
          gainMilliDecibels: 0,
        },
      ],
    },
    ...captionTrackIds.map((captionTrackId): ProjectTrack => ({
      id: captionTrackId,
      name: `Captions ${captionTrackId}`,
      kind: "caption",
      captions: [],
      activeCaptionArtifact: captionArtifact(captionTrackId),
    })),
  ];
  return {
    projectId: ids.project,
    name: "Move lifecycle fixture",
    revision: revision(8),
    state: {
      assets: [
        {
          id: ids.asset,
          displayName: "source.mp4",
          locator: { absolutePath: "/media/source.mp4" },
          probe: {
            durationMicroseconds: 1_000_000,
            averageFrameRate: rate,
            realFrameRate: rate,
            variableFrameRate: false,
            width: 1_920,
            height: 1_080,
            videoCodecName: "h264",
            audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
            fileSizeBytes: sourceIdentity.byteLength,
          },
          contentIdentity: sourceIdentity,
        },
      ],
      sequences: [
        {
          id: ids.sequence,
          name: "Main",
          rate,
          width: 1_920,
          height: 1_080,
          audioSampleRate: 48_000,
          tracks,
          markers: [],
        },
      ],
      activeSequenceId: ids.sequence,
    },
    canUndo: true,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: 8,
    recoveryStatus: "clean",
    replayedRecordCount: 8,
  };
}

function moveCommand(timelineStart = 20): MoveClipCommandV2 {
  return {
    type: "MoveClip",
    commandId: ids.moveCommand,
    sequenceId: ids.sequence,
    trackId: ids.sourceTrack,
    clipId: ids.clip,
    timelineStart: createRationalTime(timelineStart, rate),
  };
}

async function expectReason(action: () => Promise<unknown>, reason: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect((failure as VideoDomainError).details.reason).toBe(reason);
}

function sourceTrack(input: ProjectProjection) {
  const track = input.state.sequences[0]!.tracks[0]!;
  if (track.kind === "caption") throw new Error("Expected source track");
  return track;
}

function captionTrack(input: ProjectProjection, index = 1) {
  const track = input.state.sequences[0]!.tracks[index]!;
  if (track.kind !== "caption") throw new Error("Expected caption track");
  return track;
}

describe("move clip caption lifecycle", () => {
  it("replays the move and appends every remapped caption artifact deterministically", async () => {
    const inputProjection = projection([ids.captionTrack, ids.secondCaptionTrack]);
    const before = JSON.stringify(inputProjection);
    const prepare = () =>
      prepareMoveClipCaptionLifecycleV1({
        projection: inputProjection,
        transcriptArtifact: transcript(),
        command: moveCommand(),
        createCommandId: (trackId, ordinal) =>
          `${trackId.slice(0, 24)}${String(ordinal + 40).padStart(12, "0")}`,
      });

    const first = await prepare();
    const second = await prepare();

    expect(first).toEqual(second);
    expect(first.map(({ type }) => type)).toEqual([
      "MoveClip",
      "ApplyCaptionArtifact",
      "ApplyCaptionArtifact",
    ]);
    expect(
      first.slice(1).map((command) =>
        command.type === "ApplyCaptionArtifact"
          ? {
              trackId: command.trackId,
              start: command.artifact.cues[0]?.start.value,
              end: command.artifact.cues[0]?.end.value,
            }
          : null,
      ),
    ).toEqual([
      { trackId: ids.captionTrack, start: 20, end: 26 },
      { trackId: ids.secondCaptionTrack, start: 20, end: 26 },
    ]);
    expect(JSON.stringify(inputProjection)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("preserves the bare MoveClip fallback when no caption artifact is active", async () => {
    const command = moveCommand();
    await expect(
      prepareMoveClipCaptionLifecycleV1({
        projection: projection([]),
        command,
        createCommandId: () => id(40),
      }),
    ).resolves.toEqual([command]);

    const lockedWithoutCaptions = projection([]);
    sourceTrack(lockedWithoutCaptions).locked = true;
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: lockedWithoutCaptions,
          command,
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_source_track_locked",
    );
  });

  it("fails closed for missing, stale, ambiguous, and mismatched lineage", async () => {
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: projection(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_transcript_missing",
    );

    const stale = projection();
    captionTrack(stale).activeCaptionArtifact!.trackLink.projectRevision = revision(8);
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: stale,
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_caption_revision_stale",
    );

    const ambiguous = projection();
    ambiguous.state.assets.push({ ...structuredClone(ambiguous.state.assets[0]!), id: id(50) });
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: ambiguous,
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_source_lineage_ambiguous",
    );

    const wrongTranscript = structuredClone(transcript());
    wrongTranscript.identity.key = "cd".repeat(32);
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: projection(),
          transcriptArtifact: wrongTranscript,
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_transcript_lineage_mismatch",
    );
  });

  it("rejects locked source and caption targets before preparing commands", async () => {
    const lockedSource = projection();
    sourceTrack(lockedSource).locked = true;
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: lockedSource,
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_source_track_locked",
    );

    const lockedCaption = projection();
    captionTrack(lockedCaption).locked = true;
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: lockedCaption,
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_caption_track_locked",
    );
  });

  it("rejects invalid, inexact, and unsafe move geometry", async () => {
    const invalidRate = moveCommand();
    invalidRate.timelineStart = createRationalTime(20, { numerator: 20, denominator: 1 });
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: projection(),
          transcriptArtifact: transcript(),
          command: invalidRate,
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_move_geometry_invalid",
    );

    const inexact = projection();
    sourceTrack(inexact).clips[0]!.sourceIn = createRationalTime(0, {
      numerator: 3,
      denominator: 1,
    });
    sourceTrack(inexact).clips[0]!.sourceOut = createRationalTime(1, {
      numerator: 3,
      denominator: 1,
    });
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: inexact,
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_move_geometry_inexact",
    );

    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: projection(),
          transcriptArtifact: transcript(),
          command: moveCommand(Number.MAX_SAFE_INTEGER),
          createCommandId: () => id(40),
        }),
      "caption_lifecycle_unsafe_integer",
    );
  });

  it("rejects more than 100 atomic commands before allocating caption command IDs", async () => {
    const captionTrackIds = Array.from({ length: 100 }, (_, index) => id(1_000 + index));
    let allocated = 0;
    await expectReason(
      () =>
        prepareMoveClipCaptionLifecycleV1({
          projection: projection(captionTrackIds),
          transcriptArtifact: transcript(),
          command: moveCommand(),
          createCommandId: () => {
            allocated += 1;
            return id(40);
          },
        }),
      "caption_lifecycle_command_limit_exceeded",
    );
    expect(allocated).toBe(0);
  });
});
