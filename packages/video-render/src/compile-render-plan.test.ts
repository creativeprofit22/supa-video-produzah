import {
  type ProjectRevision,
  type RationalRate,
  type VideoTrack,
  VideoDomainError,
  createRationalRate,
  createRationalTime,
  renderPlanV1Schema,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { compileSingleClipRenderPlan } from "./index.js";

const ids = {
  revision: "00000000-0000-4000-8000-000000000001",
  asset: "00000000-0000-4000-8000-000000000002",
  sequence: "00000000-0000-4000-8000-000000000003",
  track: "00000000-0000-4000-8000-000000000004",
  clip: "00000000-0000-4000-8000-000000000005",
  plan: "00000000-0000-4000-8000-000000000006",
} as const;
const inputPath = "C:\\Media Source\\single clip.mp4";
const outputPath = "D:\\Rendered Output\\trim result.mp4";
const avArgv = [
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "warning",
  "-progress",
  "pipe:1",
  "-nostats",
  "-i",
  inputPath,
  "-ss",
  "0.500500",
  "-t",
  "2.502500",
  "-map",
  "0:v:0",
  "-map",
  "0:a:0",
  "-vf",
  "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30000/1001",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-ar",
  "48000",
  "-movflags",
  "+faststart",
  outputPath,
] as const;
const videoOnlyArgv = [
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "warning",
  "-progress",
  "pipe:1",
  "-nostats",
  "-i",
  inputPath,
  "-ss",
  "0.500500",
  "-t",
  "2.502500",
  "-map",
  "0:v:0",
  "-an",
  "-vf",
  "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30000/1001",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  outputPath,
] as const;

function expectedMetadata(audio: boolean) {
  return {
    durationFrames: 75,
    rate: { numerator: 30_000, denominator: 1_001 },
    width: 1_280,
    height: 720,
    audio,
  };
}

interface RevisionOptions {
  readonly rate?: RationalRate;
  readonly sourceIn?: number;
  readonly sourceOut?: number;
  readonly durationMicroseconds?: number;
  readonly audio?: boolean;
}

function makeRevision(options: RevisionOptions = {}): ProjectRevision {
  const rate = options.rate ?? createRationalRate(30_000, 1_001);
  return {
    id: ids.revision,
    parentRevisionId: null,
    sequenceNumber: 0,
    committedAt: "2026-07-24T12:00:00.000Z",
    commandSummary: "Inserted clip",
    state: {
      asset: {
        id: ids.asset,
        displayName: "single clip.mp4",
        locator: { absolutePath: inputPath },
        probe: {
          durationMicroseconds: options.durationMicroseconds ?? 4_000_000,
          averageFrameRate: rate,
          realFrameRate: rate,
          variableFrameRate: false,
          width: 1_920,
          height: 1_080,
          videoCodecName: "h264",
          audio:
            options.audio === false ? null : { codecName: "aac", channels: 2, sampleRate: 48_000 },
          fileSizeBytes: 1_000_000,
        },
      },
      sequence: {
        id: ids.sequence,
        rate,
        width: 1_280,
        height: 720,
        audioSampleRate: 48_000,
        videoTracks: [
          {
            id: ids.track,
            clips: [
              {
                id: ids.clip,
                assetId: ids.asset,
                timelineStart: createRationalTime(0, rate),
                sourceIn: createRationalTime(options.sourceIn ?? 15, rate),
                sourceOut: createRationalTime(options.sourceOut ?? 90, rate),
              },
            ],
          },
        ],
      },
    },
  };
}

function makeV2Revision(muted?: boolean) {
  const legacy = makeRevision();
  const asset = legacy.state.asset!;
  const sequence = legacy.state.sequence!;
  const clip = sequence.videoTracks[0].clips[0]!;

  return {
    revision: {
      number: 0,
      id: legacy.id,
      parentId: null,
      committedAt: legacy.committedAt,
      operationId: "00000000-0000-4000-8000-000000000007",
      stateHash: "a".repeat(64),
    },
    state: {
      assets: [asset],
      sequences: [
        {
          id: sequence.id,
          name: "Sequence 1",
          rate: sequence.rate,
          width: sequence.width,
          height: sequence.height,
          audioSampleRate: sequence.audioSampleRate,
          markers: [],
          tracks: [
            {
              id: sequence.videoTracks[0].id,
              name: "Video 1",
              kind: "video" as const,
              ...(muted === undefined ? {} : { muted }),
              clips: [
                {
                  id: clip.id,
                  source: { kind: "asset" as const, assetId: clip.assetId },
                  timelineStart: clip.timelineStart,
                  sourceIn: clip.sourceIn,
                  sourceOut: clip.sourceOut,
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
          ],
        },
      ],
      activeSequenceId: sequence.id,
    },
  };
}

function compile(
  revision: Parameters<typeof compileSingleClipRenderPlan>[0]["revision"] = makeRevision(),
) {
  return compileSingleClipRenderPlan({
    planId: ids.plan,
    revision,
    inputPath,
    outputPath,
  });
}

function expectInvalidRenderPlan(action: () => unknown): VideoDomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(VideoDomainError);
    if (!(error instanceof VideoDomainError)) {
      throw error;
    }
    expect(error.code).toBe("invalid_render_plan");
    return error;
  }
  throw new Error("Expected render plan compilation to fail");
}

function malformedRevision(transform: (revision: ProjectRevision) => void): ProjectRevision {
  const revision = structuredClone(makeRevision());
  transform(revision);
  return revision;
}

describe("compileSingleClipRenderPlan", () => {
  it.each([
    ["absent", makeV2Revision()],
    ["false", makeV2Revision(false)],
  ])("keeps exact AV argv and expected metadata when V2 mute is %s", (_label, revision) => {
    const plan = compile(revision);

    expect(plan.argv).toEqual(avArgv);
    expect(plan.expected).toEqual(expectedMetadata(true));
  });

  it("uses exact video-only argv and expected metadata when the V2 video track is muted", () => {
    const plan = compile(makeV2Revision(true));

    expect(plan.argv).toEqual(videoOnlyArgv);
    expect(plan.expected).toEqual(expectedMetadata(false));
  });

  it("keeps exact legacy AV argv and expected metadata unchanged", () => {
    const plan = compile();

    expect(plan.argv).toEqual(avArgv);
    expect(plan.expected).toEqual(expectedMetadata(true));
    expect(plan).toMatchObject({
      schemaVersion: 1,
      planId: ids.plan,
      revisionId: ids.revision,
      executable: "ffmpeg",
      inputPath,
      outputPath,
    });
    expect(renderPlanV1Schema.parse(plan)).toEqual(plan);
  });

  it("compiles the exact video-only branch for sources without embedded audio", () => {
    const plan = compile(makeRevision({ audio: false }));

    expect(plan.argv).toEqual(videoOnlyArgv);
    expect(plan.expected).toEqual(expectedMetadata(false));
  });

  it("formats integer and NTSC-rate boundaries as fixed six-place seconds", () => {
    const integerRatePlan = compile(
      makeRevision({ rate: createRationalRate(30, 1), sourceIn: 1, sourceOut: 2 }),
    );
    const ntscRatePlan = compile();

    expect(integerRatePlan.argv.slice(9, 13)).toEqual(["-ss", "0.033333", "-t", "0.033333"]);
    expect(ntscRatePlan.argv.slice(9, 13)).toEqual(["-ss", "0.500500", "-t", "2.502500"]);
    for (const value of [integerRatePlan.argv[10], integerRatePlan.argv[12]]) {
      expect(value).toMatch(/^\d+\.\d{6}$/);
      expect(value).not.toMatch(/e/i);
    }
  });

  it("keeps paths with spaces as raw single argv elements", () => {
    const plan = compile();

    expect(plan.argv[plan.argv.indexOf("-i") + 1]).toBe(inputPath);
    expect(plan.argv.at(-1)).toBe(outputPath);
    expect(plan.argv).toContain(inputPath);
    expect(plan.argv).toContain(outputPath);
    expect(plan.argv).not.toContain(`"${inputPath}"`);
    expect(plan).not.toHaveProperty("command");
  });

  it("returns a deeply frozen plan without mutating or freezing the revision", () => {
    const revision = makeRevision();
    const before = structuredClone(revision);
    const plan = compile(revision);

    expect(revision).toEqual(before);
    expect(Object.isFrozen(revision)).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.expected)).toBe(true);
    expect(Object.isFrozen(plan.expected.rate)).toBe(true);
    expect(Object.isFrozen(plan.argv)).toBe(true);
    expect(() => plan.argv.push("unexpected")).toThrow(TypeError);
  });

  it("rejects malformed and incomplete revisions with the render error contract", () => {
    const malformedId = malformedRevision((revision) => {
      revision.id = "not-a-uuid";
    });
    const noAsset = malformedRevision((revision) => {
      revision.state.asset = null;
    });
    const noSequence = malformedRevision((revision) => {
      revision.state.sequence = null;
    });
    const noTrack = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks = [] as unknown as [VideoTrack];
    });
    const noClip = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks[0].clips = [];
    });

    for (const revision of [malformedId, noAsset, noSequence, noTrack, noClip]) {
      expectInvalidRenderPlan(() => compile(revision));
    }
  });

  it("keeps a partial final source frame addressable and rejects the next frame", () => {
    const partialFinalFrame = makeRevision({
      rate: createRationalRate(30, 1),
      sourceIn: 0,
      sourceOut: 2,
      durationMicroseconds: 33_334,
    });
    const beyondDuration = makeRevision({
      rate: createRationalRate(30, 1),
      sourceIn: 0,
      sourceOut: 3,
      durationMicroseconds: 33_334,
    });

    expect(compile(partialFinalFrame).expected.durationFrames).toBe(2);
    expectInvalidRenderPlan(() => compile(beyondDuration));
  });

  it("rejects identity, rate, range, and source-duration violations", () => {
    const wrongAsset = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks[0].clips[0]!.assetId =
        "00000000-0000-4000-8000-000000000099";
    });
    const mixedClipRate = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks[0].clips[0]!.sourceOut = createRationalTime(
        90,
        createRationalRate(25, 1),
      );
    });
    const mixedAssetRate = malformedRevision((revision) => {
      revision.state.asset!.probe.averageFrameRate = createRationalRate(25, 1);
    });
    const emptyRange = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks[0].clips[0]!.sourceOut =
        revision.state.sequence!.videoTracks[0].clips[0]!.sourceIn;
    });
    const reversedRange = malformedRevision((revision) => {
      revision.state.sequence!.videoTracks[0].clips[0]!.sourceOut = createRationalTime(
        14,
        revision.state.sequence!.rate,
      );
    });
    const beyondDuration = makeRevision({
      rate: createRationalRate(30, 1),
      sourceIn: 0,
      sourceOut: 31,
      durationMicroseconds: 1_000_000,
    });

    for (const revision of [
      wrongAsset,
      mixedClipRate,
      mixedAssetRate,
      emptyRange,
      reversedRange,
      beyondDuration,
    ]) {
      expectInvalidRenderPlan(() => compile(revision));
    }
  });

  it("rejects malformed compiler and plan/path payloads", () => {
    expectInvalidRenderPlan(() =>
      compileSingleClipRenderPlan(
        null as unknown as Parameters<typeof compileSingleClipRenderPlan>[0],
      ),
    );
    expectInvalidRenderPlan(() =>
      compileSingleClipRenderPlan({
        planId: "not-a-uuid",
        revision: makeRevision(),
        inputPath,
        outputPath,
      }),
    );
    expectInvalidRenderPlan(() =>
      compileSingleClipRenderPlan({
        planId: ids.plan,
        revision: makeRevision(),
        inputPath: "",
        outputPath,
      }),
    );
    expectInvalidRenderPlan(() =>
      compileSingleClipRenderPlan({
        planId: ids.plan,
        revision: makeRevision(),
        inputPath,
        outputPath: "bad\0path.mp4",
      }),
    );
  });
});
