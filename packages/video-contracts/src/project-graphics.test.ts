import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseVideoProjectFile } from "./migrations.js";
import {
  graphicsClipSchema,
  graphicsLayerSchema,
  type GraphicsKeyframe,
  migrateGraphicsClip,
  splitGraphicsText,
} from "./project-graphics.js";
import {
  canToggleTrackVisibility,
  isMediaTrack,
  isTrackHidden,
  isTrackLocked,
  isTrackMuted,
  projectTrackSchema,
  videoProjectSnapshotV2Schema,
} from "./project-v2.js";

const rate = { rateNumerator: 30, rateDenominator: 1 } as const;
const hold = (value: number): GraphicsKeyframe[] => [{ timeMicroseconds: 0, value }];
const tracks = {
  x: hold(100),
  y: hold(200),
  scale: hold(1),
  rotation: hold(0),
  opacity: [
    {
      timeMicroseconds: 0,
      value: 0,
      easing: { kind: "spring" as const, bounce: 0.3, durationMs: 400 },
    },
    { timeMicroseconds: 500_000, value: 1 },
  ],
};
const rectLayer = {
  kind: "rect" as const,
  width: 400,
  height: 120,
  cornerRadius: 24,
  fill: "#1E88E5",
  ...tracks,
};
const textLayer = {
  kind: "text" as const,
  text: "Hello big world",
  fontSize: 64,
  fill: "#FFFFFF",
  units: {
    split: "word" as const,
    opacity: [hold(1), hold(1), hold(1)],
    offsetY: [hold(0), hold(0), hold(0)],
  },
  ...tracks,
};
const clip = {
  graphicsVersion: 1 as const,
  id: "30000000-0000-4000-8000-000000000001",
  timelineStart: { value: 30, ...rate },
  duration: { value: 90, ...rate },
  fontKey: "segoe-ui-bold" as const,
  layers: [rectLayer, textLayer],
};
const graphicsTrack = {
  id: "30000000-0000-4000-8000-000000000002",
  name: "Graphics 1",
  kind: "graphics" as const,
  graphicsClips: [clip],
};

function snapshotWith(stateTracks: unknown[], assets: unknown[] = []): unknown {
  return {
    schemaVersion: 2,
    id: "00000000-0000-4000-8000-000000000001",
    name: "Graphics",
    createdAt: "2026-07-26T12:00:00Z",
    updatedAt: "2026-07-26T12:00:00Z",
    storageGenerationId: "00000000-0000-4000-8000-000000000002",
    revision: {
      number: 0,
      id: "00000000-0000-4000-8000-000000000003",
      parentId: null,
      committedAt: "2026-07-26T12:00:00Z",
      operationId: "00000000-0000-4000-8000-000000000004",
      stateHash: "0".repeat(64),
    },
    state: {
      assets,
      sequences: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          name: "Main",
          rate: { numerator: 30, denominator: 1 },
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks: stateTracks,
          markers: [],
        },
      ],
      activeSequenceId: "00000000-0000-4000-8000-000000000010",
    },
    history: { undoStack: [], redoStack: [] },
    lastAppliedRecordNumber: 0,
    lastRecordHash: "0".repeat(64),
  };
}

const stillAsset = {
  id: "30000000-0000-4000-8000-000000000003",
  displayName: "logo.png",
  locator: { absolutePath: "C:\\Media\\logo.png" },
  probe: {
    durationMicroseconds: 1_000_000,
    averageFrameRate: { numerator: 1, denominator: 1 },
    realFrameRate: { numerator: 1, denominator: 1 },
    variableFrameRate: false,
    width: 512,
    height: 256,
    videoCodecName: "png",
    audio: null,
    fileSizeBytes: 20_000,
    still: true,
  },
};
const imageLayer = {
  kind: "image" as const,
  assetId: stillAsset.id,
  width: 256,
  height: 128,
  ...tracks,
};

describe("graphics clip entity", () => {
  it("accepts rect, text-with-units and image layers with all five keyframe tracks", () => {
    const parsed = graphicsClipSchema.parse({
      ...clip,
      layers: [rectLayer, textLayer, imageLayer],
    });

    expect(parsed.layers.map((layer) => layer.kind)).toEqual(["rect", "text", "image"]);
    expect(parsed.layers[0]?.opacity[0]?.easing).toEqual({
      kind: "spring",
      bounce: 0.3,
      durationMs: 400,
    });
  });

  it.each([
    ["unknown field", { ...clip, extra: 1 }],
    ["zero duration", { ...clip, duration: { value: 0, ...rate } }],
    ["mixed rates", { ...clip, duration: { value: 90, rateNumerator: 25, rateDenominator: 1 } }],
    ["unknown font", { ...clip, fontKey: "comic-sans" }],
    ["65 layers", { ...clip, layers: Array.from({ length: 65 }, () => rectLayer) }],
    [
      "unordered keyframes",
      {
        ...clip,
        layers: [
          {
            ...rectLayer,
            x: [
              { timeMicroseconds: 10, value: 0 },
              { timeMicroseconds: 10, value: 1 },
            ],
          },
        ],
      },
    ],
    ["empty track", { ...clip, layers: [{ ...rectLayer, scale: [] }] }],
    ["opacity above 1", { ...clip, layers: [{ ...rectLayer, opacity: hold(1.5) }] }],
    ["negative scale", { ...clip, layers: [{ ...rectLayer, scale: hold(-1) }] }],
    ["bad fill", { ...clip, layers: [{ ...rectLayer, fill: "red" }] }],
    ["corner radius too big", { ...clip, layers: [{ ...rectLayer, cornerRadius: 61 }] }],
    [
      "control characters",
      { ...clip, layers: [{ ...textLayer, units: undefined, text: "a\u0007" }] },
    ],
    [
      "text over 500 chars",
      { ...clip, layers: [{ ...textLayer, units: undefined, text: "x".repeat(501) }] },
    ],
    [
      "unit count mismatch",
      { ...clip, layers: [{ ...textLayer, units: { ...textLayer.units, opacity: [hold(1)] } }] },
    ],
    [
      "string easing",
      {
        ...clip,
        layers: [{ ...rectLayer, x: [{ timeMicroseconds: 0, value: 0, easing: "easeIn" }] }],
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(graphicsClipSchema.safeParse(input).success).toBe(false);
  });

  it("splits text into words and letters without spaces", () => {
    expect(splitGraphicsText(" Hello  big world ", "word")).toEqual(["Hello", "big", "world"]);
    expect(splitGraphicsText("Hi yo", "letter")).toEqual(["H", "i", "y", "o"]);
  });

  it("parses each layer kind on its own", () => {
    expect(graphicsLayerSchema.safeParse(imageLayer).success).toBe(true);
  });
});

describe("migrateGraphicsClip", () => {
  it("returns version 1 clips unchanged", () => {
    const result = migrateGraphicsClip(structuredClone(clip));

    expect(result).toEqual({ ok: true, value: clip });
  });

  it.each([2, 7])("rejects graphicsVersion %i as unsupported_schema", (graphicsVersion) => {
    const result = migrateGraphicsClip({ ...clip, graphicsVersion });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_schema");
  });

  it.each([undefined, 0, "1", 1.5])(
    "rejects malformed graphicsVersion %o as invalid_project",
    (graphicsVersion) => {
      const result = migrateGraphicsClip({ ...clip, graphicsVersion });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_project");
    },
  );
});

describe("graphics tracks in V2 projects", () => {
  it("parses a project with a graphics track", () => {
    const result = videoProjectSnapshotV2Schema.safeParse(snapshotWith([graphicsTrack]));

    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("reports track controls for graphics", () => {
    const track = projectTrackSchema.parse({ ...graphicsTrack, hidden: true, locked: true });

    expect(isMediaTrack(track)).toBe(false);
    expect(isTrackMuted(track)).toBe(false);
    expect(isTrackHidden(track)).toBe(true);
    expect(isTrackHidden(projectTrackSchema.parse({ ...graphicsTrack, hidden: false }))).toBe(
      false,
    );
    expect(isTrackLocked(track)).toBe(true);
    expect(canToggleTrackVisibility(track)).toBe(true);
  });

  it("rejects a muted flag on graphics tracks", () => {
    expect(projectTrackSchema.safeParse({ ...graphicsTrack, muted: true }).success).toBe(false);
  });

  it.each([
    [
      "duplicate clip ids",
      [
        {
          ...graphicsTrack,
          graphicsClips: [clip, { ...clip, timelineStart: { value: 200, ...rate } }],
        },
      ],
      [],
    ],
    [
      "overlapping clips",
      [
        {
          ...graphicsTrack,
          graphicsClips: [
            clip,
            {
              ...clip,
              id: "30000000-0000-4000-8000-000000000009",
              timelineStart: { value: 100, ...rate },
            },
          ],
        },
      ],
      [],
    ],
    [
      "clip at another rate",
      [
        {
          ...graphicsTrack,
          graphicsClips: [
            {
              ...clip,
              timelineStart: { value: 30, rateNumerator: 25, rateDenominator: 1 },
              duration: { value: 90, rateNumerator: 25, rateDenominator: 1 },
            },
          ],
        },
      ],
      [],
    ],
    [
      "missing image asset",
      [{ ...graphicsTrack, graphicsClips: [{ ...clip, layers: [imageLayer] }] }],
      [],
    ],
    [
      "image asset that is not a still",
      [{ ...graphicsTrack, graphicsClips: [{ ...clip, layers: [imageLayer] }] }],
      [{ ...stillAsset, probe: { ...stillAsset.probe, still: undefined, videoCodecName: "h264" } }],
    ],
  ])("integrity rejects %s", (_name, stateTracks, assets) => {
    expect(videoProjectSnapshotV2Schema.safeParse(snapshotWith(stateTracks, assets)).success).toBe(
      false,
    );
  });

  it("accepts an image layer that references a still asset", () => {
    const snapshot = snapshotWith(
      [{ ...graphicsTrack, graphicsClips: [{ ...clip, layers: [imageLayer] }] }],
      [stillAsset],
    );

    expect(videoProjectSnapshotV2Schema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects a media clip that points at a still asset", () => {
    const videoTrack = {
      id: "30000000-0000-4000-8000-000000000020",
      name: "V1",
      kind: "video",
      clips: [
        {
          id: "30000000-0000-4000-8000-000000000021",
          source: { kind: "asset", assetId: stillAsset.id },
          timelineStart: { value: 0, ...rate },
          sourceIn: { value: 0, ...rate },
          duration: { value: 10, ...rate },
        },
      ],
    };

    expect(
      videoProjectSnapshotV2Schema.safeParse(snapshotWith([videoTrack], [stillAsset])).success,
    ).toBe(false);
  });

  it("refuses a project file whose graphics clip is from a newer version", () => {
    const future = snapshotWith([
      { ...graphicsTrack, graphicsClips: [{ ...clip, graphicsVersion: 2 }] },
    ]);

    expect(() => parseVideoProjectFile(future)).toThrowError(
      expect.objectContaining({ code: "unsupported_schema" }),
    );
  });
});

describe("graphics compatibility fixtures", () => {
  const fixture = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as unknown;

  it.each([
    "project-v2/valid-minimal.svpvideo",
    "project-v2/valid-relative-source.svpvideo",
    "project-v2/valid-mixed-rate.svpvideo",
    "project-v2/valid-graphics.svpvideo",
  ])("%s parses and round-trips unchanged", async (path) => {
    const original = await fixture(path);

    const parsed = parseVideoProjectFile(structuredClone(original));

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(original));
  });

  it("rejects a future graphics clip version as unsupported_schema", async () => {
    const input = await fixture("project-v2/graphics-future-version.svpvideo");

    expect(() => parseVideoProjectFile(input)).toThrow(
      expect.objectContaining({ code: "unsupported_schema" }),
    );
  });
});
