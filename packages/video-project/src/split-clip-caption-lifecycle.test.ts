import {
  VideoDomainError,
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectCommandV2,
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
  prepareSplitClipCaptionLifecycleV1,
  prepareTranscriptEditCaptionLifecycleV1,
  type SplitClipCommandV2,
} from "./split-clip-caption-lifecycle.js";

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
  rightClip: id(8),
  splitCommand: id(9),
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
  const words = [
    { wordId: "chunk-0:0", text: "one", sourceStartUs: 0, sourceEndUs: 200_000 },
    { wordId: "chunk-0:1", text: "two", sourceStartUs: 200_000, sourceEndUs: 400_000 },
    { wordId: "chunk-0:2", text: "three", sourceStartUs: 400_000, sourceEndUs: 600_000 },
  ].map((word, wordIndex) => ({
    ...word,
    chunkId: "chunk-0",
    chunkIndex: 0,
    wordIndex,
    recognitionConfidence: 1,
    speakerLabel: "speaker-1",
    speakerConfidence: 1,
    timingProvenance: "aligned" as const,
  }));
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
        words,
      },
    ],
    words,
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

function captionArtifact(captionTrackId = ids.captionTrack): CaptionArtifactV1 {
  const sourceLink = (
    sourceStartUs: number,
    sourceEndUs: number,
    transcriptWordIds: readonly string[],
  ) => ({
    transcriptArtifactIdentityKey: transcriptKey,
    sourceStartUs,
    sourceEndUs,
    transcriptWordIds,
  });
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
      maxLinesPerCue: 4,
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
        end: createRationalTime(12, rate),
        lines: ["one"],
        anchor: { xPermille: 500, yPermille: 900 },
        sourceLinks: [sourceLink(0, 200_000, ["chunk-0:0"])],
      },
      {
        schemaVersion: 1,
        cueId: "cue-2",
        start: createRationalTime(12, rate),
        end: createRationalTime(16, rate),
        lines: ["two three"],
        anchor: { xPermille: 500, yPermille: 900 },
        sourceLinks: [sourceLink(200_000, 600_000, ["chunk-0:1", "chunk-0:2"])],
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
    name: "Split lifecycle fixture",
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

function splitCommand(splitAt = 1): SplitClipCommandV2 {
  return {
    type: "SplitClip",
    commandId: ids.splitCommand,
    sequenceId: ids.sequence,
    trackId: ids.sourceTrack,
    clipId: ids.clip,
    splitAt: createRationalTime(splitAt, rate),
    rightClipId: ids.rightClip,
  };
}

function expectReason(action: () => unknown, reason: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect((failure as VideoDomainError).details.reason).toBe(reason);
}

describe("split caption lifecycle", () => {
  it("stitches a split inside one word and returns only the unchanged SplitClip", () => {
    const inputProjection = projection();
    const command = splitCommand(1);
    const before = JSON.stringify(inputProjection);
    const prepared = prepareSplitClipCaptionLifecycleV1({
      projection: inputProjection,
      transcriptArtifact: transcript(),
      command,
    });

    expect(prepared).toEqual([command]);
    expect(JSON.stringify(inputProjection)).toBe(before);
  });

  it("keeps artifacts invariant when splitting exactly between words and cues", () => {
    const command = splitCommand(2);
    expect(
      prepareSplitClipCaptionLifecycleV1({
        projection: projection(),
        transcriptArtifact: transcript(),
        command,
      }),
    ).toEqual([command]);
  });

  it("returns the bare split without transcript lineage when captions are inactive", () => {
    const command = splitCommand();
    expect(prepareSplitClipCaptionLifecycleV1({ projection: projection([]), command })).toEqual([
      command,
    ]);
  });

  it("fails closed for missing, wrong, and stale caption lineage", () => {
    expectReason(
      () =>
        prepareSplitClipCaptionLifecycleV1({ projection: projection(), command: splitCommand() }),
      "caption_lifecycle_transcript_missing",
    );

    const wrongTranscript = structuredClone(transcript());
    wrongTranscript.identity.key = "cd".repeat(32);
    expectReason(
      () =>
        prepareSplitClipCaptionLifecycleV1({
          projection: projection(),
          transcriptArtifact: wrongTranscript,
          command: splitCommand(),
        }),
      "caption_lifecycle_transcript_lineage_mismatch",
    );

    const staleProjection = projection();
    const captionTrack = staleProjection.state.sequences[0]!.tracks[1]!;
    if (captionTrack.kind !== "caption" || captionTrack.activeCaptionArtifact === undefined)
      throw new Error("Invalid fixture");
    captionTrack.activeCaptionArtifact.trackLink.projectRevision = revision(8);
    expectReason(
      () =>
        prepareSplitClipCaptionLifecycleV1({
          projection: staleProjection,
          transcriptArtifact: transcript(),
          command: splitCommand(),
        }),
      "caption_lifecycle_caption_revision_stale",
    );
  });

  it("fails closed for duplicate and inexact split geometry", () => {
    const duplicate = splitCommand();
    duplicate.rightClipId = ids.clip;
    expectReason(
      () =>
        prepareSplitClipCaptionLifecycleV1({
          projection: projection(),
          transcriptArtifact: transcript(),
          command: duplicate,
        }),
      "caption_lifecycle_duplicate_generated_clip_id",
    );

    const inexactProjection = projection();
    const sourceTrack = inexactProjection.state.sequences[0]!.tracks[0]!;
    if (sourceTrack.kind === "caption") throw new Error("Invalid fixture");
    sourceTrack.clips[0]!.timelineStart = createRationalTime(10, { numerator: 3, denominator: 1 });
    expectReason(
      () =>
        prepareSplitClipCaptionLifecycleV1({
          projection: inexactProjection,
          transcriptArtifact: transcript(),
          command: splitCommand(1),
        }),
      "caption_lifecycle_split_geometry_inexact",
    );
  });

  it("replays a complete split-delete group and appends caption application last", async () => {
    const commands: ProjectCommandV2[] = [
      splitCommand(2),
      {
        type: "SplitClip",
        commandId: id(20),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: ids.rightClip,
        splitAt: createRationalTime(4, rate),
        rightClipId: id(21),
      },
      {
        type: "RippleDeleteClip",
        commandId: id(22),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: ids.rightClip,
      },
    ];
    const prepared = await prepareTranscriptEditCaptionLifecycleV1({
      projection: projection(),
      transcriptArtifact: transcript(),
      commands,
      createCommandId: () => id(23),
    });

    expect(prepared.map(({ type }) => type)).toEqual([
      "SplitClip",
      "SplitClip",
      "RippleDeleteClip",
      "ApplyCaptionArtifact",
    ]);
    const apply = prepared.at(-1);
    expect(apply?.type).toBe("ApplyCaptionArtifact");
    if (apply?.type !== "ApplyCaptionArtifact") throw new Error("Missing caption command");
    expect(apply.artifact.cues).not.toEqual(captionArtifact().cues);
    expect(apply.artifact.cues.some(({ start }) => start.value < 14)).toBe(true);
  });

  it("preserves descending multi-segment geometry before the final caption application", async () => {
    const commands: ProjectCommandV2[] = [
      { ...splitCommand(4), rightClipId: id(31) },
      {
        type: "SplitClip",
        commandId: id(32),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: id(31),
        splitAt: createRationalTime(5, rate),
        rightClipId: id(33),
      },
      {
        type: "RippleDeleteClip",
        commandId: id(34),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: id(31),
      },
      { ...splitCommand(1), commandId: id(35), rightClipId: id(36) },
      {
        type: "SplitClip",
        commandId: id(37),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: id(36),
        splitAt: createRationalTime(2, rate),
        rightClipId: id(38),
      },
      {
        type: "RippleDeleteClip",
        commandId: id(39),
        sequenceId: ids.sequence,
        trackId: ids.sourceTrack,
        clipId: id(36),
      },
    ];

    const prepared = await prepareTranscriptEditCaptionLifecycleV1({
      projection: projection(),
      transcriptArtifact: transcript(),
      commands,
      createCommandId: () => id(40),
    });

    expect(prepared.slice(0, -1)).toEqual(commands);
    expect(prepared.at(-1)?.type).toBe("ApplyCaptionArtifact");
  });
  it("keeps caption-free geometry unchanged", async () => {
    const commands: ProjectCommandV2[] = [splitCommand(2)];
    const prepared = await prepareTranscriptEditCaptionLifecycleV1({
      projection: projection([]),
      commands,
      createCommandId: () => id(30),
    });
    expect(prepared).toEqual(commands);
  });

  it("appends multiple caption tracks deterministically and rejects 101 commands", async () => {
    const inputProjection = projection([ids.captionTrack, ids.secondCaptionTrack]);
    const prepare = () =>
      prepareTranscriptEditCaptionLifecycleV1({
        projection: inputProjection,
        transcriptArtifact: transcript(),
        commands: [splitCommand(2)],
        createCommandId: (trackId, ordinal) =>
          `${trackId.slice(0, 24)}${String(ordinal + 40).padStart(12, "0")}`,
      });
    const first = await prepare();
    const second = await prepare();
    expect(first).toEqual(second);
    expect(
      first
        .slice(1)
        .map((command) => (command.type === "ApplyCaptionArtifact" ? command.trackId : undefined)),
    ).toEqual([ids.captionTrack, ids.secondCaptionTrack]);

    const tooMany = Array.from({ length: 99 }, (_, index) => ({
      ...splitCommand(2),
      commandId: id(1000 + index),
      rightClipId: id(2000 + index),
    }));
    let failure: unknown;
    try {
      await prepareTranscriptEditCaptionLifecycleV1({
        projection: inputProjection,
        transcriptArtifact: transcript(),
        commands: tooMany,
        createCommandId: () => id(50),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(VideoDomainError);
    expect((failure as VideoDomainError).details.reason).toBe(
      "caption_lifecycle_command_limit_exceeded",
    );
  });
});
