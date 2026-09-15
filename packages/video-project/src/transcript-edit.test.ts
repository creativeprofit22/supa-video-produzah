import {
  VideoDomainError,
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectClip,
  type ProjectProjection,
  type ProjectTrack,
} from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  transcriptArtifactV1Schema,
  type TranscriptArtifactV1,
} from "@supa-video/media";
import { describe, expect, it } from "vitest";

import {
  assertTranscriptEditProposalCurrent,
  createTranscriptEditProposal,
  mapTranscriptToSource,
  projectTranscriptToTimeline,
  type TranscriptEditProposal,
  type TranscriptFrameRange,
} from "./transcript-edit.js";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
} as const;

interface WordSpec {
  readonly startUs: number;
  readonly endUs: number;
  readonly text?: string;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function artifact(
  words: readonly WordSpec[],
  options: {
    readonly identity?: MediaContentIdentityV1;
    readonly keyByte?: string;
    readonly sourceDurationUs?: number;
  } = {},
): TranscriptArtifactV1 {
  const duration =
    options.sourceDurationUs ?? Math.max(1_000_000, ...words.map(({ endUs }) => endUs + 100_000));
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
  const value = transcriptArtifactV1Schema.parse({
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      key: (options.keyByte ?? "ab").repeat(32),
      sourceIdentity: options.identity ?? sourceIdentity,
      sourceFingerprint: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "23".repeat(32),
        byteLength: (options.identity ?? sourceIdentity).byteLength,
        modifiedUnixSeconds: 1_720_000_000,
        modifiedNanoseconds: 123_456_789,
      },
      configurationIdentity: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: "34".repeat(32),
      },
    },
    sourceDurationUs: duration,
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
  return freezeDeep(value);
}

function clip(
  value: number,
  sourceIn: number,
  sourceOut: number,
  timelineStart = 0,
  assetId = id(1),
): ProjectClip {
  return {
    id: id(value),
    source: { kind: "asset", assetId },
    timelineStart: createRationalTime(timelineStart, rate),
    sourceIn: createRationalTime(sourceIn, rate),
    sourceOut: createRationalTime(sourceOut, rate),
    transform,
    gainMilliDecibels: 0,
  };
}

function projection(
  clips: readonly ProjectClip[] = [clip(100, 0, 10)],
  options: {
    readonly identity?: MediaContentIdentityV1;
    readonly trackKind?: "video" | "audio" | "caption";
    readonly locked?: boolean;
    readonly revisionNumber?: number;
  } = {},
): ProjectProjection {
  const trackKind = options.trackKind ?? "video";
  const track: ProjectTrack =
    trackKind === "caption"
      ? {
          id: id(10),
          name: "Captions",
          kind: "caption",
          ...(options.locked === undefined ? {} : { locked: options.locked }),
          captions: [],
        }
      : {
          id: id(10),
          name: trackKind === "video" ? "Video" : "Audio",
          kind: trackKind,
          ...(options.locked === undefined ? {} : { locked: options.locked }),
          clips: [...clips],
        };
  const revisionNumber = options.revisionNumber ?? 7;
  return {
    projectId: id(900_001),
    name: "Transcript edit fixture",
    revision: {
      number: revisionNumber,
      id: id(900_100 + revisionNumber),
      parentId: revisionNumber === 0 ? null : id(900_099 + revisionNumber),
      committedAt: `2026-08-${String(revisionNumber + 1).padStart(2, "0")}T12:00:00.000Z`,
      operationId: id(900_200 + revisionNumber),
      stateHash: revisionNumber.toString(16).padStart(64, "0"),
    },
    state: {
      assets: [
        {
          id: id(1),
          displayName: "source.mp4",
          locator: { absolutePath: "/media/source.mp4" },
          probe: {
            durationMicroseconds: 100_000_000,
            averageFrameRate: rate,
            realFrameRate: rate,
            variableFrameRate: false,
            width: 1920,
            height: 1080,
            videoCodecName: "h264",
            audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
            fileSizeBytes: (options.identity ?? sourceIdentity).byteLength,
          },
          contentIdentity: options.identity ?? sourceIdentity,
        },
      ],
      sequences: [
        {
          id: id(2),
          name: "Main sequence",
          rate,
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks: [track],
          markers: [],
        },
      ],
      activeSequenceId: id(2),
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

function activateCaptionTrack(
  project: ProjectProjection,
  value: TranscriptArtifactV1,
): ProjectProjection {
  const result = structuredClone(project);
  const sequence = result.state.sequences[0]!;
  sequence.tracks.push({
    id: id(11),
    name: "Captions",
    kind: "caption",
    captions: [],
    activeCaptionArtifact: captionArtifactV1Schema.parse({
      schemaVersion: 1,
      trackLink: {
        schemaVersion: 1,
        projectId: result.projectId,
        projectRevision: { ...result.revision, number: result.revision.number - 1 },
        sequenceId: sequence.id,
        captionTrackId: id(11),
      },
      sourceIdentity: value.identity.sourceIdentity,
      transcriptArtifactIdentityKey: value.identity.key,
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
          start: createRationalTime(1, rate),
          end: createRationalTime(2, rate),
          lines: [value.words[0]?.text ?? "word"],
          anchor: { xPermille: 500, yPermille: 900 },
          sourceLinks: [
            {
              transcriptArtifactIdentityKey: value.identity.key,
              sourceStartUs: value.words[0]?.sourceStartUs ?? 100_000,
              sourceEndUs: value.words[0]?.sourceEndUs ?? 200_000,
              transcriptWordIds: [value.words[0]?.wordId ?? "words:0"],
            },
          ],
        },
      ],
    }),
  });
  return result;
}

function scope(value: TranscriptArtifactV1, project: ProjectProjection) {
  return { artifact: value, projection: project, sequenceId: id(2), trackId: id(10) };
}

function rangeValues(range: TranscriptFrameRange): [number, number] {
  return [range.start.value, range.end.value];
}

async function proposalForWordIds(
  value: TranscriptArtifactV1,
  project: ProjectProjection,
  wordIds: readonly string[],
): Promise<TranscriptEditProposal> {
  const timeline = projectTranscriptToTimeline(scope(value, project));
  const occurrenceIds = wordIds.map((wordId) => {
    const occurrence = timeline.occurrences.find((candidate) => candidate.wordId === wordId);
    if (occurrence === undefined) throw new Error(`Missing occurrence for ${wordId}`);
    return occurrence.occurrenceId;
  });
  return createTranscriptEditProposal({
    ...scope(value, project),
    deletedOccurrenceIds: occurrenceIds,
  });
}

async function expectDomainFailure(
  run: () => unknown | Promise<unknown>,
  code: VideoDomainError["code"],
  reason: string,
): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect(failure).toMatchObject({ code, details: { reason } });
}

describe("transcript source and timeline mapping", () => {
  it("rejects transcript mapping for a retimed source instead of interpreting it as 1x", () => {
    const target = { ...clip(100, 0, 10), speed: { numerator: 2, denominator: 1 } };
    const project = projection([target]);
    const value = artifact([{ startUs: 50_001, endUs: 149_999, text: "retimed" }]);
    expect(() => projectTranscriptToTimeline(scope(value, project))).toThrow(
      "Transcript mapping does not support retimed clips",
    );
  });
  it("preserves an immutable artifact while exposing immutable source mappings", () => {
    const value = artifact([
      { startUs: 50_001, endUs: 149_999, text: "precise" },
      { startUs: 450_001, endUs: 549_999, text: "split" },
    ]);
    const before = structuredClone(value);

    const mappings = mapTranscriptToSource(value);

    expect(mappings).toEqual([
      {
        artifactIdentityKey: value.identity.key,
        sourceIdentity,
        wordId: "words:0",
        text: "precise",
        sourceStartUs: 50_001,
        sourceEndUs: 149_999,
      },
      {
        artifactIdentityKey: value.identity.key,
        sourceIdentity,
        wordId: "words:1",
        text: "split",
        sourceStartUs: 450_001,
        sourceEndUs: 549_999,
      },
    ]);
    expect(value).toEqual(before);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.words)).toBe(true);
    expect(Object.isFrozen(mappings)).toBe(true);
    expect(mappings.every(Object.isFrozen)).toBe(true);
  });

  it("uses floor/ceil frame boundaries and remaps trimmed, split, and repeated source use", () => {
    const value = artifact([
      { startUs: 50_001, endUs: 149_999, text: "trimmed" },
      { startUs: 450_001, endUs: 549_999, text: "across split" },
    ]);
    const project = projection([clip(302, 4, 7, 30), clip(301, 5, 8, 20), clip(300, 1, 5, 10)]);

    const timeline = projectTranscriptToTimeline(scope(value, project));

    expect(
      timeline.occurrences.map((occurrence) => ({
        wordId: occurrence.wordId,
        clipId: occurrence.clipId,
        source: rangeValues(occurrence.sourceRange),
        timeline: rangeValues(occurrence.timelineRange),
      })),
    ).toEqual([
      { wordId: "words:0", clipId: id(300), source: [1, 2], timeline: [10, 11] },
      { wordId: "words:1", clipId: id(300), source: [4, 5], timeline: [13, 14] },
      { wordId: "words:1", clipId: id(301), source: [5, 6], timeline: [20, 21] },
      { wordId: "words:1", clipId: id(302), source: [4, 6], timeline: [30, 32] },
    ]);
    expect(timeline.occurrences.filter(({ wordId }) => wordId === "words:1")).toHaveLength(3);
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(Object.isFrozen(timeline.occurrences)).toBe(true);
    expect(timeline.occurrences.every(Object.isFrozen)).toBe(true);
  });

  it("orders occurrences canonically independent of clip storage order", () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);
    const project = projection([clip(302, 0, 10, 5), clip(301, 0, 10, 5), clip(300, 0, 10, 0)]);

    const timeline = projectTranscriptToTimeline(scope(value, project));

    expect(timeline.occurrences.map(({ clipId }) => clipId)).toEqual([id(300), id(301), id(302)]);
    expect(new Set(timeline.occurrences.map(({ occurrenceId }) => occurrenceId)).size).toBe(3);
  });

  it("exposes the exact sequence timeline rate with and without mapped words", () => {
    const mapped = projectTranscriptToTimeline(
      scope(artifact([{ startUs: 100_000, endUs: 200_000 }]), projection()),
    );
    const empty = projectTranscriptToTimeline(scope(artifact([]), projection()));

    expect(mapped.timelineRate).toEqual(rate);
    expect(mapped.occurrences).not.toHaveLength(0);
    expect(empty.timelineRate).toEqual(rate);
    expect(empty.occurrences).toEqual([]);
  });

  it("rejects a transcript whose source identity is not committed in the project", async () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);
    const otherIdentity = { ...sourceIdentity, digest: "ff".repeat(32) };

    await expectDomainFailure(
      () => projectTranscriptToTimeline(scope(value, projection([], { identity: otherIdentity }))),
      "invalid_project",
      "source_identity_mismatch",
    );
  });
});

describe("transcript edit proposals", () => {
  it("merges adjacent deletions and computes compacted kept/deleted preview ranges", async () => {
    const value = artifact([
      { startUs: 100_000, endUs: 200_000 },
      { startUs: 200_000, endUs: 300_000 },
      { startUs: 400_000, endUs: 500_000 },
    ]);
    const result = await proposalForWordIds(value, projection(), ["words:0", "words:1"]);

    expect(result.deletedRanges.map((range) => rangeValues(range.sourceRange))).toEqual([[1, 3]]);
    expect(result.deletedRanges.map((range) => rangeValues(range.originalTimelineRange))).toEqual([
      [1, 3],
    ]);
    expect(result.deletedRanges.map((range) => rangeValues(range.previewTimelineRange))).toEqual([
      [1, 1],
    ]);
    expect(result.deletedRanges[0]?.selectedWords.map(({ wordId }) => wordId)).toEqual([
      "words:0",
      "words:1",
    ]);
    expect(result.keptRanges.map((range) => rangeValues(range.sourceRange))).toEqual([
      [0, 1],
      [3, 10],
    ]);
    expect(result.keptRanges.map((range) => rangeValues(range.previewTimelineRange))).toEqual([
      [0, 1],
      [1, 8],
    ]);
  });

  it("keeps disjoint deletions separate and cumulatively compacts their previews", async () => {
    const value = artifact([
      { startUs: 100_000, endUs: 200_000 },
      { startUs: 200_000, endUs: 300_000 },
      { startUs: 400_000, endUs: 500_000 },
    ]);
    const result = await proposalForWordIds(value, projection(), ["words:0", "words:2"]);

    expect(result.deletedRanges.map((range) => rangeValues(range.sourceRange))).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(result.deletedRanges.map((range) => rangeValues(range.previewTimelineRange))).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(result.keptRanges.map((range) => rangeValues(range.sourceRange))).toEqual([
      [0, 1],
      [2, 4],
      [5, 10],
    ]);
    expect(result.keptRanges.map((range) => rangeValues(range.previewTimelineRange))).toEqual([
      [0, 1],
      [1, 3],
      [3, 8],
    ]);
  });

  it("appends a corrected caption artifact after all captioned proposal geometry", async () => {
    const value = artifact([
      { startUs: 100_000, endUs: 200_000, text: "delete" },
      { startUs: 400_000, endUs: 500_000, text: "keep" },
    ]);
    const project = activateCaptionTrack(projection(), value);

    const result = await proposalForWordIds(value, project, ["words:0"]);

    expect(result.commandGroup.commands.at(-1)?.type).toBe("ApplyCaptionArtifact");
    expect(
      result.commandGroup.commands
        .slice(0, -1)
        .every(({ type }) => type !== "ApplyCaptionArtifact"),
    ).toBe(true);
    const apply = result.commandGroup.commands.at(-1);
    if (apply?.type !== "ApplyCaptionArtifact") throw new Error("Missing caption application");
    expect(apply.trackId).toBe(id(11));
    expect(apply.artifact.cues).toEqual([]);
  });

  it("produces canonical deterministic proposals, command IDs, and fragment IDs", async () => {
    const value = artifact([
      { startUs: 100_000, endUs: 200_000 },
      { startUs: 400_000, endUs: 500_000 },
    ]);
    const project = projection();
    const timeline = projectTranscriptToTimeline(scope(value, project));
    const first = timeline.occurrences[0]!.occurrenceId;
    const second = timeline.occurrences[1]!.occurrenceId;

    const one = await createTranscriptEditProposal({
      ...scope(value, project),
      deletedOccurrenceIds: [second, first, second],
    });
    const two = await createTranscriptEditProposal({
      ...scope(value, project),
      deletedOccurrenceIds: [first, second],
    });

    expect(one).toEqual(two);
    expect(one.selectedOccurrenceIds).toEqual([first, second].sort());
    const generatedIds = [
      one.proposalId,
      one.commandGroup.groupId,
      ...one.commandGroup.commands.map(({ commandId }) => commandId),
      ...one.commandGroup.commands.flatMap((command) =>
        command.type === "SplitClip" ? [command.rightClipId] : [],
      ),
    ];
    expect(
      generatedIds.every((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
      ),
    ).toBe(true);
    expect(new Set(generatedIds).size).toBe(generatedIds.length);
    expect(Object.isFrozen(one)).toBe(true);

    const captionedProject = activateCaptionTrack(project, value);
    const captionedOne = await proposalForWordIds(value, captionedProject, ["words:0"]);
    const captionedTwo = await proposalForWordIds(value, captionedProject, ["words:0"]);
    expect(captionedOne).toEqual(captionedTwo);
    expect(captionedOne.commandGroup.commands.at(-1)?.type).toBe("ApplyCaptionArtifact");
  });

  it("compiles whole, leading, trailing, and middle removals into linked command shapes", async () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);
    const whole = await proposalForWordIds(value, projection([clip(100, 1, 2)]), ["words:0"]);
    const leading = await proposalForWordIds(value, projection([clip(100, 1, 10)]), ["words:0"]);
    const trailing = await proposalForWordIds(value, projection([clip(100, 0, 2)]), ["words:0"]);
    const middle = await proposalForWordIds(value, projection([clip(100, 0, 10)]), ["words:0"]);

    expect(whole.commandGroup.commands).toMatchObject([
      { type: "RippleDeleteClip", clipId: id(100), sequenceId: id(2), trackId: id(10) },
    ]);

    expect(leading.commandGroup.commands.map(({ type }) => type)).toEqual([
      "SplitClip",
      "RippleDeleteClip",
    ]);
    const [leadingSplit, leadingDelete] = leading.commandGroup.commands;
    if (leadingSplit?.type !== "SplitClip" || leadingDelete?.type !== "RippleDeleteClip") {
      throw new Error("Unexpected leading command shape");
    }
    expect(leadingSplit).toMatchObject({ clipId: id(100), splitAt: { value: 2 } });
    expect(leadingDelete.clipId).toBe(id(100));

    expect(trailing.commandGroup.commands.map(({ type }) => type)).toEqual([
      "SplitClip",
      "RippleDeleteClip",
    ]);
    const [trailingSplit, trailingDelete] = trailing.commandGroup.commands;
    if (trailingSplit?.type !== "SplitClip" || trailingDelete?.type !== "RippleDeleteClip") {
      throw new Error("Unexpected trailing command shape");
    }
    expect(trailingSplit).toMatchObject({ clipId: id(100), splitAt: { value: 1 } });
    expect(trailingDelete.clipId).toBe(trailingSplit.rightClipId);

    expect(middle.commandGroup.commands.map(({ type }) => type)).toEqual([
      "SplitClip",
      "SplitClip",
      "RippleDeleteClip",
    ]);
    const [middleStart, middleEnd, middleDelete] = middle.commandGroup.commands;
    if (
      middleStart?.type !== "SplitClip" ||
      middleEnd?.type !== "SplitClip" ||
      middleDelete?.type !== "RippleDeleteClip"
    ) {
      throw new Error("Unexpected middle command shape");
    }
    expect(middleStart).toMatchObject({ clipId: id(100), splitAt: { value: 1 } });
    expect(middleEnd).toMatchObject({
      clipId: middleStart.rightClipId,
      splitAt: { value: 2 },
    });
    expect(middleDelete.clipId).toBe(middleStart.rightClipId);
    expect(middleEnd.rightClipId).not.toBe(middleStart.rightClipId);
  });

  it("rejects empty and unknown occurrence selections", async () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);
    const project = projection();

    await expectDomainFailure(
      () =>
        createTranscriptEditProposal({
          ...scope(value, project),
          deletedOccurrenceIds: [],
        }),
      "invalid_range",
      "empty_selection",
    );
    await expectDomainFailure(
      () =>
        createTranscriptEditProposal({
          ...scope(value, project),
          deletedOccurrenceIds: ["not-a-current-occurrence"],
        }),
      "invalid_range",
      "unknown_occurrence",
    );
  });

  it("rejects locked and caption target tracks", async () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);

    await expectDomainFailure(
      () => projectTranscriptToTimeline(scope(value, projection([], { locked: true }))),
      "invalid_project",
      "locked_track",
    );
    await expectDomainFailure(
      () => projectTranscriptToTimeline(scope(value, projection([], { trackKind: "caption" }))),
      "invalid_project",
      "caption_track",
    );
  });

  it("rejects proposals requiring more than 100 atomic commands", async () => {
    const words = Array.from({ length: 34 }, (_, index) => ({
      startUs: (index * 2 + 1) * 100_000,
      endUs: (index * 2 + 2) * 100_000,
    }));
    const value = artifact(words, { sourceDurationUs: 7_100_000 });
    const project = projection([clip(100, 0, 70)]);
    const occurrenceIds = projectTranscriptToTimeline(scope(value, project)).occurrences.map(
      ({ occurrenceId }) => occurrenceId,
    );

    await expectDomainFailure(
      () =>
        createTranscriptEditProposal({
          ...scope(value, project),
          deletedOccurrenceIds: occurrenceIds,
        }),
      "invalid_range",
      "command_limit_exceeded",
    );
  });
});

describe("transcript edit proposal currency", () => {
  it("accepts the creating artifact/revision and rejects stale artifacts and revisions", async () => {
    const value = artifact([{ startUs: 100_000, endUs: 200_000 }]);
    const project = projection();
    const proposal = await proposalForWordIds(value, project, ["words:0"]);

    expect(() =>
      assertTranscriptEditProposalCurrent({ proposal, artifact: value, projection: project }),
    ).not.toThrow();

    const staleArtifact = artifact([{ startUs: 100_000, endUs: 200_000 }], {
      keyByte: "cd",
    });
    await expectDomainFailure(
      () =>
        assertTranscriptEditProposalCurrent({
          proposal,
          artifact: staleArtifact,
          projection: project,
        }),
      "invalid_project",
      "stale_transcript",
    );

    await expectDomainFailure(
      () =>
        assertTranscriptEditProposalCurrent({
          proposal,
          artifact: value,
          projection: projection(undefined, { revisionNumber: 8 }),
        }),
      "invalid_project",
      "stale_revision",
    );
  });
});
