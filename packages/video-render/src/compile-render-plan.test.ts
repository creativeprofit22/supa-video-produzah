import {
  DEFAULT_CLIP_TRANSFORM_GEOMETRY,
  type ProjectRevision,
  type RationalRate,
  type VideoTrack,
  VideoDomainError,
  createRationalRate,
  createRationalTime,
  renderPlanV1Schema,
  renderPlanV2Schema,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  compileActiveSequenceRenderPlan,
  compileSingleClipRenderPlan,
  getActiveSequenceRenderEligibility,
} from "./index.js";

const ids = {
  revision: "00000000-0000-4000-8000-000000000001",
  asset: "00000000-0000-4000-8000-000000000002",
  sequence: "00000000-0000-4000-8000-000000000003",
  track: "00000000-0000-4000-8000-000000000004",
  clip: "00000000-0000-4000-8000-000000000005",
  plan: "00000000-0000-4000-8000-000000000006",
  captionTrack: "00000000-0000-4000-8000-000000000008",
  caption: "00000000-0000-4000-8000-00000000000c",
  asset2: "00000000-0000-4000-8000-000000000009",
  track2: "00000000-0000-4000-8000-00000000000a",
  clip2: "00000000-0000-4000-8000-00000000000b",
  audioTrack: "00000000-0000-4000-8000-00000000000d",
  audioClip: "00000000-0000-4000-8000-00000000000e",
} as const;
const inputPath = "C:\\Media Source\\single clip.mp4";
const outputPath = "D:\\Rendered Output\\trim result.mp4";
const shownVideoFilter =
  "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30000/1001";
const hiddenVideoFilter =
  "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,fps=30000/1001";
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
  shownVideoFilter,
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
  shownVideoFilter,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  outputPath,
] as const;
const hiddenAvArgv = avArgv.map((argument) =>
  argument === shownVideoFilter ? hiddenVideoFilter : argument,
);
const hiddenVideoOnlyArgv = videoOnlyArgv.map((argument) =>
  argument === shownVideoFilter ? hiddenVideoFilter : argument,
);

function expectedMetadata(audio: boolean, videoHidden = false) {
  return {
    durationFrames: 75,
    rate: { numerator: 30_000, denominator: 1_001 },
    width: 1_280,
    height: 720,
    audio,
    ...(videoHidden ? { videoHidden: true } : {}),
  };
}

interface RevisionOptions {
  readonly rate?: RationalRate;
  readonly sourceIn?: number;
  readonly sourceOut?: number;
  readonly durationMicroseconds?: number;
  readonly audio?: boolean;
}

interface V2RevisionOptions {
  readonly muted?: boolean;
  readonly hidden?: boolean;
  readonly opacityPermille?: number;
  readonly positionXPermille?: number;
  readonly positionYPermille?: number;
  readonly scaleXPermille?: number;
  readonly scaleYPermille?: number;
  readonly rotationMilliDegrees?: number;
  readonly captionHidden?: boolean;
  readonly dedicatedAudioTrack?: "empty" | "non-empty";
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

function makeV2Revision(options: V2RevisionOptions = {}) {
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
              ...(options.muted === undefined ? {} : { muted: options.muted }),
              ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
              clips: [
                {
                  id: clip.id,
                  source: { kind: "asset" as const, assetId: clip.assetId },
                  timelineStart: clip.timelineStart,
                  sourceIn: clip.sourceIn,
                  sourceOut: clip.sourceOut,
                  transform: {
                    positionXPermille: options.positionXPermille ?? 0,
                    positionYPermille: options.positionYPermille ?? 0,
                    scaleXPermille: options.scaleXPermille ?? 1_000,
                    scaleYPermille: options.scaleYPermille ?? 1_000,
                    rotationMilliDegrees: options.rotationMilliDegrees ?? 0,
                    opacityPermille: options.opacityPermille ?? 1_000,
                  },
                  gainMilliDecibels: 0,
                },
              ],
            },
            ...(options.dedicatedAudioTrack === undefined
              ? []
              : [
                  {
                    id: ids.audioTrack,
                    name: "Audio 1",
                    kind: "audio" as const,
                    clips:
                      options.dedicatedAudioTrack === "empty"
                        ? []
                        : [
                            {
                              id: ids.audioClip,
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
                ]),
            ...(options.captionHidden === undefined
              ? []
              : [
                  {
                    id: ids.captionTrack,
                    name: "Captions 1",
                    kind: "caption" as const,
                    hidden: options.captionHidden,
                    captions: [
                      {
                        id: String(ids.caption),
                        start: createRationalTime(15, sequence.rate),
                        end: createRationalTime(30, sequence.rate),
                        text: "Speaker: we're ready, 100%",
                      },
                    ],
                  },
                ]),
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

function expectedActiveSequenceFilter(opacity: string, audible = true): string {
  return [
    "color=c=black:s=1280x720:r=30000/1001:d=2.502500[base]",
    `[0:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=${opacity},pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30000/1001[v0]`,
    ...(audible ? ["[0:a:0]asetpts=PTS-STARTPTS[a0]"] : []),
    "[base][v0]overlay=0:0:format=auto[stack0]",
    "[stack0]null[vout]",
    ...(audible ? ["[a0]anull[aout]"] : []),
  ].join(";");
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
  it("keeps exact AV argv and omits videoHidden when the V2 video track is shown", () => {
    const plan = compile(makeV2Revision({ muted: false, hidden: false }));

    expect(plan.argv).toEqual(avArgv);
    expect(plan.expected).toEqual(expectedMetadata(true));
  });

  it("adds the exact black drawbox while keeping hidden V2 video audible", () => {
    const plan = compile(makeV2Revision({ hidden: true }));

    expect(plan.argv).toEqual(hiddenAvArgv);
    expect(plan.expected).toEqual(expectedMetadata(true, true));
  });

  it("adds the exact black drawbox while mute alone suppresses hidden V2 video audio", () => {
    const plan = compile(makeV2Revision({ hidden: true, muted: true }));

    expect(plan.argv).toEqual(hiddenVideoOnlyArgv);
    expect(plan.expected).toEqual(expectedMetadata(false, true));
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

  it("burns shown V2 captions into output and omits hidden caption tracks", () => {
    const shownPlan = compile(makeV2Revision({ captionHidden: false }));
    const hiddenPlan = compile(makeV2Revision({ captionHidden: true }));
    const expectedCaption = {
      trackId: ids.captionTrack,
      captionId: ids.caption,
      startMicroseconds: 500_500,
      endMicroseconds: 1_001_000,
      text: "Speaker: we're ready, 100%",
    };

    expect(shownPlan.captions).toEqual([expectedCaption]);
    expect(hiddenPlan.captions).toEqual([]);
    expect(shownPlan.argv).not.toEqual(hiddenPlan.argv);
    expect(shownPlan.argv[shownPlan.argv.indexOf("-vf") + 1]).toBe(
      `${shownVideoFilter},drawtext=text='Speaker\\: we\\'re ready\\, 100\\%':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:enable='gte(t\\,0.500500)*lt(t\\,1.001000)'`,
    );
    expect(hiddenPlan.argv).toEqual(avArgv);
    expect(shownPlan.expected).toEqual(expectedMetadata(true));
    expect(hiddenPlan.expected).toEqual(expectedMetadata(true));
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

describe("compileActiveSequenceRenderPlan", () => {
  it.each([
    [0, "0.000"],
    [425, "0.425"],
    [1_000, "1.000"],
  ] as const)(
    "compiles opacity %i as the exact deterministic %s alpha filter",
    (opacityPermille, alpha) => {
      const revision = makeV2Revision({ opacityPermille });
      expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });

      const plan = compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      });

      expect(plan.videoInputs).toEqual([
        {
          assetId: ids.asset,
          path: inputPath,
          sourceInMicroseconds: 500_500,
          ...DEFAULT_CLIP_TRANSFORM_GEOMETRY,
          opacityPermille,
          hidden: false,
          muted: false,
          hasAudio: true,
        },
      ]);
      expect(plan.argv[plan.argv.indexOf("-filter_complex") + 1]).toBe(
        expectedActiveSequenceFilter(alpha),
      );
      expect(plan.expected.audio).toBe(true);
    },
  );

  it("compiles position, non-uniform scale, and rotation in canonical order", () => {
    const revision = makeV2Revision({
      positionXPermille: 125,
      positionYPermille: -250,
      scaleXPermille: 1_500,
      scaleYPermille: 750,
      rotationMilliDegrees: 45_000,
      opacityPermille: 425,
    });

    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });
    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
    });

    expect(plan.videoInputs[0]).toMatchObject({
      positionXPermille: 125,
      positionYPermille: -250,
      scaleXPermille: 1_500,
      scaleYPermille: 750,
      rotationMilliDegrees: 45_000,
      opacityPermille: 425,
    });
    expect(plan.argv[plan.argv.indexOf("-filter_complex") + 1]).toBe(
      [
        "color=c=black:s=1280x720:r=30000/1001:d=2.502500[base]",
        "[0:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,scale=w='max(1\\,round(iw*1.500))':h='max(1\\,round(ih*0.750))':flags=lanczos,rotate=angle=45.000*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0,colorchannelmixer=aa=0.425,fps=30000/1001[v0]",
        "[0:a:0]asetpts=PTS-STARTPTS[a0]",
        "[base][v0]overlay=x='(main_w-overlay_w)/2+main_w*0.125':y='(main_h-overlay_h)/2-main_h*0.250':format=auto[stack0]",
        "[stack0]null[vout]",
        "[a0]anull[aout]",
      ].join(";"),
    );
    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
  });

  it("keeps zero-opacity clip audio independent from visual alpha", () => {
    const audibleRevision = makeV2Revision({ opacityPermille: 0 });
    const mutedRevision = makeV2Revision({ opacityPermille: 0, muted: true });
    const compileActive = (revision: ReturnType<typeof makeV2Revision>) =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      });

    const audible = compileActive(audibleRevision);
    const muted = compileActive(mutedRevision);
    expect(audible.argv[audible.argv.indexOf("-filter_complex") + 1]).toBe(
      expectedActiveSequenceFilter("0.000"),
    );
    expect(muted.argv[muted.argv.indexOf("-filter_complex") + 1]).toBe(
      expectedActiveSequenceFilter("0.000", false),
    );
    expect(audible.expected.audio).toBe(true);
    expect(muted.expected.audio).toBe(false);
  });

  it("uses the compiler validator for render eligibility", () => {
    const revision = structuredClone(makeV2Revision());
    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });

    const track = revision.state.sequences[0]!.tracks[0]!;
    if (track.kind !== "video") throw new Error("expected video track fixture");
    track.clips.push({ ...structuredClone(track.clips[0]!), id: ids.clip2 });

    expect(getActiveSequenceRenderEligibility(revision)).toEqual({
      eligible: false,
      reason: "Each video track must contain exactly one direct-asset clip to export",
    });
    expectInvalidRenderPlan(() =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      }),
    );
  });

  it("keeps an empty dedicated audio track exportable", () => {
    const revision = makeV2Revision({ dedicatedAudioTrack: "empty" });

    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });
    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
    });

    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
    expect(plan.videoInputs).toHaveLength(1);
  });

  it("rejects a dedicated audio track containing clips with an actionable error", () => {
    const revision = makeV2Revision({ dedicatedAudioTrack: "non-empty" });
    const reason =
      "Dedicated audio tracks containing clips cannot be exported yet; remove those clips before exporting";

    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: false, reason });
    const error = expectInvalidRenderPlan(() =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      }),
    );
    expect(error.message).toBe(reason);
  });

  it.each([
    [30, 1, 30, 60, "1.000000", "2.000000"],
    [30_000, 1_001, 30, 60, "1.001000", "2.002000"],
    [24_000, 1_001, 25, 50, "1.042708", "2.085417"],
  ])(
    "uses half-open adjacent cues in both plan versions at %i/%i",
    (num, den, boundary, end, startText, endText) => {
      const revision = structuredClone(makeV2Revision({ captionHidden: false }));
      const track = revision.state.sequences[0]!.tracks.find((item) => item.kind === "caption");
      if (!track || track.kind !== "caption") throw new Error("expected caption track fixture");
      const rate = createRationalRate(num, den);
      track.captions = [
        {
          id: ids.caption,
          start: createRationalTime(0, rate),
          end: createRationalTime(boundary, rate),
          text: "OUTGOING LONG",
        },
        {
          id: "00000000-0000-4000-8000-00000000000d",
          start: createRationalTime(boundary, rate),
          end: createRationalTime(end, rate),
          text: "IN",
        },
      ];
      const compileBoth = () => [
        compile(revision),
        compileActiveSequenceRenderPlan({
          planId: ids.plan,
          revision,
          inputPathsByAssetId: { [ids.asset]: inputPath },
          outputPath,
        }),
      ];
      for (const plan of compileBoth()) {
        const graph = plan.argv.join(" ");
        expect(graph).toContain(`enable='gte(t\\,0.000000)*lt(t\\,${startText})'`);
        expect(graph).toContain(`enable='gte(t\\,${startText})*lt(t\\,${endText})'`);
        expect(graph).not.toContain("between(t");
        expect(plan.captions).toHaveLength(2);
      }
      track.captions = [];
      for (const plan of compileBoth()) {
        expect(plan.captions).toEqual([]);
        expect(plan.argv.join(" ")).not.toContain("drawtext");
      }
    },
  );

  it("binds shown caption metadata into the final filter graph and omits hidden cues", () => {
    const shownRevision = makeV2Revision({ captionHidden: false });
    const hiddenRevision = makeV2Revision({ captionHidden: true });
    const compileActive = (revision: ReturnType<typeof makeV2Revision>) =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      });

    const shown = compileActive(shownRevision);
    const hidden = compileActive(hiddenRevision);
    const shownFilter = shown.argv[shown.argv.indexOf("-filter_complex") + 1]!;
    const hiddenFilter = hidden.argv[hidden.argv.indexOf("-filter_complex") + 1]!;

    expect(shown.captions).toHaveLength(1);
    expect(hidden.captions).toEqual([]);
    expect(shownFilter).toContain("[stack0]drawtext=text='Speaker\\: we\\'re ready\\, 100\\%'");
    expect(shownFilter).toContain(":enable='gte(t\\,0.500500)*lt(t\\,1.001000)'[caption0]");
    expect(hiddenFilter).not.toContain("drawtext");
    expect(shown.videoInputs).toEqual(hidden.videoInputs);
    expect(shown.expected).toEqual(hidden.expected);
  });

  it("binds canonical track order, visibility, source time, and audio policy into V2 metadata", () => {
    const revision = structuredClone(makeV2Revision({ muted: true, hidden: false }));
    const firstAsset = revision.state.assets[0]!;
    const firstTrack = revision.state.sequences[0]!.tracks[0]!;
    if (firstTrack.kind !== "video") throw new Error("expected video track fixture");
    firstTrack.clips[0]!.transform.opacityPermille = 425;
    const secondAsset = { ...structuredClone(firstAsset), id: ids.asset2 };
    const secondTrack = {
      ...structuredClone(firstTrack),
      id: ids.track2,
      hidden: true,
      muted: false,
      clips: [
        {
          ...structuredClone(firstTrack.clips[0]!),
          id: ids.clip2,
          source: { kind: "asset" as const, assetId: ids.asset2 },
          transform: {
            ...structuredClone(firstTrack.clips[0]!.transform),
            opacityPermille: 0,
          },
        },
      ],
    };
    revision.state.assets.push(secondAsset);
    revision.state.sequences[0]!.tracks.push(secondTrack);
    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });

    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: {
        [ids.asset]: inputPath,
        [ids.asset2]: "C:\\Media Source\\bottom.mp4",
      },
      outputPath,
    });

    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
    expect(plan.videoInputs).toEqual([
      {
        assetId: ids.asset,
        path: inputPath,
        sourceInMicroseconds: 500_500,
        ...DEFAULT_CLIP_TRANSFORM_GEOMETRY,
        opacityPermille: 425,
        hidden: false,
        muted: true,
        hasAudio: true,
      },
      {
        assetId: ids.asset2,
        path: "C:\\Media Source\\bottom.mp4",
        sourceInMicroseconds: 500_500,
        ...DEFAULT_CLIP_TRANSFORM_GEOMETRY,
        opacityPermille: 0,
        hidden: true,
        muted: false,
        hasAudio: true,
      },
    ]);
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
    expect(filter).toBe(
      [
        "color=c=black:s=1280x720:r=30000/1001:d=2.502500[base]",
        "[0:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.425,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30000/1001[v0]",
        "[1:a:0]asetpts=PTS-STARTPTS[a1]",
        "[base][v0]overlay=0:0:format=auto[stack0]",
        "[stack0]null[vout]",
        "[a1]anull[aout]",
      ].join(";"),
    );
    expect(filter).not.toContain("[1:v:0]");
    expect(filter).not.toContain("[0:a:0]");
    expect(plan.expected.audio).toBe(true);

    secondTrack.hidden = false;
    const layered = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: plan.inputPathsByAssetId,
      outputPath,
    });
    const layeredFilter = layered.argv[layered.argv.indexOf("-filter_complex") + 1]!;
    expect(layeredFilter).toBe(
      [
        "color=c=black:s=1280x720:r=30000/1001:d=2.502500[base]",
        "[0:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.425,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30000/1001[v0]",
        "[1:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.000,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30000/1001[v1]",
        "[1:a:0]asetpts=PTS-STARTPTS[a1]",
        "[base][v1]overlay=0:0:format=auto[stack0]",
        "[stack0][v0]overlay=0:0:format=auto[stack1]",
        "[stack1]null[vout]",
        "[a1]anull[aout]",
      ].join(";"),
    );
  });
});
