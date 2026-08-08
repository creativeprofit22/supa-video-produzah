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
  prepareTrimClipCaptionLifecycleV1,
  type PrepareTrimClipCaptionLifecycleV1Input,
} from "./trim-clip-caption-lifecycle.js";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const ids = {
  project: id(1),
  asset: id(2),
  sequence: id(3),
  sourceTrack: id(4),
  captionTrack: id(5),
  clip: id(6),
  trimCommand: id(7),
  applyCommand: id(8),
  group: id(9),
  unknown: id(10),
} as const;
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};
const artifactIdentityKey = "ab".repeat(32);

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
      key: artifactIdentityKey,
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

function captionArtifact(): CaptionArtifactV1 {
  return captionArtifactV1Schema.parse({
    schemaVersion: 1,
    trackLink: {
      schemaVersion: 1,
      projectId: ids.project,
      projectRevision: revision(7),
      sequenceId: ids.sequence,
      captionTrackId: ids.captionTrack,
    },
    sourceIdentity,
    transcriptArtifactIdentityKey: artifactIdentityKey,
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
        end: createRationalTime(16, rate),
        lines: ["one two three"],
        anchor: { xPermille: 500, yPermille: 900 },
        sourceLinks: [
          {
            transcriptArtifactIdentityKey: artifactIdentityKey,
            sourceStartUs: 0,
            sourceEndUs: 600_000,
            transcriptWordIds: ["chunk-0:0", "chunk-0:1", "chunk-0:2"],
          },
        ],
      },
    ],
  });
}

function fixture() {
  const activeCaptionArtifact = captionArtifact();
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
    {
      id: ids.captionTrack,
      name: "Captions",
      kind: "caption",
      captions: [],
      activeCaptionArtifact,
    },
  ];
  const projection: ProjectProjection = {
    projectId: ids.project,
    name: "Lifecycle fixture",
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
  return {
    projection,
    transcript: transcript(),
    trimCommand: {
      type: "TrimClip" as const,
      commandId: ids.trimCommand,
      sequenceId: ids.sequence,
      trackId: ids.sourceTrack,
      clipId: ids.clip,
      sourceIn: createRationalTime(1, rate),
      sourceOut: createRationalTime(5, rate),
    },
    captionTrackId: ids.captionTrack,
    groupId: ids.group,
    applyCaptionArtifactCommandId: ids.applyCommand,
  };
}

function captionTrack(input: ReturnType<typeof fixture>) {
  const track = input.projection.state.sequences[0]!.tracks[1]!;
  if (track.kind !== "caption") throw new Error("Fixture caption track is invalid");
  return track;
}

function sourceTrack(input: ReturnType<typeof fixture>) {
  const track = input.projection.state.sequences[0]!.tracks[0]!;
  if (track.kind === "caption") throw new Error("Fixture source track is invalid");
  return track;
}

function expectFailure(input: PrepareTrimClipCaptionLifecycleV1Input, reason: string): void {
  let failure: unknown;
  try {
    prepareTrimClipCaptionLifecycleV1(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect((failure as VideoDomainError).details.reason).toBe(reason);
}

describe("prepareTrimClipCaptionLifecycleV1", () => {
  it("prepares one deterministic atomic trim and corrected caption group without mutation", () => {
    const input = fixture();
    const before = JSON.stringify(input);

    const first = prepareTrimClipCaptionLifecycleV1(input);
    const second = prepareTrimClipCaptionLifecycleV1(input);
    const applyCommand = first.commandGroup.commands[1];

    expect(first).toEqual(second);
    expect(first.commandGroup.baseRevision).toBe(8);
    expect(first.commandGroup.commands).toHaveLength(2);
    expect(first.commandGroup.commands.map(({ type }) => type)).toEqual([
      "TrimClip",
      "ApplyCaptionArtifact",
    ]);
    expect(first.commandGroup.commands[0]).toEqual(input.trimCommand);
    expect(applyCommand?.type).toBe("ApplyCaptionArtifact");
    if (applyCommand?.type !== "ApplyCaptionArtifact") throw new Error("Missing apply command");
    expect(applyCommand.artifact.trackLink.projectRevision).toEqual(input.projection.revision);
    expect(applyCommand.artifact.cues[0]!.start.value).toBe(10);
    expect(applyCommand.artifact.cues[0]!.end.value).toBe(14);
    expect(first.report.cues).toEqual([
      {
        sourceCueId: "cue-1",
        outcome: "trimmed",
        targetCues: [
          {
            cueId: "cue-1",
            start: createRationalTime(10, rate),
            end: createRationalTime(14, rate),
          },
        ],
      },
    ]);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.commandGroup.commands)).toBe(true);
  });

  it.each([
    ["invalid geometry", "trim_geometry_invalid", (input: ReturnType<typeof fixture>) => {
      input.trimCommand.sourceOut = createRationalTime(1, rate);
    }],
    ["out-of-media geometry", "trim_geometry_invalid", (input: ReturnType<typeof fixture>) => {
      input.trimCommand.sourceOut = createRationalTime(11, rate);
    }],
    ["unrelated target clip", "trim_clip_source_lineage_mismatch", (input: ReturnType<typeof fixture>) => {
      const targetAsset = input.projection.state.assets[0]!;
      input.projection.state.assets.push({
        ...structuredClone(targetAsset),
        id: ids.unknown,
      });
      targetAsset.contentIdentity = {
        ...targetAsset.contentIdentity!,
        digest: "ef".repeat(32),
      };
    }],
    ["no-op geometry", "trim_geometry_no_op", (input: ReturnType<typeof fixture>) => {
      input.trimCommand.sourceIn = createRationalTime(0, rate);
      input.trimCommand.sourceOut = createRationalTime(6, rate);
    }],
    ["missing source track", "trim_source_track_missing", (input: ReturnType<typeof fixture>) => {
      input.trimCommand.trackId = ids.unknown;
    }],
    ["locked source track", "trim_source_track_locked", (input: ReturnType<typeof fixture>) => {
      sourceTrack(input).locked = true;
    }],
    ["missing caption track", "caption_track_missing", (input: ReturnType<typeof fixture>) => {
      input.captionTrackId = ids.unknown;
    }],
    ["locked caption track", "caption_track_locked", (input: ReturnType<typeof fixture>) => {
      captionTrack(input).locked = true;
    }],
    ["missing active artifact", "active_caption_artifact_missing", (input: ReturnType<typeof fixture>) => {
      delete captionTrack(input).activeCaptionArtifact;
    }],
    ["equal artifact revision", "caption_remap_stale_revision", (input: ReturnType<typeof fixture>) => {
      captionTrack(input).activeCaptionArtifact!.trackLink.projectRevision = revision(8);
    }],
    ["transcript key mismatch", "caption_transcript_lineage_mismatch", (input: ReturnType<typeof fixture>) => {
      input.transcript.identity.key = "cd".repeat(32);
    }],
    ["source identity mismatch", "caption_transcript_lineage_mismatch", (input: ReturnType<typeof fixture>) => {
      input.transcript.identity.sourceIdentity.digest = "ef".repeat(32);
    }],
    ["unsatisfied remap constraint", "caption_remap_constraints_unsatisfied", (input: ReturnType<typeof fixture>) => {
      const artifact = captionTrack(input).activeCaptionArtifact!;
      artifact.validationProfile.maxLinesPerCue = 1;
      artifact.validationProfile.maxCharactersPerLine = 2;
      artifact.cues[0]!.lines = ["ok"];
    }],
  ] as const)("fails closed for %s", (_name, reason, mutate) => {
    const input = fixture();
    mutate(input);
    const before = JSON.stringify(input);

    expectFailure(input, reason);
    expect(JSON.stringify(input)).toBe(before);
  });
});
