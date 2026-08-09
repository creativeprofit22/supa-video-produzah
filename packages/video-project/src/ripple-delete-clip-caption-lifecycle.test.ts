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
  prepareRippleDeleteClipCaptionLifecycleV1,
  type PrepareRippleDeleteClipCaptionLifecycleV1Input,
} from "./ripple-delete-clip-caption-lifecycle.js";
import type { RippleDeleteClipCommandV2 } from "./split-clip-caption-lifecycle.js";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const ids = {
  project: id(1),
  sequence: id(2),
  sourceTrack: id(3),
  captionA: id(4),
  captionA2: id(5),
  captionB: id(6),
  assetA: id(7),
  assetB: id(8),
  target: id(9),
  later: id(10),
  third: id(11),
  command: id(12),
  unknown: id(13),
} as const;
const keyA = "ab".repeat(32);
const keyB = "cd".repeat(32);

function identity(byte: string, byteLength = 3_000): MediaContentIdentityV1 {
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: byte.repeat(32),
    byteLength,
  };
}
const sourceA = identity("12");
const sourceB = identity("34");

function revision(number: number): ProjectRevisionDescriptorV2 {
  return {
    number,
    id: id(100 + number),
    parentId: number === 0 ? null : id(99 + number),
    committedAt: `2026-09-${String(number + 1).padStart(2, "0")}T12:00:00.000Z`,
    operationId: id(200 + number),
    stateHash: number.toString(16).padStart(64, "0"),
  };
}

interface WordSpec {
  readonly wordId: string;
  readonly text: string;
  readonly startFrame: number;
  readonly endFrame: number;
}

const words: readonly WordSpec[] = [
  { wordId: "chunk-0:0", text: "first", startFrame: 0, endFrame: 10 },
  { wordId: "chunk-0:1", text: "second", startFrame: 10, endFrame: 20 },
  { wordId: "chunk-0:2", text: "third", startFrame: 20, endFrame: 30 },
];

function transcript(
  sourceIdentity: MediaContentIdentityV1 = sourceA,
  key = keyA,
  transcriptWords: readonly WordSpec[] = words,
): TranscriptArtifactV1 {
  const parsedWords = transcriptWords.map((word, wordIndex) => ({
    wordId: word.wordId,
    chunkId: "chunk-0",
    chunkIndex: 0,
    wordIndex,
    text: word.text,
    sourceStartUs: word.startFrame * 100_000,
    sourceEndUs: word.endFrame * 100_000,
    recognitionConfidence: 1,
    speakerLabel: "speaker-1",
    speakerConfidence: 1,
    timingProvenance: "aligned" as const,
  }));
  return transcriptArtifactV1Schema.parse({
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      key,
      sourceIdentity,
      sourceFingerprint: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "56".repeat(32),
        byteLength: sourceIdentity.byteLength,
        modifiedUnixSeconds: 1_720_000_000,
        modifiedNanoseconds: 123_456_789,
      },
      configurationIdentity: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "78".repeat(32),
      },
    },
    sourceDurationUs: 3_000_000,
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
      chunkDurationUs: 3_000_000,
      chunkOverlapUs: 0,
      providerSettings: [],
    },
    chunks: [
      {
        schemaVersion: 1,
        chunkId: "chunk-0",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: 3_000_000,
        words: parsedWords,
      },
    ],
    words: parsedWords,
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

interface CueSpec {
  readonly id: string;
  readonly word: WordSpec;
  readonly timelineStart: number;
  readonly timelineEnd: number;
}

function captionArtifact(
  captionTrackId: string,
  sourceIdentity: MediaContentIdentityV1 = sourceA,
  key = keyA,
  cues: readonly CueSpec[] = [
    { id: "cue-first", word: words[0]!, timelineStart: 10, timelineEnd: 20 },
    { id: "cue-second", word: words[1]!, timelineStart: 20, timelineEnd: 30 },
  ],
): CaptionArtifactV1 {
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
    transcriptArtifactIdentityKey: key,
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
    cues: cues.map((cue) => ({
      schemaVersion: 1,
      cueId: cue.id,
      start: createRationalTime(cue.timelineStart, rate),
      end: createRationalTime(cue.timelineEnd, rate),
      lines: [cue.word.text],
      anchor: { xPermille: 500, yPermille: 900 },
      sourceLinks: [
        {
          transcriptArtifactIdentityKey: key,
          sourceStartUs: cue.word.startFrame * 100_000,
          sourceEndUs: cue.word.endFrame * 100_000,
          transcriptWordIds: [cue.word.wordId],
        },
      ],
    })),
  });
}

interface ClipSpec {
  readonly id: string;
  readonly assetId: string;
  readonly timelineStart: number;
  readonly sourceIn: number;
  readonly sourceOut: number;
}

function clip(spec: ClipSpec) {
  return {
    id: spec.id,
    source: { kind: "asset" as const, assetId: spec.assetId },
    timelineStart: createRationalTime(spec.timelineStart, rate),
    sourceIn: createRationalTime(spec.sourceIn, rate),
    sourceOut: createRationalTime(spec.sourceOut, rate),
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

interface CaptionSpec {
  readonly id: string;
  readonly artifact?: CaptionArtifactV1;
}

function projection(
  clips: readonly ClipSpec[] = [
    { id: ids.target, assetId: ids.assetA, timelineStart: 10, sourceIn: 0, sourceOut: 10 },
    { id: ids.later, assetId: ids.assetA, timelineStart: 20, sourceIn: 10, sourceOut: 20 },
  ],
  captions: readonly CaptionSpec[] = [
    { id: ids.captionA, artifact: captionArtifact(ids.captionA) },
  ],
): ProjectProjection {
  const tracks: ProjectTrack[] = [
    {
      id: ids.sourceTrack,
      name: "Video",
      kind: "video",
      clips: clips.map(clip),
    },
    ...captions.map(({ id: trackId, artifact }): ProjectTrack => ({
      id: trackId,
      name: `Captions ${trackId}`,
      kind: "caption",
      captions: [],
      ...(artifact === undefined ? {} : { activeCaptionArtifact: artifact }),
    })),
  ];
  return {
    projectId: ids.project,
    name: "Ripple lifecycle fixture",
    revision: revision(8),
    state: {
      assets: [asset(ids.assetA, sourceA), asset(ids.assetB, sourceB)],
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

function asset(assetId: string, contentIdentity: MediaContentIdentityV1) {
  return {
    id: assetId,
    displayName: `${assetId}.mp4`,
    locator: { absolutePath: `/media/${assetId}.mp4` },
    probe: {
      durationMicroseconds: 3_000_000,
      averageFrameRate: rate,
      realFrameRate: rate,
      variableFrameRate: false,
      width: 1_920,
      height: 1_080,
      videoCodecName: "h264",
      audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
      fileSizeBytes: contentIdentity.byteLength,
    },
    contentIdentity,
  };
}

function command(clipId = ids.target): RippleDeleteClipCommandV2 {
  return {
    type: "RippleDeleteClip",
    commandId: ids.command,
    sequenceId: ids.sequence,
    trackId: ids.sourceTrack,
    clipId,
  };
}

function sourceTrack(input: ProjectProjection) {
  const track = input.state.sequences[0]!.tracks[0]!;
  if (track.kind === "caption") throw new Error("Expected media track");
  return track;
}

function captionTrack(input: ProjectProjection, index = 1) {
  const track = input.state.sequences[0]!.tracks[index]!;
  if (track.kind !== "caption") throw new Error("Expected caption track");
  return track;
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

function prepare(overrides: Partial<PrepareRippleDeleteClipCaptionLifecycleV1Input> = {}) {
  return prepareRippleDeleteClipCaptionLifecycleV1({
    projection: projection(),
    transcriptArtifacts: [transcript()],
    command: command(),
    createCommandId: (_trackId, ordinal) => id(500 + ordinal),
    ...overrides,
  });
}

function appliedArtifacts(result: Awaited<ReturnType<typeof prepare>>) {
  return result.flatMap((prepared) =>
    prepared.type === "ApplyCaptionArtifact" ? [prepared.artifact] : [],
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("prepareRippleDeleteClipCaptionLifecycleV1", () => {
  it("returns the bare command for caption-free and unrelated-caption paths", async () => {
    const ripple = command();
    await expect(
      prepareRippleDeleteClipCaptionLifecycleV1({
        projection: projection(undefined, []),
        command: ripple,
        createCommandId: () => id(500),
      }),
    ).resolves.toEqual([ripple]);

    const unrelatedProjection = projection(
      [
        { id: ids.later, assetId: ids.assetA, timelineStart: 0, sourceIn: 10, sourceOut: 20 },
        { id: ids.target, assetId: ids.assetB, timelineStart: 20, sourceIn: 0, sourceOut: 10 },
      ],
      [{ id: ids.captionA, artifact: captionArtifact(ids.captionA) }],
    );
    await expect(
      prepareRippleDeleteClipCaptionLifecycleV1({
        projection: unrelatedProjection,
        command: ripple,
        createCommandId: () => id(500),
      }),
    ).resolves.toEqual([ripple]);
  });

  it("removes the deleted occurrence and shifts later cues from the same source", async () => {
    const result = await prepare();
    expect(result.map(({ type }) => type)).toEqual(["RippleDeleteClip", "ApplyCaptionArtifact"]);
    expect(
      appliedArtifacts(result)[0]!.cues.map((cue) => ({
        id: cue.cueId,
        start: cue.start.value,
        end: cue.end.value,
      })),
    ).toEqual([{ id: "cue-second", start: 10, end: 20 }]);
  });

  it("uses distinct transcripts for mixed source lineages", async () => {
    const captionB = captionArtifact(ids.captionB, sourceB, keyB, [
      { id: "cue-b", word: words[0]!, timelineStart: 20, timelineEnd: 30 },
    ]);
    const inputProjection = projection(
      [
        { id: ids.target, assetId: ids.assetA, timelineStart: 10, sourceIn: 0, sourceOut: 10 },
        { id: ids.later, assetId: ids.assetB, timelineStart: 20, sourceIn: 0, sourceOut: 10 },
      ],
      [
        { id: ids.captionA, artifact: captionArtifact(ids.captionA) },
        { id: ids.captionB, artifact: captionB },
      ],
    );
    const result = await prepare({
      projection: inputProjection,
      transcriptArtifacts: [transcript(sourceB, keyB), transcript(sourceA, keyA)],
    });

    expect(
      result.slice(1).map((entry) => entry.type === "ApplyCaptionArtifact" && entry.trackId),
    ).toEqual([ids.captionA, ids.captionB]);
    expect(
      appliedArtifacts(result).map((artifact) => artifact.cues.map((cue) => cue.start.value)),
    ).toEqual([[], [10]]);
  });

  it("shares one transcript across tracks and allocates IDs in sequence track order", async () => {
    const inputProjection = projection(undefined, [
      { id: ids.captionA2, artifact: captionArtifact(ids.captionA2) },
      { id: ids.captionA, artifact: captionArtifact(ids.captionA) },
    ]);
    const allocations: Array<[string, number]> = [];
    const result = await prepare({
      projection: inputProjection,
      createCommandId: (trackId, ordinal) => {
        allocations.push([trackId, ordinal]);
        return id(600 + ordinal);
      },
    });

    expect(allocations).toEqual([
      [ids.captionA2, 0],
      [ids.captionA, 1],
    ]);
    expect(result.slice(1).map((entry) => entry.commandId)).toEqual([id(600), id(601)]);
  });

  it("fails closed when mixed affected lineages do not have enough distinct transcripts", async () => {
    const inputProjection = projection(
      [
        { id: ids.target, assetId: ids.assetA, timelineStart: 10, sourceIn: 0, sourceOut: 10 },
        { id: ids.later, assetId: ids.assetB, timelineStart: 20, sourceIn: 0, sourceOut: 10 },
      ],
      [
        { id: ids.captionA, artifact: captionArtifact(ids.captionA) },
        {
          id: ids.captionB,
          artifact: captionArtifact(ids.captionB, sourceB, keyB, [
            { id: "cue-b", word: words[0]!, timelineStart: 20, timelineEnd: 30 },
          ]),
        },
      ],
    );
    await expectReason(
      () => prepare({ projection: inputProjection, transcriptArtifacts: [transcript()] }),
      "caption_lifecycle_transcript_missing",
    );
  });

  it("applies an artifact with no cues when a source lineage disappears", async () => {
    const inputProjection = projection(
      [{ id: ids.target, assetId: ids.assetA, timelineStart: 10, sourceIn: 0, sourceOut: 10 }],
      [
        {
          id: ids.captionA,
          artifact: captionArtifact(ids.captionA, sourceA, keyA, [
            { id: "only", word: words[0]!, timelineStart: 10, timelineEnd: 20 },
          ]),
        },
      ],
    );
    const result = await prepare({ projection: inputProjection });
    expect(appliedArtifacts(result)[0]!.cues).toEqual([]);
  });

  it("shifts clips after the deleted array index rather than by timeline sorting", async () => {
    const artifact = captionArtifact(ids.captionA, sourceA, keyA, [
      { id: "later-index-low", word: words[2]!, timelineStart: 10, timelineEnd: 20 },
      { id: "deleted", word: words[0]!, timelineStart: 30, timelineEnd: 40 },
      { id: "later-index-high", word: words[1]!, timelineStart: 50, timelineEnd: 60 },
    ]);
    const inputProjection = projection(
      [
        { id: ids.target, assetId: ids.assetA, timelineStart: 30, sourceIn: 0, sourceOut: 10 },
        { id: ids.later, assetId: ids.assetA, timelineStart: 50, sourceIn: 10, sourceOut: 20 },
        { id: ids.third, assetId: ids.assetA, timelineStart: 10, sourceIn: 20, sourceOut: 30 },
      ],
      [{ id: ids.captionA, artifact }],
    );
    const result = await prepare({ projection: inputProjection });
    expect(
      appliedArtifacts(result)[0]!.cues.map(({ cueId, start }) => [cueId, start.value]),
    ).toEqual([
      ["later-index-low", 0],
      ["later-index-high", 40],
    ]);
  });

  it("rejects invalid, missing, and duplicate transcript artifacts", async () => {
    await expectReason(
      () =>
        prepareRippleDeleteClipCaptionLifecycleV1({
          projection: projection(),
          command: command(),
          createCommandId: () => id(500),
        }),
      "caption_lifecycle_transcript_missing",
    );

    const invalid = structuredClone(transcript()) as TranscriptArtifactV1;
    invalid.words[0]!.sourceEndUs = -1;
    await expectReason(
      () => prepare({ transcriptArtifacts: [invalid] }),
      "caption_lifecycle_transcript_invalid",
    );

    await expectReason(
      () => prepare({ transcriptArtifacts: [transcript(), transcript()] }),
      "caption_lifecycle_transcript_duplicate",
    );
  });

  it("fails closed for mismatched and stale caption links", async () => {
    const wrongProject = projection();
    captionTrack(wrongProject).activeCaptionArtifact!.trackLink.projectId = ids.unknown;
    await expectReason(
      () => prepare({ projection: wrongProject }),
      "caption_lifecycle_caption_project_mismatch",
    );

    for (const mutate of [
      (input: ProjectProjection) => {
        captionTrack(input).activeCaptionArtifact!.trackLink.sequenceId = ids.unknown;
      },
      (input: ProjectProjection) => {
        captionTrack(input).activeCaptionArtifact!.trackLink.captionTrackId = ids.captionB;
      },
    ]) {
      const invalidLink = projection();
      mutate(invalidLink);
      await expect(prepare({ projection: invalidLink })).rejects.toThrow();
    }

    const stale = projection();
    captionTrack(stale).activeCaptionArtifact!.trackLink.projectRevision = revision(8);
    await expectReason(
      () => prepare({ projection: stale }),
      "caption_lifecycle_caption_revision_stale",
    );
  });

  it("fails closed for ambiguous source lineage", async () => {
    const ambiguous = projection();
    ambiguous.state.assets.push(asset(id(90), sourceA));
    await expectReason(
      () => prepare({ projection: ambiguous }),
      "caption_lifecycle_source_lineage_ambiguous",
    );
  });

  it("rejects locked source and affected caption tracks", async () => {
    const lockedSource = projection();
    sourceTrack(lockedSource).locked = true;
    await expectReason(
      () => prepare({ projection: lockedSource }),
      "caption_lifecycle_command_track_locked",
    );

    const lockedCaption = projection();
    captionTrack(lockedCaption).locked = true;
    await expectReason(
      () => prepare({ projection: lockedCaption }),
      "caption_lifecycle_caption_track_locked",
    );
  });

  it("rejects invalid and mismatched ripple commands", async () => {
    const invalid = command() as RippleDeleteClipCommandV2 & { commandId: string };
    invalid.commandId = "not-a-command-id";
    await expectReason(
      () => prepare({ command: invalid }),
      "caption_lifecycle_command_contract_invalid",
    );

    for (const badCommand of [
      { ...command(), sequenceId: ids.unknown },
      { ...command(), trackId: ids.unknown },
      { ...command(), clipId: ids.unknown },
    ]) {
      await expectReason(
        () => prepare({ command: badCommand }),
        "caption_lifecycle_command_target_mismatch",
      );
    }

    await expectReason(
      () => prepare({ createCommandId: () => "not-a-command-id" }),
      "caption_lifecycle_command_contract_invalid",
    );
  });

  it("rejects inexact and underflowing ripple geometry", async () => {
    const inexact = projection();
    sourceTrack(inexact).clips[0]!.sourceOut = createRationalTime(1, {
      numerator: 3,
      denominator: 1,
    });
    await expectReason(
      () => prepare({ projection: inexact }),
      "caption_lifecycle_ripple_geometry_inexact",
    );

    const underflow = projection([
      { id: ids.target, assetId: ids.assetA, timelineStart: 10, sourceIn: 0, sourceOut: 10 },
      { id: ids.later, assetId: ids.assetA, timelineStart: 5, sourceIn: 10, sourceOut: 20 },
    ]);
    await expectReason(
      () => prepare({ projection: underflow }),
      "caption_lifecycle_ripple_underflow",
    );
  });

  it("wraps stale source links and unsatisfied caption constraints as remap failure", async () => {
    const staleLinks = projection();
    captionTrack(staleLinks).activeCaptionArtifact!.cues[1]!.sourceLinks[0]!.sourceStartUs =
      1_100_000;
    await expectReason(() => prepare({ projection: staleLinks }), "caption_lifecycle_remap_failed");

    const constrained = projection();
    const artifact = captionTrack(constrained).activeCaptionArtifact!;
    sourceTrack(constrained).clips[1]!.sourceIn = createRationalTime(15, rate);
    artifact.validationProfile.maxLinesPerCue = 1;
    artifact.validationProfile.maxCharactersPerLine = 2;
    artifact.cues[0]!.lines = ["ok"];
    artifact.cues[1]!.lines = ["ok"];
    const longTranscript = structuredClone(transcript());
    longTranscript.words[1]!.text = "toolong";
    longTranscript.chunks[0]!.words[1]!.text = "toolong";
    await expectReason(
      () => prepare({ projection: constrained, transcriptArtifacts: [longTranscript] }),
      "caption_lifecycle_remap_failed",
    );
  });

  it("rejects 101 atomic commands before allocating IDs", async () => {
    const captions = Array.from({ length: 100 }, (_, ordinal) => {
      const trackId = id(1_000 + ordinal);
      return { id: trackId, artifact: captionArtifact(trackId) };
    });
    let allocated = 0;
    await expectReason(
      () =>
        prepare({
          projection: projection(undefined, captions),
          createCommandId: () => {
            allocated += 1;
            return id(999);
          },
        }),
      "caption_lifecycle_command_limit_exceeded",
    );
    expect(allocated).toBe(0);
  });

  it("is immutable, deeply frozen, and deterministic for deterministic IDs", async () => {
    const inputProjection = projection(undefined, [
      { id: ids.captionA, artifact: captionArtifact(ids.captionA) },
      { id: ids.captionA2, artifact: captionArtifact(ids.captionA2) },
    ]);
    const inputTranscripts = [transcript()];
    const ripple = command();
    const before = JSON.stringify({ inputProjection, inputTranscripts, ripple });
    const run = () =>
      prepare({
        projection: inputProjection,
        transcriptArtifacts: inputTranscripts,
        command: ripple,
        createCommandId: (trackId, ordinal) =>
          `${trackId.slice(0, 24)}${String(700 + ordinal).padStart(12, "0")}`,
      });

    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(JSON.stringify({ inputProjection, inputTranscripts, ripple })).toBe(before);
    expectDeepFrozen(first);
    expect(first.slice(1).map(({ commandId }) => commandId)).toEqual([
      `${ids.captionA.slice(0, 24)}${String(700).padStart(12, "0")}`,
      `${ids.captionA2.slice(0, 24)}${String(701).padStart(12, "0")}`,
    ]);
  });
});
