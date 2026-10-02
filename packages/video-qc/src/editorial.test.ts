import { describe, expect, it } from "vitest";
import {
  createRationalTime,
  videoAssetSchema,
  type ProjectClip,
  type VideoAsset,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import type { NarrativeBeat } from "@supa-video/produce";
import {
  editorialEvaluationSchema,
  editorialEvaluationSha256,
  evaluateEditorial,
  type EditorialInput,
} from "./editorial.js";
import { computeFindingId } from "./finding.js";

const STATE = "a".repeat(64);
const REVISION = "00000000-0000-4000-8000-0000000000aa";
const RATE = { numerator: 30, denominator: 1 } as const;

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function asset(index: number, name: string): VideoAsset {
  return videoAssetSchema.parse({
    id: uuid(index),
    displayName: name,
    locator: { relativePath: `media/${name}` },
    probe: {
      durationMicroseconds: 120_000_000,
      averageFrameRate: RATE,
      realFrameRate: RATE,
      variableFrameRate: false,
      width: 1920,
      height: 1080,
      videoCodecName: "h264",
      audio: null,
      fileSizeBytes: 1000,
    },
  });
}

/** Clip of `assetIndex` placed at `startS` for `lengthS`, from source second `sourceS`. */
function clip(
  id: number,
  assetIndex: number,
  startS: number,
  lengthS: number,
  sourceS = 0,
): ProjectClip {
  return {
    id: uuid(id),
    source: { kind: "asset", assetId: uuid(assetIndex) },
    timelineStart: createRationalTime(startS * 30, RATE),
    sourceIn: createRationalTime(sourceS * 30, RATE),
    sourceOut: createRationalTime((sourceS + lengthS) * 30, RATE),
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

function sequence(clips: ProjectClip[], hidden = false): VideoSequenceV2 {
  return {
    id: uuid(900),
    name: "Main",
    rate: RATE,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{ id: uuid(901), name: "V1", kind: "video", hidden, clips }],
    markers: [],
  };
}

function beat(
  order: number,
  startS: number,
  endS: number,
  extra: Partial<NarrativeBeat> = {},
): NarrativeBeat {
  return {
    schemaVersion: 1,
    id: `beat-${order.toString(16).padStart(16, "0")}`,
    order,
    text: `Beat ${order}`,
    language: "en",
    startUs: startS * 1_000_000,
    endUs: endS * 1_000_000,
    mustShow: [],
    mustNotShow: [],
    orientation: "any",
    intent: { kind: "owned-footage" },
    ...extra,
  };
}

const ASSETS = [
  asset(1, "river canyon.mp4"),
  asset(2, "city skyline.mp4"),
  asset(3, "logo brand.mp4"),
];

function input(overrides: Partial<EditorialInput>): EditorialInput {
  return {
    revisionId: REVISION,
    revisionStateHash: STATE,
    sequence: sequence([clip(10, 1, 0, 5), clip(11, 2, 5, 5)]),
    assets: ASSETS,
    beats: [],
    ...overrides,
  };
}

async function kinds(overrides: Partial<EditorialInput>): Promise<string[]> {
  const evaluation = await evaluateEditorial(input(overrides));
  return evaluation.findings.map((finding) => `${finding.kind}:${finding.severity}`);
}

describe("editorial checks", () => {
  it.each<[string, Partial<EditorialInput>, string[]]>([
    ["clean timeline", {}, []],
    [
      "same shot reused within the window",
      { sequence: sequence([clip(10, 1, 0, 5), clip(11, 2, 5, 5), clip(12, 1, 10, 5)]) },
      ["repeated_asset:warning"],
    ],
    [
      "same asset but a different shot",
      { sequence: sequence([clip(10, 1, 0, 5), clip(11, 2, 5, 5), clip(12, 1, 10, 5, 60)]) },
      [],
    ],
    [
      "same shot reused outside the window",
      { sequence: sequence([clip(10, 1, 0, 5), clip(11, 2, 5, 40), clip(12, 1, 45, 5)]) },
      [],
    ],
    [
      "clip of a removed asset",
      { assets: ASSETS.filter((item) => item.id !== uuid(2)) },
      ["missing_media:blocker"],
    ],
    ["beat with picture", { beats: [beat(0, 0, 10)] }, []],
    [
      "beat past the end of the picture",
      { beats: [beat(0, 0, 10), beat(1, 10, 20)] },
      ["uncovered_beat:blocker"],
    ],
    [
      "beat on a hidden track only",
      { sequence: sequence([clip(10, 1, 0, 10)], true), beats: [beat(0, 0, 10)] },
      ["uncovered_beat:blocker"],
    ],
    ["must-show present", { beats: [beat(0, 0, 5, { mustShow: ["canyon"] })] }, []],
    [
      "must-show missing",
      { beats: [beat(0, 0, 5, { mustShow: ["harbour"] })] },
      ["must_show_missing:warning"],
    ],
    [
      "must-show via asset index words",
      {
        beats: [beat(0, 0, 5, { mustShow: ["waterfall"] })],
        assetTokens: new Map([[uuid(1), ["waterfall"]]]),
      },
      [],
    ],
    [
      "must-not-show present",
      { beats: [beat(0, 5, 10, { mustNotShow: ["skyline"] })] },
      ["must_not_show_present:blocker"],
    ],
    ["must-not-show absent", { beats: [beat(0, 0, 5, { mustNotShow: ["skyline"] })] }, []],
  ])("%s", async (_name, overrides, expected) => {
    expect(await kinds(overrides)).toEqual(expected);
  });

  it("flags unresolved first-cut markers that have no picture when no beat plan exists", async () => {
    const base = sequence([clip(10, 1, 0, 5)]);
    const withMarker: VideoSequenceV2 = {
      ...base,
      markers: [
        {
          id: uuid(950),
          time: createRationalTime(300, RATE),
          label: "Unresolved · Beat 3: harbour",
        },
        {
          id: uuid(951),
          time: createRationalTime(30, RATE),
          label: "Unresolved · Beat 1: covered",
        },
      ],
    };
    expect(await kinds({ sequence: withMarker })).toEqual(["uncovered_beat:blocker"]);
  });

  it("binds every finding to the revision with editorial source and verifiable ids", async () => {
    const evaluation = await evaluateEditorial(
      input({ beats: [beat(0, 0, 10), beat(1, 10, 20, { mustShow: ["harbour"] })] }),
    );
    expect(editorialEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    expect(evaluation).toMatchObject({ revisionId: REVISION, revisionStateHash: STATE });
    for (const finding of evaluation.findings) {
      expect(finding.source).toBe("editorial");
      expect(finding.findingId).toBe(
        await computeFindingId({ ...finding, revisionStateHash: STATE }),
      );
    }
  });

  it("is deterministic, and ids do not depend on frame size", async () => {
    const overrides = { beats: [beat(0, 0, 10), beat(1, 10, 20)] };
    const landscape = await evaluateEditorial(input(overrides));
    const portrait = await evaluateEditorial(
      input({ ...overrides, sequence: { ...input({}).sequence, width: 1080, height: 1920 } }),
    );
    expect(portrait.findings.map((finding) => finding.findingId)).toEqual(
      landscape.findings.map((finding) => finding.findingId),
    );
    expect(await editorialEvaluationSha256(portrait)).toBe(
      await editorialEvaluationSha256(landscape),
    );
  });

  it("changes ids when the revision changes", async () => {
    const overrides = { beats: [beat(0, 10, 20)] };
    const a = await evaluateEditorial(input(overrides));
    const b = await evaluateEditorial(input({ ...overrides, revisionStateHash: "b".repeat(64) }));
    expect(a.findings[0]?.findingId).not.toBe(b.findings[0]?.findingId);
  });

  it("skips a graphics track and reports the same findings as without it", async () => {
    const base = input({ beats: [beat(0, 0, 10), beat(1, 10, 20)] });
    const withGraphics: EditorialInput = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: [
          ...base.sequence.tracks,
          { id: uuid(950), name: "Graphics 1", kind: "graphics", graphicsClips: [] },
        ],
      },
    };

    const evaluation = await evaluateEditorial(withGraphics);

    expect(evaluation).toEqual(await evaluateEditorial(base));
  });
});
