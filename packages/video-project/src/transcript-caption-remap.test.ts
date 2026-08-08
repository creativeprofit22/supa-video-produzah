import {
  VideoDomainError,
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type RationalRate,
} from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  validateCaptionArtifactV1,
  type CaptionArtifactV1,
  type CaptionValidationProfileV1,
} from "@supa-video/media";
import { describe, expect, it } from "vitest";

import {
  remapCaptionArtifactV1,
  type RemapCaptionArtifactV1Input,
} from "./transcript-caption-remap.js";
import type {
  TranscriptTimelineOccurrence,
  TranscriptTimelineProjection,
} from "./transcript-edit-mapping.js";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const projectId = id(900_001);
const sequenceId = id(2);
const sourceTrackId = id(10);
const captionTrackId = id(20);
const assetId = id(1);
const artifactIdentityKey = "ab".repeat(32);
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};

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

const sourceRevision = revision(7);
const targetRevision = revision(8);

interface WordSpec {
  readonly id: string;
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
}

interface CueSpec {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly wordIds: readonly string[];
  readonly lines?: readonly string[];
}

interface OccurrenceSpec {
  readonly id: string;
  readonly wordId: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly timelineStart: number;
  readonly timelineEnd: number;
  readonly text?: string;
  readonly sourceStartUs?: number;
  readonly sourceEndUs?: number;
  readonly sourceRate?: RationalRate;
  readonly timelineRate?: RationalRate;
  readonly clipId?: string;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function profile(overrides: Partial<CaptionValidationProfileV1> = {}): CaptionValidationProfileV1 {
  return {
    schemaVersion: 1,
    maxLinesPerCue: 4,
    maxCharactersPerLine: 1_024,
    maxCharactersPerSecond: 1_000,
    minimumCueDuration: createRationalTime(0, rate),
    maximumCueDuration: createRationalTime(100, rate),
    safeArea: {
      topPermille: 30,
      rightPermille: 80,
      bottomPermille: 70,
      leftPermille: 40,
    },
    ...overrides,
  };
}

function artifact(
  words: readonly WordSpec[],
  cues: readonly CueSpec[],
  validationProfile = profile(),
): CaptionArtifactV1 {
  const byId = new Map(words.map((word) => [word.id, word]));
  return freezeDeep(
    captionArtifactV1Schema.parse({
      schemaVersion: 1,
      trackLink: {
        schemaVersion: 1,
        projectId,
        projectRevision: sourceRevision,
        sequenceId,
        captionTrackId,
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
      validationProfile,
      cues: cues.map((cue) => {
        const linked = cue.wordIds.map((wordId) => {
          const word = byId.get(wordId);
          if (word === undefined) throw new Error(`Unknown fixture word ${wordId}`);
          return word;
        });
        return {
          schemaVersion: 1,
          cueId: cue.id,
          start: createRationalTime(cue.start, rate),
          end: createRationalTime(cue.end, rate),
          lines: cue.lines ?? [linked.map(({ text }) => text).join(" ")],
          anchor: { xPermille: 500, yPermille: 900 },
          sourceLinks: [
            {
              transcriptArtifactIdentityKey: artifactIdentityKey,
              sourceStartUs: Math.min(...linked.map(({ startUs }) => startUs)),
              sourceEndUs: Math.max(...linked.map(({ endUs }) => endUs)),
              transcriptWordIds: [...cue.wordIds],
            },
          ],
        };
      }),
    }),
  );
}

function occurrences(
  words: readonly WordSpec[],
  specs: readonly OccurrenceSpec[],
): readonly TranscriptTimelineOccurrence[] {
  const byId = new Map(words.map((word) => [word.id, word]));
  return specs.map((spec, index) => {
    const word = byId.get(spec.wordId);
    if (word === undefined) throw new Error(`Unknown fixture word ${spec.wordId}`);
    const sourceRangeRate = spec.sourceRate ?? rate;
    const timelineRangeRate = spec.timelineRate ?? rate;
    return {
      artifactIdentityKey,
      sourceIdentity,
      wordId: word.id,
      text: spec.text ?? word.text,
      sourceStartUs: spec.sourceStartUs ?? word.startUs,
      sourceEndUs: spec.sourceEndUs ?? word.endUs,
      occurrenceId: spec.id,
      projectId,
      projectRevision: targetRevision,
      sequenceId,
      trackId: sourceTrackId,
      clipId: spec.clipId ?? id(300 + index),
      assetId,
      sourceRange: {
        start: createRationalTime(spec.sourceStart, sourceRangeRate),
        end: createRationalTime(spec.sourceEnd, sourceRangeRate),
      },
      timelineRange: {
        start: createRationalTime(spec.timelineStart, timelineRangeRate),
        end: createRationalTime(spec.timelineEnd, timelineRangeRate),
      },
    };
  });
}

function timeline(
  values: readonly TranscriptTimelineOccurrence[],
  overrides: Partial<TranscriptTimelineProjection> = {},
): TranscriptTimelineProjection {
  return {
    schemaVersion: 1,
    artifactIdentityKey,
    sourceIdentity,
    projectId,
    projectRevision: targetRevision,
    sequenceId,
    trackId: sourceTrackId,
    timelineRate: rate,
    occurrences: values,
    ...overrides,
  };
}

interface ProjectOptions {
  readonly revision?: ProjectRevisionDescriptorV2;
  readonly sequenceRate?: RationalRate;
  readonly sourceTrack?: "present" | "missing";
  readonly captionTrack?: "present" | "missing" | "locked" | "wrong-kind";
}

function project(options: ProjectOptions = {}): ProjectProjection {
  const tracks: ProjectProjection["state"]["sequences"][number]["tracks"] = [];
  if ((options.sourceTrack ?? "present") === "present") {
    tracks.push({ id: sourceTrackId, name: "Video", kind: "video", clips: [] });
  }
  if ((options.captionTrack ?? "present") === "wrong-kind") {
    tracks.push({ id: captionTrackId, name: "Not captions", kind: "audio", clips: [] });
  } else if ((options.captionTrack ?? "present") !== "missing") {
    tracks.push({
      id: captionTrackId,
      name: "Captions",
      kind: "caption",
      ...((options.captionTrack ?? "present") === "locked" ? { locked: true } : {}),
      captions: [],
    });
  }
  const projectRevision = options.revision ?? targetRevision;
  const sequenceRate = options.sequenceRate ?? rate;
  return {
    projectId,
    name: "Caption remap fixture",
    revision: projectRevision,
    state: {
      assets: [
        {
          id: assetId,
          displayName: "source.mp4",
          locator: { absolutePath: "/media/source.mp4" },
          probe: {
            durationMicroseconds: 100_000_000,
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
          id: sequenceId,
          name: "Main",
          rate: sequenceRate,
          width: 1_920,
          height: 1_080,
          audioSampleRate: 48_000,
          tracks,
          markers: [],
        },
      ],
      activeSequenceId: sequenceId,
    },
    canUndo: true,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: projectRevision.number,
    recoveryStatus: "clean",
    replayedRecordCount: projectRevision.number,
  };
}

function input(
  words: readonly WordSpec[],
  cues: readonly CueSpec[],
  occurrenceSpecs: readonly OccurrenceSpec[],
  options: {
    readonly profile?: CaptionValidationProfileV1;
    readonly timeline?: Partial<TranscriptTimelineProjection>;
    readonly project?: ProjectOptions;
  } = {},
): RemapCaptionArtifactV1Input {
  const captionArtifact = artifact(words, cues, options.profile);
  const mapped = occurrences(words, occurrenceSpecs);
  return freezeDeep({
    artifact: captionArtifact,
    timeline: timeline(mapped, options.timeline),
    projection: project(options.project),
  });
}

function expectFailure(
  run: () => unknown,
  code: VideoDomainError["code"],
  reason: string,
): VideoDomainError {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(VideoDomainError);
  expect((failure as VideoDomainError).code).toBe(code);
  expect((failure as VideoDomainError).details.reason).toBe(reason);
  return failure as VideoDomainError;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

const oneFrameWord: WordSpec = { id: "word:0", text: "one", startUs: 0, endUs: 100_000 };

function outcomeFixture(
  outcome: "retained" | "moved" | "trimmed" | "split" | "duplicated" | "orphaned",
): RemapCaptionArtifactV1Input {
  if (outcome === "trimmed") {
    const word = { ...oneFrameWord, text: "trim", endUs: 200_000 };
    return input(
      [word],
      [{ id: "cue-trimmed", start: 0, end: 2, wordIds: [word.id] }],
      [
        {
          id: "trim-half",
          wordId: word.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 5,
          timelineEnd: 6,
        },
      ],
    );
  }
  if (outcome === "split") {
    const words = [oneFrameWord, { id: "word:1", text: "two", startUs: 100_000, endUs: 200_000 }];
    return input(
      words,
      [{ id: "cue-split", start: 0, end: 2, wordIds: words.map(({ id }) => id) }],
      [
        {
          id: "split-a",
          wordId: words[0]!.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 5,
          timelineEnd: 6,
        },
        {
          id: "split-b",
          wordId: words[1]!.id,
          sourceStart: 1,
          sourceEnd: 2,
          timelineStart: 10,
          timelineEnd: 11,
        },
      ],
    );
  }
  const occurrenceSpecs: OccurrenceSpec[] = [];
  if (outcome !== "orphaned") {
    occurrenceSpecs.push({
      id: "whole-a",
      wordId: oneFrameWord.id,
      sourceStart: 0,
      sourceEnd: 1,
      timelineStart: outcome === "retained" ? 0 : 5,
      timelineEnd: outcome === "retained" ? 1 : 6,
    });
  }
  if (outcome === "duplicated") {
    occurrenceSpecs.push({
      id: "whole-b",
      wordId: oneFrameWord.id,
      sourceStart: 0,
      sourceEnd: 1,
      timelineStart: 10,
      timelineEnd: 11,
    });
  }
  return input(
    [oneFrameWord],
    [{ id: `cue-${outcome}`, start: 0, end: 1, wordIds: [oneFrameWord.id] }],
    occurrenceSpecs,
  );
}

describe("caption remap outcomes", () => {
  it.each([
    ["retained", [[0, 1]]],
    ["moved", [[5, 6]]],
    ["trimmed", [[5, 6]]],
    [
      "split",
      [
        [5, 6],
        [10, 11],
      ],
    ],
    [
      "duplicated",
      [
        [5, 6],
        [10, 11],
      ],
    ],
    ["orphaned", []],
  ] as const)("reports %s with exact target cue geometry", (outcome, ranges) => {
    const result = remapCaptionArtifactV1(outcomeFixture(outcome));

    expect(result.report.cues).toHaveLength(1);
    expect(result.report.cues[0]?.outcome).toBe(outcome);
    expect(
      result.report.cues[0]?.targetCues.map(({ start, end }) => [start.value, end.value]),
    ).toEqual(ranges);
    expect(result.artifact.cues.map(({ start, end }) => [start.value, end.value])).toEqual(ranges);
    expect(result.report.sourceProjectRevision).toEqual(sourceRevision);
    expect(result.report.targetProjectRevision).toEqual(targetRevision);
    expect(result.artifact.trackLink.projectRevision).toEqual(targetRevision);
    expect(validateCaptionArtifactV1(result.artifact).valid).toBe(true);
  });
});

describe("caption remap source geometry", () => {
  it("stitches a truly contiguous split word before classifying and preserves its exact source link", () => {
    const word = { id: "word:joined", text: "joined", startUs: 0, endUs: 200_000 };
    const value = input(
      [word],
      [{ id: "cue-joined", start: 0, end: 2, wordIds: [word.id] }],
      [
        {
          id: "right",
          wordId: word.id,
          sourceStart: 1,
          sourceEnd: 2,
          timelineStart: 1,
          timelineEnd: 2,
          clipId: id(302),
        },
        {
          id: "left",
          wordId: word.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 0,
          timelineEnd: 1,
          clipId: id(301),
        },
      ],
    );

    const result = remapCaptionArtifactV1(value);

    expect(result.report.cues[0]?.outcome).toBe("retained");
    expect(result.artifact.cues).toHaveLength(1);
    expect([result.artifact.cues[0]?.start.value, result.artifact.cues[0]?.end.value]).toEqual([
      0, 2,
    ]);
    expect(result.artifact.cues[0]?.sourceLinks).toEqual(value.artifact.cues[0]?.sourceLinks);
  });

  it("retains a complete multiword placement whose source link spans both words", () => {
    const words = [oneFrameWord, { id: "word:1", text: "two", startUs: 100_000, endUs: 200_000 }];
    const value = input(
      words,
      [{ id: "cue-complete", start: 0, end: 2, wordIds: words.map(({ id }) => id) }],
      [
        {
          id: "complete-a",
          wordId: words[0]!.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 0,
          timelineEnd: 1,
        },
        {
          id: "complete-b",
          wordId: words[1]!.id,
          sourceStart: 1,
          sourceEnd: 2,
          timelineStart: 1,
          timelineEnd: 2,
        },
      ],
    );

    const result = remapCaptionArtifactV1(value);

    expect(result.report.cues[0]?.outcome).toBe("retained");
    expect(result.artifact.cues[0]?.lines).toEqual(["one two"]);
    expect(result.artifact.cues[0]?.sourceLinks).toEqual(value.artifact.cues[0]?.sourceLinks);
  });

  it("splits disjoint word coverage and trims partial source coverage with rebuilt lineage", () => {
    const split = remapCaptionArtifactV1(outcomeFixture("split"));
    const trimmedInput = outcomeFixture("trimmed");
    const trimmed = remapCaptionArtifactV1(trimmedInput);

    expect(split.report.cues[0]).toMatchObject({ outcome: "split" });
    expect(split.artifact.cues.map(({ lines }) => lines)).toEqual([["one"], ["two"]]);
    expect(split.artifact.cues.map(({ sourceLinks }) => sourceLinks)).toEqual([
      [
        {
          transcriptArtifactIdentityKey: artifactIdentityKey,
          sourceStartUs: 0,
          sourceEndUs: 100_000,
          transcriptWordIds: ["word:0"],
        },
      ],
      [
        {
          transcriptArtifactIdentityKey: artifactIdentityKey,
          sourceStartUs: 100_000,
          sourceEndUs: 200_000,
          transcriptWordIds: ["word:1"],
        },
      ],
    ]);
    expect(trimmed.report.cues[0]).toMatchObject({ outcome: "trimmed" });
    expect(trimmed.artifact.cues[0]?.lines).toEqual(["trim"]);
    expect(trimmed.artifact.cues[0]?.sourceLinks).toEqual(
      trimmedInput.artifact.cues[0]?.sourceLinks,
    );
  });
});

describe("caption remap duplication and ambiguity", () => {
  it("duplicates deterministically from shuffled occurrences with stable IDs and report ordering", () => {
    const canonical = outcomeFixture("duplicated");
    const shuffled = freezeDeep({
      ...canonical,
      timeline: {
        ...canonical.timeline,
        occurrences: [canonical.timeline.occurrences[1]!, canonical.timeline.occurrences[0]!],
      },
    });

    const first = remapCaptionArtifactV1(canonical);
    const second = remapCaptionArtifactV1(shuffled);

    expect(second).toEqual(first);
    expect(first.report.cues[0]).toMatchObject({ outcome: "duplicated" });
    expect(first.artifact.cues.map(({ cueId }) => cueId)).toEqual([
      "cue-duplicated",
      "caption-remap-000001",
    ]);
    expect(first.report.cues[0]?.targetCues.map(({ cueId }) => cueId)).toEqual([
      "cue-duplicated",
      "caption-remap-000001",
    ]);
  });

  it("skips every source cue ID when allocating fan-out IDs, including orphaned IDs", () => {
    const orphan = { id: "word:orphan-id", text: "gone", startUs: 100_000, endUs: 200_000 };
    const value = input(
      [oneFrameWord, orphan],
      [
        { id: "cue-duplicated", start: 0, end: 1, wordIds: [oneFrameWord.id] },
        { id: "caption-remap-000001", start: 1, end: 2, wordIds: [orphan.id] },
      ],
      [
        {
          id: "whole-a",
          wordId: oneFrameWord.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 5,
          timelineEnd: 6,
        },
        {
          id: "whole-b",
          wordId: oneFrameWord.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 10,
          timelineEnd: 11,
        },
      ],
    );

    const result = remapCaptionArtifactV1(value);

    expect(result.artifact.cues.map(({ cueId }) => cueId)).toEqual([
      "cue-duplicated",
      "caption-remap-000002",
    ]);
    expect(result.report.cues.map(({ outcome }) => outcome)).toEqual(["duplicated", "orphaned"]);
  });

  it.each([
    {
      name: "mixed full and partial placements",
      specs: [
        {
          id: "full",
          wordId: "word:wide",
          sourceStart: 0,
          sourceEnd: 2,
          timelineStart: 0,
          timelineEnd: 2,
        },
        {
          id: "partial",
          wordId: "word:wide",
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 10,
          timelineEnd: 11,
        },
      ],
    },
    {
      name: "repeated partial placements",
      specs: [
        {
          id: "partial-a",
          wordId: "word:wide",
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 0,
          timelineEnd: 1,
        },
        {
          id: "partial-b",
          wordId: "word:wide",
          sourceStart: 1,
          sourceEnd: 2,
          timelineStart: 11,
          timelineEnd: 12,
        },
      ],
    },
  ])("fails closed for $name", ({ specs }) => {
    const word = { id: "word:wide", text: "wide", startUs: 0, endUs: 200_000 };
    const value = input([word], [{ id: "cue-wide", start: 0, end: 2, wordIds: [word.id] }], specs);

    expectFailure(
      () => remapCaptionArtifactV1(value),
      "invalid_project",
      "caption_remap_ambiguous_occurrences",
    );
  });
});

describe("caption remap fail-closed validation matrix", () => {
  const valid = (): RemapCaptionArtifactV1Input => outcomeFixture("retained");

  it.each([
    {
      name: "timeline and projection revision mismatch",
      reason: "caption_remap_stale_revision",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: project({ revision: revision(9) }) });
      },
    },
    {
      name: "non-newer target revision",
      reason: "caption_remap_stale_revision",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({
          ...value,
          timeline: { ...value.timeline, projectRevision: sourceRevision },
          projection: project({ revision: sourceRevision }),
        });
      },
    },
    {
      name: "stale project identity",
      reason: "caption_remap_stale_identity",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: { ...value.projection, projectId: id(999) } });
      },
    },
    {
      name: "stale transcript identity",
      reason: "caption_remap_stale_identity",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({
          ...value,
          timeline: { ...value.timeline, artifactIdentityKey: "cd".repeat(32) },
        });
      },
    },
    {
      name: "stale source identity",
      reason: "caption_remap_stale_identity",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({
          ...value,
          timeline: {
            ...value.timeline,
            sourceIdentity: { ...sourceIdentity, digest: "34".repeat(32) },
          },
        });
      },
    },
    {
      name: "sequence rate change",
      reason: "caption_remap_rate_changed",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        const changedRate = { numerator: 20, denominator: 1 } as const;
        return freezeDeep({
          ...value,
          timeline: { ...value.timeline, timelineRate: changedRate },
          projection: project({ sequenceRate: changedRate }),
        });
      },
    },
    {
      name: "missing source track",
      reason: "caption_remap_source_track_missing",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: project({ sourceTrack: "missing" }) });
      },
    },
    {
      name: "missing caption track",
      reason: "caption_remap_caption_track_missing",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: project({ captionTrack: "missing" }) });
      },
    },
    {
      name: "wrong-kind caption track",
      reason: "caption_remap_caption_track_missing",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: project({ captionTrack: "wrong-kind" }) });
      },
    },
    {
      name: "locked caption track",
      reason: "caption_remap_caption_track_locked",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        return freezeDeep({ ...value, projection: project({ captionTrack: "locked" }) });
      },
    },
    {
      name: "conflicting repeated-word metadata",
      reason: "caption_remap_projection_invalid",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        const original = value.timeline.occurrences[0]!;
        return freezeDeep({
          ...value,
          timeline: {
            ...value.timeline,
            occurrences: [
              original,
              {
                ...original,
                occurrenceId: "metadata-conflict",
                text: "different",
                timelineRange: {
                  start: createRationalTime(5, rate),
                  end: createRationalTime(6, rate),
                },
              },
            ],
          },
        });
      },
    },
    {
      name: "non-translational occurrence transform",
      reason: "caption_remap_projection_invalid",
      code: "invalid_project" as const,
      make: () => {
        const value = valid();
        const original = value.timeline.occurrences[0]!;
        return freezeDeep({
          ...value,
          timeline: {
            ...value.timeline,
            occurrences: [
              {
                ...original,
                timelineRange: {
                  start: createRationalTime(0, rate),
                  end: createRationalTime(2, rate),
                },
              },
            ],
          },
        });
      },
    },
  ])("rejects $name with the exact domain reason", ({ make, code, reason }) => {
    expectFailure(() => remapCaptionArtifactV1(make()), code, reason);
  });
});

describe("caption remap atomicity and immutability", () => {
  it("throws atomically for generated overlap and unsatisfied partial-cue constraints", () => {
    const words = [oneFrameWord, { id: "word:1", text: "two", startUs: 100_000, endUs: 200_000 }];
    const overlap = input(
      words,
      [
        { id: "cue-a", start: 0, end: 1, wordIds: [words[0]!.id] },
        { id: "cue-b", start: 1, end: 2, wordIds: [words[1]!.id] },
      ],
      [
        {
          id: "overlap-a",
          wordId: words[0]!.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 10,
          timelineEnd: 11,
        },
        {
          id: "overlap-b",
          wordId: words[1]!.id,
          sourceStart: 1,
          sourceEnd: 2,
          timelineStart: 10,
          timelineEnd: 11,
        },
      ],
    );
    const longWord = { id: "word:long", text: "toolong", startUs: 0, endUs: 200_000 };
    const constrained = input(
      [longWord],
      [{ id: "cue-constrained", start: 0, end: 2, wordIds: [longWord.id], lines: ["ok"] }],
      [
        {
          id: "partial-long",
          wordId: longWord.id,
          sourceStart: 0,
          sourceEnd: 1,
          timelineStart: 0,
          timelineEnd: 1,
        },
      ],
      {
        profile: profile({ maxLinesPerCue: 1, maxCharactersPerLine: 2 }),
      },
    );
    const overlapBefore = structuredClone(overlap);
    const constrainedBefore = structuredClone(constrained);

    const overlapFailure = expectFailure(
      () => remapCaptionArtifactV1(overlap),
      "invalid_range",
      "caption_remap_constraints_unsatisfied",
    );
    const constrainedFailure = expectFailure(
      () => remapCaptionArtifactV1(constrained),
      "invalid_range",
      "caption_remap_constraints_unsatisfied",
    );
    expect(overlapFailure.details.constraint).toBe("overlap");
    expect(constrainedFailure.details.constraint).toBe("wrapping");
    expect(overlap).toEqual(overlapBefore);
    expect(constrained).toEqual(constrainedBefore);
  });

  it("is deeply deterministic for frozen, cloned, repeated, canonical, and shuffled callers", () => {
    const canonical = outcomeFixture("duplicated");
    const shuffled = freezeDeep({
      ...canonical,
      timeline: {
        ...canonical.timeline,
        occurrences: [canonical.timeline.occurrences[1]!, canonical.timeline.occurrences[0]!],
      },
    });
    const before = structuredClone(shuffled);

    const first = remapCaptionArtifactV1(shuffled);
    const second = remapCaptionArtifactV1(shuffled);
    const cloned = remapCaptionArtifactV1(structuredClone(shuffled));
    const ordered = remapCaptionArtifactV1(canonical);

    expect(first).toEqual(second);
    expect(first).toEqual(cloned);
    expect(first).toEqual(ordered);
    expect(shuffled).toEqual(before);
    expectDeepFrozen(shuffled);
    expectDeepFrozen(first);
  });
});
