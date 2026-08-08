import {
  VideoDomainError,
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectClip,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type ProjectTrack,
  type RationalRate,
} from "@supa-video/contracts";
import {
  transcriptArtifactV1Schema,
  validateCaptionArtifactV1,
  type CaptionStyleV1,
  type CaptionValidationProfileV1,
  type TranscriptArtifactV1,
} from "@supa-video/media";
import { describe, expect, it } from "vitest";

import {
  generateCaptionArtifactV1,
  type GenerateCaptionArtifactV1Input,
} from "./transcript-caption.js";
import {
  projectTranscriptToTimeline,
  type TranscriptTimelineOccurrence,
  type TranscriptTimelineProjection,
} from "./transcript-edit.js";

const timelineRate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};
const revision: ProjectRevisionDescriptorV2 = {
  number: 7,
  id: id(107),
  parentId: id(106),
  committedAt: "2026-08-08T12:00:00.000Z",
  operationId: id(207),
  stateHash: "07".repeat(32),
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
  readonly text: string;
  readonly startUs?: number;
  readonly endUs?: number;
}

interface OccurrenceSpec {
  readonly wordIndex: number;
  readonly start: number;
  readonly end: number;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly occurrenceId?: string;
  readonly clipId?: string;
  readonly overrides?: Partial<TranscriptTimelineOccurrence>;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function transcript(words: readonly WordSpec[], digestByte = "ab"): TranscriptArtifactV1 {
  const normalizedWords = words.map((word, wordIndex) => {
    const sourceStartUs = word.startUs ?? wordIndex * 100_000;
    const sourceEndUs = word.endUs ?? sourceStartUs + 100_000;
    return {
      wordId: `words:${wordIndex}`,
      chunkId: "words",
      chunkIndex: 0,
      wordIndex,
      text: word.text,
      sourceStartUs,
      sourceEndUs,
      recognitionConfidence: 1,
      speakerLabel: "speaker-1",
      speakerConfidence: 1,
      timingProvenance: "aligned" as const,
    };
  });
  const sourceDurationUs = Math.max(
    1_000_000,
    ...normalizedWords.map(({ sourceEndUs }) => sourceEndUs + 100_000),
  );
  let retainedOverlapWordCount = 0;
  let furthestEndUs = -1;
  for (const word of normalizedWords) {
    if (word.sourceStartUs < furthestEndUs) retainedOverlapWordCount += 1;
    furthestEndUs = Math.max(furthestEndUs, word.sourceEndUs);
  }

  return freezeDeep(
    transcriptArtifactV1Schema.parse({
      schemaVersion: 1,
      identity: {
        schemaVersion: 1,
        key: digestByte.repeat(32),
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
      sourceDurationUs,
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
        chunkDurationUs: sourceDurationUs,
        chunkOverlapUs: 0,
        providerSettings: [],
      },
      chunks: [
        {
          schemaVersion: 1,
          chunkId: "words",
          chunkIndex: 0,
          sourceStartUs: 0,
          sourceEndUs: sourceDurationUs,
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
    }),
  );
}

function style(
  alignment: CaptionStyleV1["alignment"] = { horizontal: "center", vertical: "bottom" },
): CaptionStyleV1 {
  return {
    schemaVersion: 1,
    typography: {
      fontFamily: "Inter",
      fontSizePx: 48,
      fontWeight: 600,
      fontStyle: "normal",
      lineHeightPermille: 1_200,
      foregroundColorRgba: "#ffffffff",
    },
    alignment,
  };
}

function profile(overrides: Partial<CaptionValidationProfileV1> = {}): CaptionValidationProfileV1 {
  return {
    schemaVersion: 1,
    maxLinesPerCue: 4,
    maxCharactersPerLine: 1_024,
    maxCharactersPerSecond: 1_000,
    minimumCueDuration: createRationalTime(0, timelineRate),
    maximumCueDuration: createRationalTime(600, timelineRate),
    safeArea: {
      topPermille: 30,
      rightPermille: 80,
      bottomPermille: 70,
      leftPermille: 40,
    },
    ...overrides,
  };
}

function occurrencesFor(
  artifact: TranscriptArtifactV1,
  specs: readonly OccurrenceSpec[] = artifact.words.map((_, wordIndex) => ({
    wordIndex,
    start: wordIndex * 2,
    end: wordIndex * 2 + 1,
  })),
  rate: RationalRate = timelineRate,
): readonly TranscriptTimelineOccurrence[] {
  return specs.map((spec, index) => {
    const word = artifact.words[spec.wordIndex]!;
    const sourceStart = spec.sourceStart ?? spec.wordIndex * 2;
    const sourceEnd = spec.sourceEnd ?? sourceStart + 1;
    const base: TranscriptTimelineOccurrence = {
      artifactIdentityKey: artifact.identity.key,
      sourceIdentity: artifact.identity.sourceIdentity,
      wordId: word.wordId,
      text: word.text,
      sourceStartUs: word.sourceStartUs,
      sourceEndUs: word.sourceEndUs,
      occurrenceId: spec.occurrenceId ?? `occurrence-${String(index).padStart(3, "0")}`,
      projectId: id(900_001),
      projectRevision: revision,
      sequenceId: id(2),
      trackId: id(10),
      clipId: spec.clipId ?? id(300 + index),
      assetId: id(1),
      sourceRange: {
        start: createRationalTime(sourceStart, timelineRate),
        end: createRationalTime(sourceEnd, timelineRate),
      },
      timelineRange: {
        start: createRationalTime(spec.start, rate),
        end: createRationalTime(spec.end, rate),
      },
    };
    return { ...base, ...spec.overrides };
  });
}

function timeline(
  artifact: TranscriptArtifactV1,
  specs?: readonly OccurrenceSpec[],
  options: {
    readonly rate?: RationalRate;
    readonly occurrences?: readonly TranscriptTimelineOccurrence[];
  } = {},
): TranscriptTimelineProjection {
  const rate = options.rate ?? timelineRate;
  return {
    schemaVersion: 1,
    artifactIdentityKey: artifact.identity.key,
    sourceIdentity: artifact.identity.sourceIdentity,
    projectId: id(900_001),
    projectRevision: revision,
    sequenceId: id(2),
    trackId: id(10),
    timelineRate: rate,
    occurrences: options.occurrences ?? occurrencesFor(artifact, specs, rate),
  };
}

function input(
  artifact: TranscriptArtifactV1,
  projection = timeline(artifact),
  options: {
    readonly style?: CaptionStyleV1;
    readonly profile?: CaptionValidationProfileV1;
  } = {},
): GenerateCaptionArtifactV1Input {
  return {
    artifact,
    timeline: projection,
    captionTrackId: id(20),
    language: "en-US",
    style: options.style ?? style(),
    validationProfile: options.profile ?? profile(),
  };
}

function captionLines(value: ReturnType<typeof generateCaptionArtifactV1>): string[] {
  return value.cues.map(({ lines }) => lines.join("\n"));
}

function expectFailure(run: () => unknown, code: VideoDomainError["code"], reason: string): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect(failure).toMatchObject({ code, details: { reason } });
}

function clip(value: number, sourceIn: number, sourceOut: number, start: number): ProjectClip {
  return {
    id: id(value),
    source: { kind: "asset", assetId: id(1) },
    timelineStart: createRationalTime(start, timelineRate),
    sourceIn: createRationalTime(sourceIn, timelineRate),
    sourceOut: createRationalTime(sourceOut, timelineRate),
    transform,
    gainMilliDecibels: 0,
  };
}

function project(clips: readonly ProjectClip[]): ProjectProjection {
  const track: ProjectTrack = {
    id: id(10),
    name: "Video",
    kind: "video",
    clips: [...clips],
  };
  return {
    projectId: id(900_001),
    name: "Caption fixture",
    revision,
    state: {
      assets: [
        {
          id: id(1),
          displayName: "source.mp4",
          locator: { absolutePath: "/media/source.mp4" },
          probe: {
            durationMicroseconds: 100_000_000,
            averageFrameRate: timelineRate,
            realFrameRate: timelineRate,
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
          id: id(2),
          name: "Main",
          rate: timelineRate,
          width: 1_920,
          height: 1_080,
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
    snapshotRevision: revision.number,
    recoveryStatus: "clean",
    replayedRecordCount: revision.number,
  };
}

describe("transcript caption generation", () => {
  it("returns a valid empty artifact with complete deterministic linkage", () => {
    const artifact = transcript([]);
    const customRate = { numerator: 30_000, denominator: 1_001 } as const;
    const customStyle = style({ horizontal: "right", vertical: "top" });
    const customProfile = profile();
    const result = generateCaptionArtifactV1(
      input(artifact, timeline(artifact, [], { rate: customRate }), {
        style: customStyle,
        profile: customProfile,
      }),
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      trackLink: {
        projectId: id(900_001),
        projectRevision: revision,
        sequenceId: id(2),
        captionTrackId: id(20),
      },
      sourceIdentity,
      transcriptArtifactIdentityKey: artifact.identity.key,
      language: "en-US",
      timelineRate: customRate,
      style: customStyle,
      validationProfile: customProfile,
      cues: [],
    });
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("generates normal cues with stable IDs, exact metadata, rational timing, and a derived anchor", () => {
    const artifact = transcript([{ text: "Hello" }, { text: "." }, { text: "World" }]);
    const customRate = { numerator: 30_000, denominator: 1_001 } as const;
    const customStyle = style({ horizontal: "right", vertical: "top" });
    const customProfile = profile();
    const result = generateCaptionArtifactV1(
      input(artifact, timeline(artifact, undefined, { rate: customRate }), {
        style: customStyle,
        profile: customProfile,
      }),
    );

    expect(result.trackLink).toEqual({
      schemaVersion: 1,
      projectId: id(900_001),
      projectRevision: revision,
      sequenceId: id(2),
      captionTrackId: id(20),
    });
    expect(result.sourceIdentity).toEqual(sourceIdentity);
    expect(result.transcriptArtifactIdentityKey).toBe(artifact.identity.key);
    expect(result.timelineRate).toEqual(customRate);
    expect(result.style).toEqual(customStyle);
    expect(result.validationProfile).toEqual(customProfile);
    expect(result.cues.map(({ cueId }) => cueId)).toEqual(["caption-000001", "caption-000002"]);
    expect(
      result.cues.every(({ anchor }) => anchor.xPermille === 920 && anchor.yPermille === 30),
    ).toBe(true);
    expect(
      result.cues.every(
        ({ start, end }) =>
          start.rateNumerator === customRate.numerator &&
          start.rateDenominator === customRate.denominator &&
          end.rateNumerator === customRate.numerator &&
          end.rateDenominator === customRate.denominator,
      ),
    ).toBe(true);
    expect(captionLines(result)).toEqual(["Hello.", "World"]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("attaches every explicit opening and closing punctuation class without stray spaces", () => {
    const tokens = [
      "(",
      "round",
      ")",
      "[",
      "square",
      "]",
      "{",
      "brace",
      "}",
      "“",
      "double",
      "”",
      "‘",
      "single",
      "’",
      ",",
      ".",
      ";",
      ":",
      "!",
      "?",
      "%",
      "…",
    ];
    const result = generateCaptionArtifactV1(input(transcript(tokens.map((text) => ({ text })))));
    const text = captionLines(result).join(" ");

    expect(text).toBe("(round) [square] {brace} “double” ‘single’,.;:!?%…");
    expect(text).not.toMatch(/\s(?:[,.;:!?%…)}”’]|\])/u);
    expect(text).not.toMatch(/[([{“‘]\s/u);
  });

  it("uses sentence-final punctuation through every explicit closing quote class as preferred cue boundaries", () => {
    const tokens = [
      "(",
      "Round",
      "?",
      ")",
      "[",
      "Square",
      "!",
      "]",
      "{",
      "Brace",
      ".",
      "}",
      "“",
      "Double",
      "…",
      "”",
      "‘",
      "Single",
      "?",
      "’",
      '"',
      "ASCII",
      "?",
      '"',
      "Tail",
    ];
    const result = generateCaptionArtifactV1(input(transcript(tokens.map((text) => ({ text })))));

    expect(captionLines(result)).toEqual([
      "(Round?)",
      "[Square!]",
      "{Brace.}",
      "“Double…”",
      "‘Single?’",
      '"ASCII?"',
      "Tail",
    ]);
  });

  it("toggles ASCII quote classes independently, preserves unmatched openings, mixed punctuation, normalized and embedded lexical punctuation", () => {
    const tokens = [
      "'\"",
      "both",
      "\"'",
      '"',
      "double",
      '"',
      "'",
      "single",
      "'",
      "([“",
      "mixed",
      "”]),",
      "  spaced \t out  ",
      "can't",
      "wow?!x",
      '"',
    ];
    const result = generateCaptionArtifactV1(input(transcript(tokens.map((text) => ({ text })))));

    expect(captionLines(result)).toEqual([
      "'\"both\"' \"double\" 'single' ([“mixed”]), spaced out can't wow?!x \"",
    ]);
  });

  it("keeps a gap immediately below one second and breaks at exactly one second", () => {
    const artifact = transcript([{ text: "before" }, { text: "after" }]);
    const below = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 1 },
          { wordIndex: 1, start: 10, end: 11 },
        ]),
      ),
    );
    const exact = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 1 },
          { wordIndex: 1, start: 11, end: 12 },
        ]),
      ),
    );

    expect(captionLines(below)).toEqual(["before after"]);
    expect(captionLines(exact)).toEqual(["before", "after"]);
  });

  it("suppresses a preferred one-second gap break when minimum duration and CPS need the next unit", () => {
    const artifact = transcript([{ text: "1234567890" }, { text: "merge" }]);
    const result = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 1 },
          { wordIndex: 1, start: 11, end: 12 },
        ]),
        {
          profile: profile({
            minimumCueDuration: createRationalTime(20, timelineRate),
            maxCharactersPerSecond: 5,
          }),
        },
      ),
    );

    expect(captionLines(result)).toEqual(["1234567890 merge"]);
    expect(result.cues[0]?.end.value).toBeGreaterThanOrEqual(30);
  });

  it("suppresses a preferred gap break when its suffix cannot satisfy a later capacity boundary", () => {
    const artifact = transcript([{ text: "early" }, { text: "hello" }, { text: "bounded" }]);
    const result = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 2 },
          { wordIndex: 1, start: 12, end: 13 },
          { wordIndex: 2, start: 13, end: 15 },
        ]),
        {
          profile: profile({
            minimumCueDuration: createRationalTime(2, timelineRate),
            maximumCueDuration: createRationalTime(20, timelineRate),
            maxLinesPerCue: 1,
            maxCharactersPerLine: 11,
          }),
        },
      ),
    );

    expect(captionLines(result)).toEqual(["early hello", "bounded"]);
    expect(result.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [0, 13],
      [13, 15],
    ]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("reconsiders an optional gap when it shifts later mandatory capacity boundaries", () => {
    const artifact = transcript([
      { text: "a" },
      { text: "b" },
      { text: "c" },
      { text: "d" },
      { text: "eee" },
    ]);
    const result = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 2 },
          { wordIndex: 1, start: 12, end: 13 },
          { wordIndex: 2, start: 13, end: 14 },
          { wordIndex: 3, start: 14, end: 15 },
          { wordIndex: 4, start: 15, end: 16 },
        ]),
        {
          profile: profile({
            minimumCueDuration: createRationalTime(2, timelineRate),
            maximumCueDuration: createRationalTime(20, timelineRate),
            maxLinesPerCue: 1,
            maxCharactersPerLine: 4,
          }),
        },
      ),
    );

    expect(captionLines(result)).toEqual(["a b", "c d", "eee"]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("counts astral emoji and modifiers as Unicode scalars at exact line and CPS limits with stable greedy wrapping", () => {
    const artifact = transcript([{ text: "👍🏽" }, { text: "a" }, { text: "🙂" }]);
    const result = generateCaptionArtifactV1(
      input(
        artifact,
        timeline(artifact, [
          { wordIndex: 0, start: 0, end: 2 },
          { wordIndex: 1, start: 2, end: 3 },
          { wordIndex: 2, start: 3, end: 10 },
        ]),
        {
          profile: profile({
            maxLinesPerCue: 2,
            maxCharactersPerLine: 4,
            maxCharactersPerSecond: 5,
            maximumCueDuration: createRationalTime(10, timelineRate),
          }),
        },
      ),
    );

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.lines).toEqual(["👍🏽 a", "🙂"]);
    expect(result.cues[0]?.end.value).toBe(10);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("rejects one Unicode display unit one scalar over the line limit", () => {
    const artifact = transcript([{ text: "👍🏽🙂abc" }]);
    expectFailure(
      () =>
        generateCaptionArtifactV1(
          input(artifact, undefined, {
            profile: profile({ maxCharactersPerLine: 5 }),
          }),
        ),
      "invalid_range",
      "caption_unit_unrenderable",
    );
  });

  it("follows clip trims and stitches a true contiguous clip split once with exact transcript lineage", () => {
    const artifact = transcript([
      { text: "trimmed", startUs: 50_001, endUs: 149_999 },
      { text: "split", startUs: 450_001, endUs: 549_999 },
    ]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 1, 4, 5), clip(301, 4, 5, 10), clip(302, 5, 6, 11)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const result = generateCaptionArtifactV1(input(artifact, projection));

    expect(
      projection.occurrences.map(({ wordId, timelineRange }) => [
        wordId,
        timelineRange.start.value,
        timelineRange.end.value,
      ]),
    ).toEqual([
      ["words:0", 5, 6],
      ["words:1", 10, 11],
      ["words:1", 11, 12],
    ]);
    expect(captionLines(result)).toEqual(["trimmed split"]);
    expect([result.cues[0]?.start.value, result.cues[0]?.end.value]).toEqual([5, 12]);
    expect(result.cues[0]?.sourceLinks).toEqual([
      {
        transcriptArtifactIdentityKey: artifact.identity.key,
        sourceStartUs: 50_001,
        sourceEndUs: 149_999,
        transcriptWordIds: ["words:0"],
      },
      {
        transcriptArtifactIdentityKey: artifact.identity.key,
        sourceStartUs: 450_001,
        sourceEndUs: 549_999,
        transcriptWordIds: ["words:1"],
      },
    ]);
  });

  it("keeps repeated non-contiguous source use as distinct cues with the same exact source link", () => {
    const artifact = transcript([{ text: "repeat", startUs: 100_000, endUs: 200_000 }]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 0, 10, 0), clip(301, 0, 10, 20)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const result = generateCaptionArtifactV1(input(artifact, projection));

    expect(captionLines(result)).toEqual(["repeat", "repeat"]);
    expect(result.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [1, 2],
      [21, 22],
    ]);
    expect(result.cues[0]?.sourceLinks).toEqual(result.cues[1]?.sourceLinks);
    expect(result.cues[0]?.sourceLinks[0]).toMatchObject({
      sourceStartUs: 100_000,
      sourceEndUs: 200_000,
      transcriptWordIds: ["words:0"],
    });
  });

  it("keeps a repeated punctuation-only source occurrence in distinct valid cues with exact lineage", () => {
    const artifact = transcript([{ text: ".", startUs: 100_000, endUs: 200_000 }]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 0, 10, 0), clip(301, 0, 10, 20)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const result = generateCaptionArtifactV1(input(artifact, projection));
    const exactSourceLink = {
      transcriptArtifactIdentityKey: artifact.identity.key,
      sourceStartUs: 100_000,
      sourceEndUs: 200_000,
      transcriptWordIds: ["words:0"],
    };

    expect(
      projection.occurrences.map(({ wordId, timelineRange }) => [
        wordId,
        timelineRange.start.value,
        timelineRange.end.value,
      ]),
    ).toEqual([
      ["words:0", 1, 2],
      ["words:0", 21, 22],
    ]);
    expect(captionLines(result)).toEqual([".", "."]);
    expect(result.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [1, 2],
      [21, 22],
    ]);
    expect(result.cues.map(({ sourceLinks }) => sourceLinks)).toEqual([
      [exactSourceLink],
      [exactSourceLink],
    ]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("keeps an opening ASCII quote separate when lexical attachment would hide source regression", () => {
    const artifact = transcript([
      { text: "word", startUs: 100_000, endUs: 200_000 },
      { text: '"', startUs: 1_100_000, endUs: 1_200_000 },
    ]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 10, 13, 0), clip(301, 0, 3, 2)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const first = generateCaptionArtifactV1(input(artifact, projection));
    const second = generateCaptionArtifactV1(input(artifact, projection));

    expect(
      projection.occurrences.map(({ wordId, timelineRange }) => [
        wordId,
        timelineRange.start.value,
        timelineRange.end.value,
      ]),
    ).toEqual([
      ["words:1", 1, 2],
      ["words:0", 3, 4],
    ]);
    expect(captionLines(first)).toEqual(['"', "word"]);
    expect(first.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(first.cues.map(({ sourceLinks }) => sourceLinks)).toEqual([
      [
        {
          transcriptArtifactIdentityKey: artifact.identity.key,
          sourceStartUs: 1_100_000,
          sourceEndUs: 1_200_000,
          transcriptWordIds: ["words:1"],
        },
      ],
      [
        {
          transcriptArtifactIdentityKey: artifact.identity.key,
          sourceStartUs: 100_000,
          sourceEndUs: 200_000,
          transcriptWordIds: ["words:0"],
        },
      ],
    ]);
    expect(first).toEqual(second);
    expect(validateCaptionArtifactV1(first).valid).toBe(true);
  });

  it("keeps closing punctuation separate when attachment would hide source regression", () => {
    const artifact = transcript([
      { text: ".", startUs: 100_000, endUs: 200_000 },
      { text: "later", startUs: 1_100_000, endUs: 1_200_000 },
    ]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 10, 13, 0), clip(301, 0, 3, 2)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const result = generateCaptionArtifactV1(input(artifact, projection));

    expect(captionLines(result)).toEqual(["later", "."]);
    expect(result.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(result.cues.map(({ sourceLinks }) => sourceLinks)).toEqual([
      [
        {
          transcriptArtifactIdentityKey: artifact.identity.key,
          sourceStartUs: 1_100_000,
          sourceEndUs: 1_200_000,
          transcriptWordIds: ["words:1"],
        },
      ],
      [
        {
          transcriptArtifactIdentityKey: artifact.identity.key,
          sourceStartUs: 100_000,
          sourceEndUs: 200_000,
          transcriptWordIds: ["words:0"],
        },
      ],
    ]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it("fails deterministically when an attached punctuation source regression requires an impossible boundary", () => {
    const artifact = transcript([
      { text: ".", startUs: 100_000, endUs: 200_000 },
      { text: "later", startUs: 1_100_000, endUs: 1_200_000 },
    ]);
    const projection = projectTranscriptToTimeline({
      artifact,
      projection: project([clip(300, 10, 13, 0), clip(301, 0, 3, 2)]),
      sequenceId: id(2),
      trackId: id(10),
    });
    const generate = (): void => {
      generateCaptionArtifactV1(
        input(artifact, projection, {
          profile: profile({ minimumCueDuration: createRationalTime(3, timelineRate) }),
        }),
      );
    };

    expectFailure(generate, "invalid_range", "caption_constraints_unsatisfied");
    expectFailure(generate, "invalid_range", "caption_constraints_unsatisfied");
  });

  it("preserves touching source spans and merges only genuine overlap with ordered unique word IDs", () => {
    const artifact = transcript([
      { text: "one", startUs: 0, endUs: 200_000 },
      { text: "two", startUs: 200_000, endUs: 300_000 },
      { text: "three", startUs: 250_000, endUs: 400_000 },
    ]);
    const result = generateCaptionArtifactV1(input(artifact));

    expect(result.cues[0]?.sourceLinks).toEqual([
      {
        transcriptArtifactIdentityKey: artifact.identity.key,
        sourceStartUs: 0,
        sourceEndUs: 200_000,
        transcriptWordIds: ["words:0"],
      },
      {
        transcriptArtifactIdentityKey: artifact.identity.key,
        sourceStartUs: 200_000,
        sourceEndUs: 400_000,
        transcriptWordIds: ["words:1", "words:2"],
      },
    ]);
    expect(validateCaptionArtifactV1(result).valid).toBe(true);
  });

  it.each([
    {
      name: "minimum duration",
      make: () => {
        const artifact = transcript([{ text: "first" }, { text: "second" }]);
        return input(
          artifact,
          timeline(artifact, [
            { wordIndex: 0, start: 0, end: 1 },
            { wordIndex: 1, start: 1, end: 20 },
          ]),
          {
            profile: profile({
              minimumCueDuration: createRationalTime(2, timelineRate),
              maximumCueDuration: createRationalTime(10, timelineRate),
            }),
          },
        );
      },
    },
    {
      name: "maximum duration",
      make: () => {
        const artifact = transcript([{ text: "long" }]);
        return input(artifact, timeline(artifact, [{ wordIndex: 0, start: 0, end: 3 }]), {
          profile: profile({ maximumCueDuration: createRationalTime(2, timelineRate) }),
        });
      },
    },
    {
      name: "CPS",
      make: () => {
        const artifact = transcript([{ text: "12345" }]);
        return input(artifact, undefined, {
          profile: profile({
            maxCharactersPerSecond: 1,
            maximumCueDuration: createRationalTime(4, { numerator: 1, denominator: 1 }),
          }),
        });
      },
    },
    {
      name: "line count capacity",
      make: () => {
        const artifact = transcript([{ text: "aa" }, { text: "bb" }]);
        return input(
          artifact,
          timeline(artifact, [
            { wordIndex: 0, start: 0, end: 1 },
            { wordIndex: 1, start: 1, end: 2 },
          ]),
          {
            profile: profile({
              maxLinesPerCue: 1,
              maxCharactersPerLine: 2,
              minimumCueDuration: createRationalTime(2, timelineRate),
            }),
          },
        );
      },
    },
    {
      name: "mandatory repeated-word boundary",
      make: () => {
        const artifact = transcript([{ text: "again" }]);
        return input(
          artifact,
          timeline(artifact, [
            { wordIndex: 0, start: 0, end: 1 },
            { wordIndex: 0, start: 1, end: 2 },
          ]),
          {
            profile: profile({ maxCharactersPerSecond: 10 }),
          },
        );
      },
    },
  ])("fails closed without partial output when $name is unsatisfiable", ({ make }) => {
    expectFailure(
      () => generateCaptionArtifactV1(make()),
      "invalid_range",
      "caption_constraints_unsatisfied",
    );
  });

  it("rejects a minimum/maximum profile that becomes unrepresentable at the timeline rate", () => {
    const artifact = transcript([{ text: "word" }]);
    const duration = createRationalTime(15, { numerator: 100, denominator: 1 });
    expectFailure(
      () =>
        generateCaptionArtifactV1(
          input(artifact, undefined, {
            profile: profile({ minimumCueDuration: duration, maximumCueDuration: duration }),
          }),
        ),
      "invalid_range",
      "caption_contract_invalid",
    );
  });

  it("fails closed on transcript/projection identity and forged occurrence lineage mismatches", () => {
    const artifact = transcript([{ text: "word" }]);
    const identityMismatch = { ...timeline(artifact), artifactIdentityKey: "ff".repeat(32) };
    expectFailure(
      () => generateCaptionArtifactV1(input(artifact, identityMismatch)),
      "invalid_project",
      "caption_projection_mismatch",
    );

    const validTimeline = timeline(artifact);
    const forged = {
      ...validTimeline,
      occurrences: validTimeline.occurrences.map((occurrence) => ({
        ...occurrence,
        projectId: id(999),
      })),
    };
    expectFailure(
      () => generateCaptionArtifactV1(input(artifact, forged)),
      "invalid_project",
      "caption_projection_mismatch",
    );
  });

  it("rejects duplicate occurrence IDs and occurrence timeline rates that differ from the projection", () => {
    const artifact = transcript([{ text: "one" }, { text: "two" }]);
    const duplicateOccurrences = occurrencesFor(artifact).map((occurrence) => ({
      ...occurrence,
      occurrenceId: "duplicate",
    }));
    expectFailure(
      () =>
        generateCaptionArtifactV1(
          input(artifact, timeline(artifact, undefined, { occurrences: duplicateOccurrences })),
        ),
      "invalid_project",
      "caption_projection_invalid",
    );

    const wrongRate = { numerator: 24, denominator: 1 } as const;
    const wrongRateOccurrences = occurrencesFor(artifact, undefined, wrongRate);
    expectFailure(
      () =>
        generateCaptionArtifactV1(
          input(artifact, timeline(artifact, undefined, { occurrences: wrongRateOccurrences })),
        ),
      "invalid_project",
      "caption_projection_invalid",
    );
  });

  it("rejects a caption track ID equal to the projection source track ID", () => {
    const artifact = transcript([{ text: "word" }]);
    expectFailure(
      () => generateCaptionArtifactV1({ ...input(artifact), captionTrackId: id(10) }),
      "invalid_project",
      "caption_track_conflict",
    );
  });

  it("is stable for repeated, frozen, cloned, and shuffled inputs without mutating callers", () => {
    const artifact = transcript([{ text: "first" }, { text: "second" }, { text: "third" }]);
    const canonicalTimeline = timeline(artifact);
    const shuffledTimeline: TranscriptTimelineProjection = {
      ...canonicalTimeline,
      occurrences: [
        canonicalTimeline.occurrences[2]!,
        canonicalTimeline.occurrences[0]!,
        canonicalTimeline.occurrences[1]!,
      ],
    };
    const frozenInput = freezeDeep(input(artifact, shuffledTimeline));
    const before = structuredClone(frozenInput);

    const first = generateCaptionArtifactV1(frozenInput);
    const second = generateCaptionArtifactV1(frozenInput);
    const cloned = generateCaptionArtifactV1(structuredClone(frozenInput));
    const canonical = generateCaptionArtifactV1(input(artifact, canonicalTimeline));

    expect(first).toEqual(second);
    expect(first).toEqual(cloned);
    expect(first).toEqual(canonical);
    expect(frozenInput).toEqual(before);
    expect(Object.isFrozen(frozenInput)).toBe(true);
    expect(Object.isFrozen(frozenInput.timeline.occurrences)).toBe(true);
  });
});
