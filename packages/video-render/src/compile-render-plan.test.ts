import {
  DEFAULT_CLIP_TRANSFORM_GEOMETRY,
  type GraphicsClip,
  type ProjectRevision,
  type ClipSpeed,
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
  "-g",
  "60",
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
  "-g",
  "60",
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
  readonly sourceOut?: number;
  readonly speed?: ClipSpeed;
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
  readonly emptyGraphicsTrack?: boolean;
  /** Graphics tracks appended after the other tracks (each entry: hidden flag and clips). */
  readonly graphicsTracks?: readonly {
    readonly id: string;
    readonly hidden?: boolean;
    readonly graphicsClips: readonly GraphicsClip[];
  }[];
  readonly stillAsset?: boolean;
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

const stillAsset = {
  id: "9a000000-0000-4000-8000-0000000000a0",
  displayName: "logo.png",
  locator: { absolutePath: String.raw`C:\Media\logo.png` },
  probe: {
    durationMicroseconds: 1_000_000,
    averageFrameRate: { numerator: 1, denominator: 1 },
    realFrameRate: { numerator: 1, denominator: 1 },
    variableFrameRate: false,
    width: 64,
    height: 64,
    videoCodecName: "png",
    audio: null,
    fileSizeBytes: 900,
    still: true as const,
  },
};
const stillPath = String.raw`C:\Media\logo.png`;

function graphicsClipAt(
  id: string,
  startFrame: number,
  durationFrames: number,
  withImage = false,
): GraphicsClip {
  const rate = createRationalRate(30_000, 1_001);
  const hold = (value: number) => [{ timeMicroseconds: 0, value }];
  const tracks = { x: hold(10), y: hold(20), scale: hold(1), rotation: hold(0), opacity: hold(1) };
  return {
    graphicsVersion: 1,
    id,
    timelineStart: createRationalTime(startFrame, rate),
    duration: createRationalTime(durationFrames, rate),
    fontKey: "segoe-ui-bold",
    layers: [
      { kind: "text", text: "Title", fontSize: 40, fill: "#FFFFFF", ...tracks },
      ...(withImage
        ? [{ kind: "image" as const, assetId: stillAsset.id, width: 64, height: 64, ...tracks }]
        : []),
    ],
  };
}

function makeV2Revision(options: V2RevisionOptions = {}) {
  const legacy = makeRevision(
    options.sourceOut === undefined ? {} : { sourceOut: options.sourceOut },
  );
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
      assets: options.stillAsset === true ? [asset, stillAsset] : [asset],
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
                  ...(options.speed === undefined ? {} : { speed: options.speed }),
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
            ...(options.graphicsTracks ?? []).map((track) => ({
              id: track.id,
              name: "Graphics",
              kind: "graphics" as const,
              ...(track.hidden === undefined ? {} : { hidden: track.hidden }),
              graphicsClips: [...track.graphicsClips],
            })),
            ...(options.emptyGraphicsTrack === true
              ? [
                  {
                    id: "9a000000-0000-4000-8000-000000000001",
                    name: "Graphics 1",
                    kind: "graphics" as const,
                    graphicsClips: [],
                  },
                ]
              : []),
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

describe("V2 fades export", () => {
  const active = (revision = makeV2Revision()) =>
    compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
    });
  const faded = (inFrames: number, outFrames: number, options: V2RevisionOptions = {}) => {
    const revision = makeV2Revision(options);
    const track = revision.state.sequences[0]!.tracks[0]!;
    if (track.kind !== "video") throw new Error("video fixture");
    Object.assign(track.clips[0]!, { fades: { inFrames, outFrames } });
    return revision;
  };
  it.each([
    [0, 0],
    [15, 0],
    [0, 30],
    [15, 30],
  ])("compiles linear output-frame fades %i/%i at fractional rate", (inFrames, outFrames) => {
    const revision = faded(inFrames, outFrames);
    const plan = active(revision);
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
    if (inFrames + outFrames === 0) {
      expect(plan).toEqual(active());
      expect(filter).not.toContain("afade");
    } else {
      expect(plan.videoInputs[0]!.fades).toEqual({ inFrames, outFrames });
      expect(filter).toContain(
        "atrim=duration=2.502500,asetpts=PTS-STARTPTS,atrim=duration=2.502500",
      );
      expect(filter.includes("afade=t=in:st=0.000000:d=0.500500:curve=tri")).toBe(inFrames > 0);
      expect(filter.includes("afade=t=out:st=1.501500:d=1.001000:curve=tri")).toBe(outFrames > 0);
      expect(() => compile(revision)).toThrow("V1 export does not support nonzero audio fades");
    }
  });
  describe("audio shorter than the video", () => {
    // The clip plays source frames 15..90 at 30000/1001: 0.500500..3.003000 s of the
    // file, 2.502500 s on the timeline. Audio durations below are file-relative.
    const withAudioDuration = (
      revision: ReturnType<typeof faded>,
      durationMicroseconds?: number,
    ) => {
      const audio = revision.state.assets[0]!.probe.audio!;
      if (durationMicroseconds === undefined)
        delete (audio as { durationMicroseconds?: number }).durationMicroseconds;
      else Object.assign(audio, { durationMicroseconds });
      return revision;
    };
    const filterOf = (plan: ReturnType<typeof active>) =>
      plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;

    it("ends the fade-out where the audio ends, not where the video ends", () => {
      const plan = active(withAudioDuration(faded(0, 30), 2_003_000));
      // The audio stops 1 s before the clip does: 2.003000 - 0.500500 = 1.502500 s in.
      expect(plan.videoInputs[0]!.audioEndMicroseconds).toBe(1_502_500);
      // Fade of 30 frames (1.001000 s) ending at 1.502500 s: starts at 0.501500 s.
      expect(filterOf(plan)).toContain("afade=t=out:st=0.501500:d=1.001000:curve=tri");
      expect(filterOf(plan)).not.toContain("afade=t=out:st=1.501500");
      expect(renderPlanV2Schema.safeParse(plan).success).toBe(true);
    });

    it("shortens the fade when the audio is shorter than the fade itself", () => {
      const plan = active(withAudioDuration(faded(0, 30), 900_500));
      expect(filterOf(plan)).toContain("afade=t=out:st=0.000000:d=0.400000:curve=tri");
    });

    it("accounts for the clip's source offset and speed", () => {
      // 2x speed over source frames 0..105: the audio end is halved on output.
      const plan = active(
        withAudioDuration(
          faded(15, 30, { speed: { numerator: 2, denominator: 1 }, sourceOut: 105 }),
          2_502_500,
        ),
      );
      // (2.502500 - 0.500500) s of source audio at 2x = 1.001000 s of output.
      expect(plan.videoInputs[0]!.audioEndMicroseconds).toBe(1_001_000);
      expect(filterOf(plan)).toContain("afade=t=out:st=0.000000:d=1.001000:curve=tri");
    });

    it.each([
      ["no recorded audio duration (older projects)", undefined],
      ["audio as long as the clip", 3_003_000],
      ["audio longer than the video", 9_000_000],
    ])("keeps the video-length fade with %s", (_, durationMicroseconds) => {
      const plan = active(withAudioDuration(faded(0, 30), durationMicroseconds));
      expect(plan.videoInputs[0]!.audioEndMicroseconds).toBeUndefined();
      expect(filterOf(plan)).toContain("afade=t=out:st=1.501500:d=1.001000:curve=tri");
    });

    it("records no audio end when there is no fade-out", () => {
      const plan = active(withAudioDuration(faded(15, 0), 2_003_000));
      expect(plan.videoInputs[0]!.audioEndMicroseconds).toBeUndefined();
      expect(filterOf(plan)).not.toContain("afade=t=out");
    });
  });
  it.each([false, true])(
    "orders retiming, bounded trim, gain and fades independently of hidden/opacity and mute=%s",
    (muted) => {
      const revision = faded(15, 30, {
        speed: { numerator: 2, denominator: 1 },
        sourceOut: 105,
        hidden: true,
        opacityPermille: 0,
        muted,
      });
      const track = revision.state.sequences[0]!.tracks[0]!;
      if (track.kind !== "video") throw new Error("video fixture");
      track.clips[0]!.gainMilliDecibels = -6123;
      const plan = active(revision);
      const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
      expect(plan.expected.durationFrames).toBe(45);
      expect(plan.videoInputs[0]!.fades).toEqual({ inFrames: 15, outFrames: 30 });
      expect(filter).not.toContain("[0:v:0]");
      if (muted) expect(filter).not.toContain("afade");
      else
        expect(filter).toContain(
          "atempo=2.00,atrim=duration=1.501500,volume=-6.123dB,afade=t=in:st=0.000000:d=0.500500:curve=tri,afade=t=out:st=0.500500:d=1.001000:curve=tri[a0]",
        );
    },
  );
  it.each([
    [1, 2, "0.50"],
    [3, 4, "0.75"],
  ])("binds the exact slow tempo branch with fades: %i/%i", (numerator, denominator, tempo) => {
    const plan = active(faded(15, 30, { speed: { numerator, denominator }, sourceOut: 105 }));
    const exact = `rubberband=tempo=${tempo}:window=short:transients=smooth`;
    expect(plan.argv[plan.argv.indexOf("-filter_complex") + 1]).toContain(exact);
    expect(renderPlanV2Schema.safeParse(plan).success).toBe(true);
    for (const replacement of [
      `atempo=${tempo}`,
      `rubberband=tempo=${tempo}`,
      `rubberband=tempo=${tempo}:window=long`,
      `rubberband=tempo=${tempo}:window=short`,
      `rubberband=tempo=${tempo}:window=short:transients=crisp`,
      "rubberband=tempo=1.00:window=short",
      `${exact},adelay=10`,
    ]) {
      expect(
        renderPlanV2Schema.safeParse({
          ...plan,
          argv: plan.argv.map((arg) => arg.replace(exact, replacement)),
        }).success,
      ).toBe(false);
    }
  });
  it("rejects invalid metadata, context and modified filter durations", () => {
    const plan = active(faded(15, 30));
    for (const fades of [
      null,
      { inFrames: -1, outFrames: 0 },
      { inFrames: 0.5, outFrames: 0 },
      { inFrames: 46, outFrames: 30 },
      { inFrames: Number.MAX_SAFE_INTEGER, outFrames: 1 },
      { inFrames: 15, outFrames: 30, extra: true },
    ]) {
      expect(
        renderPlanV2Schema.safeParse({ ...plan, videoInputs: [{ ...plan.videoInputs[0], fades }] })
          .success,
      ).toBe(false);
    }
    expectInvalidRenderPlan(() => active(faded(46, 30)));
    expect(
      renderPlanV2Schema.safeParse({ ...plan, expected: { ...plan.expected, durationFrames: 76 } })
        .success,
    ).toBe(false);
    expect(
      renderPlanV2Schema.safeParse({
        ...plan,
        argv: plan.argv.map((arg) => arg.replace("d=0.500500:curve=tri", "d=0.500501:curve=tri")),
      }).success,
    ).toBe(false);
  });
});

describe("V2 volume export", () => {
  const active = (revision = makeV2Revision()) =>
    compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
    });
  const withGain = (gain: number, options: V2RevisionOptions = {}) => {
    const revision = makeV2Revision(options);
    const track = revision.state.sequences[0]!.tracks[0]!;
    if (track.kind !== "video") throw new Error("video fixture");
    track.clips[0]!.gainMilliDecibels = gain;
    return revision;
  };
  it.each([
    [-96000, "-96.000"],
    [-6123, "-6.123"],
    [-1, "-0.001"],
    [0, ""],
    [24000, "24.000"],
  ] as const)("exports exact bounded gain %i", (gain, db) => {
    const revision = withGain(gain);
    expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });
    const plan = active(revision);
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
    expect(plan.videoInputs[0]!.gainMilliDecibels).toBe(gain === 0 ? undefined : gain);
    if (gain === 0) {
      expect(filter).not.toContain("volume=");
      expect(JSON.stringify(plan)).toBe(JSON.stringify(active()));
    } else {
      expect(filter).toContain(`asetpts=PTS-STARTPTS,volume=${db}dB[a0]`);
      expect(() => compile(revision)).toThrow("requires default transform and gain");
    }
  });
  it.each([-96001, 24001, 0.1, null, "-6000", { value: -6000 }])(
    "rejects invalid gain metadata %j",
    (gainMilliDecibels) => {
      const plan = active();
      expect(
        renderPlanV2Schema.safeParse({
          ...plan,
          videoInputs: [{ ...plan.videoInputs[0], gainMilliDecibels }],
        }).success,
      ).toBe(false);
    },
  );
  it("rejects unknown input metadata", () => {
    const plan = active();
    expect(
      renderPlanV2Schema.safeParse({ ...plan, videoInputs: [{ ...plan.videoInputs[0], gain: -6 }] })
        .success,
    ).toBe(false);
  });
  it.each([false, true])("keeps gain independent of hidden/opacity/speed and mute=%s", (muted) => {
    const plan = active(
      withGain(-6123, {
        hidden: true,
        opacityPermille: 0,
        muted,
        speed: { numerator: 2, denominator: 1 },
        sourceOut: 105,
      }),
    );
    expect(plan.videoInputs[0]!.gainMilliDecibels).toBe(-6123);
    expect(plan.expected.audio).toBe(!muted);
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
    expect(filter).not.toContain("[0:v:0]");
    if (muted) expect(filter).not.toContain("volume=");
    else expect(filter).toContain("atempo=2.00,atrim=duration=1.501500,volume=-6.123dB[a0]");
    expect(filter).not.toContain("asetrate");
  });
});

describe("V2 speed export", () => {
  const active = (revision = makeV2Revision()) =>
    compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
    });
  it.each([
    { numerator: 1, denominator: 2, frames: 180, tempo: "0.50" },
    { numerator: 3, denominator: 4, frames: 120, tempo: "0.75" },
    { numerator: 3, denominator: 2, frames: 60, tempo: "1.50" },
    { numerator: 2, denominator: 1, frames: 45, tempo: "2.00" },
  ])(
    "compiles exact source trim, tempo and duration: %j",
    ({ numerator, denominator, frames, tempo }) => {
      const speed = { numerator, denominator };
      const revision = makeV2Revision({ speed, sourceOut: 105 });
      const before = structuredClone(revision);
      expect(getActiveSequenceRenderEligibility(revision)).toEqual({ eligible: true });
      const plan = active(revision);
      expect(plan.expected.durationFrames).toBe(frames);
      expect(plan.videoInputs[0]!.timing).toEqual({
        sourceIn: createRationalTime(15, plan.expected.rate),
        sourceOut: createRationalTime(105, plan.expected.rate),
        speed,
        outputDuration: createRationalTime(frames, plan.expected.rate),
      });
      expect(plan.argv.slice(7, 13)).toEqual([
        "-ss",
        "0.500500",
        "-t",
        "3.003000",
        "-i",
        inputPath,
      ]);
      const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
      expect(filter).toContain(
        `trim=end_frame=90,setpts=PTS-STARTPTS,settb=expr=intb/${numerator},setpts=PTS*${denominator}/${numerator},scale=`,
      );
      const tempoFilter =
        numerator < denominator
          ? `rubberband=tempo=${tempo}:window=short:transients=smooth`
          : `atempo=${tempo}`;
      expect(filter).toContain(
        `atrim=duration=3.003000,asetpts=PTS-STARTPTS,${tempoFilter},atrim=duration=`,
      );
      expect(filter).not.toContain("asetrate");
      expect(revision).toEqual(before);
      expect(() =>
        compileSingleClipRenderPlan({ planId: ids.plan, revision, inputPath, outputPath }),
      ).toThrow("Clip speed rendering is not supported yet");
    },
  );
  it("rejects inconsistent, missing and malformed timing fields", () => {
    const plan = active(
      makeV2Revision({ speed: { numerator: 2, denominator: 1 }, sourceOut: 105 }),
    );
    expect(renderPlanV2Schema.safeParse(plan).success).toBe(true);
    const input = plan.videoInputs[0]!;
    for (const timing of [
      null,
      { ...input.timing, speed: undefined },
      { ...input.timing, speed: { numerator: 0, denominator: 1 } },
      { ...input.timing, outputDuration: createRationalTime(46, plan.expected.rate) },
      { ...input.timing, surprise: true },
    ]) {
      expect(
        renderPlanV2Schema.safeParse({ ...plan, videoInputs: [{ ...input, timing }] }).success,
      ).toBe(false);
    }
    expect(
      renderPlanV2Schema.safeParse({ ...plan, expected: { ...plan.expected, durationFrames: 46 } })
        .success,
    ).toBe(false);
    expect(
      renderPlanV2Schema.safeParse({
        ...plan,
        videoInputs: [{ ...input, sourceInMicroseconds: 0 }],
      }).success,
    ).toBe(false);
    expect(
      renderPlanV2Schema.safeParse({
        ...plan,
        expected: { ...plan.expected, rate: { numerator: 30, denominator: 1 } },
      }).success,
    ).toBe(false);
  });
  it("compares retimed rather than source durations across layers", () => {
    const revision = makeV2Revision({ speed: { numerator: 2, denominator: 1 }, sourceOut: 105 });
    const sequence = revision.state.sequences[0]!;
    const top = sequence.tracks[0]!;
    if (top.kind !== "video") throw new Error("video fixture");
    const second = structuredClone(top);
    second.id = "00000000-0000-4000-8000-000000000091";
    second.clips[0]!.id = "00000000-0000-4000-8000-000000000092";
    delete second.clips[0]!.speed;
    second.clips[0]!.sourceOut.value = 60;
    sequence.tracks.push(second);
    const plan = active(revision);
    expect(plan.expected.durationFrames).toBe(45);
    expect(plan.videoInputs).toHaveLength(2);
    expect(plan.videoInputs[1]!.timing).toBeUndefined();
    second.clips[0]!.sourceOut.value = 105;
    expect(getActiveSequenceRenderEligibility(revision)).toEqual({
      eligible: false,
      reason: "Every video track must have one common positive duration",
    });
  });
  it("retains hidden, mute and dedicated-audio restrictions", () => {
    const revision = makeV2Revision({
      speed: { numerator: 2, denominator: 1 },
      sourceOut: 105,
      hidden: true,
      muted: true,
    });
    const plan = active(revision);
    expect(plan.expected.durationFrames).toBe(45);
    expect(plan.expected.audio).toBe(false);
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1]!;
    expect(filter).not.toContain("[0:v:0]");
    expect(filter).not.toContain("[0:a:0]");
    expect(plan.argv).toContain("-an");
    expect(
      getActiveSequenceRenderEligibility(
        makeV2Revision({
          speed: { numerator: 2, denominator: 1 },
          sourceOut: 105,
          dedicatedAudioTrack: "non-empty",
        }),
      ).eligible,
    ).toBe(false);
  });
  it("keeps omitted and explicit normal-speed output identical in V1 and V2", () => {
    const normal = makeV2Revision({ speed: { numerator: 1, denominator: 1 } });
    expect(active(normal)).toEqual(active());
    expect(compile(normal)).toEqual(compile(makeV2Revision()));
  });
});

describe("compileSingleClipRenderPlan", () => {
  it("skips a graphics track without clips and compiles the same plan as without it", () => {
    const withGraphics = compile(makeV2Revision({ emptyGraphicsTrack: true }));

    expect(withGraphics).toEqual(compile(makeV2Revision()));
  });

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
      `${shownVideoFilter},drawtext=text=Speaker\\\\: we\\\\\\'re ready\\, 100\\\\\\\\%:fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:enable='gte(t\\,0.500500)*lt(t\\,1.001000)'`,
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

  it.each([
    [24, 1, "48"],
    [24_000, 1_001, "48"],
    [25, 1, "50"],
    [30, 1, "60"],
    [30_000, 1_001, "60"],
    [60, 1, "120"],
  ])("places a keyframe every 2 s at %i/%i fps (-g %s)", (numerator, denominator, frames) => {
    const plan = compile(
      makeRevision({ rate: createRationalRate(numerator, denominator), sourceIn: 0, sourceOut: 1 }),
    );
    const index = plan.argv.indexOf("-g");

    expect(index).toBeGreaterThan(plan.argv.indexOf("libx264"));
    expect(plan.argv[index + 1]).toBe(frames);
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

  it("composites visible graphics clips through sentinel inputs in stacking order", () => {
    const revision = makeV2Revision({
      stillAsset: true,
      graphicsTracks: [
        // First graphics track ends on top, so it is composited last.
        {
          id: "9a000000-0000-4000-8000-0000000000b1",
          graphicsClips: [graphicsClipAt("9a000000-0000-4000-8000-0000000000c1", 30, 15)],
        },
        {
          id: "9a000000-0000-4000-8000-0000000000b2",
          graphicsClips: [
            graphicsClipAt("9a000000-0000-4000-8000-0000000000c2", 0, 30, true),
            // Starts after the export ends: never rendered.
            graphicsClipAt("9a000000-0000-4000-8000-0000000000c3", 400, 10),
          ],
        },
        {
          id: "9a000000-0000-4000-8000-0000000000b3",
          hidden: true,
          graphicsClips: [graphicsClipAt("9a000000-0000-4000-8000-0000000000c4", 0, 10)],
        },
      ],
    });

    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      graphicsImagePathsByAssetId: { [stillAsset.id]: stillPath },
      outputPath,
    });

    expect(
      plan.graphics?.map(
        ({ clip, trackId, startMicroseconds, endMicroseconds, imagePathsByAssetId }) => ({
          clipId: clip.id,
          trackId,
          startMicroseconds,
          endMicroseconds,
          imagePathsByAssetId,
        }),
      ),
    ).toEqual([
      {
        clipId: "9a000000-0000-4000-8000-0000000000c2",
        trackId: "9a000000-0000-4000-8000-0000000000b2",
        startMicroseconds: 0,
        endMicroseconds: 1_001_000,
        imagePathsByAssetId: { [stillAsset.id]: stillPath },
      },
      {
        clipId: "9a000000-0000-4000-8000-0000000000c1",
        trackId: "9a000000-0000-4000-8000-0000000000b1",
        startMicroseconds: 1_001_000,
        endMicroseconds: 1_501_500,
        imagePathsByAssetId: {},
      },
    ]);
    const inputs = plan.argv.slice(0, plan.argv.indexOf("-filter_complex"));
    expect(inputs.slice(-4)).toEqual(["-i", "graphics:0", "-i", "graphics:1"]);
    expect(plan.argv[plan.argv.indexOf("-filter_complex") + 1]).toBe(
      [
        ...expectedActiveSequenceFilter("1.000").split(";").slice(0, 4),
        "[1:v:0]setpts=PTS-STARTPTS+0.000000/TB[g0]",
        String.raw`[stack0][g0]overlay=x=0:y=0:eof_action=pass:format=auto:enable='gte(t\,0.000000)*lt(t\,1.001000)'[gfx0]`,
        "[2:v:0]setpts=PTS-STARTPTS+1.001000/TB[g1]",
        String.raw`[gfx0][g1]overlay=x=0:y=0:eof_action=pass:format=auto:enable='gte(t\,1.001000)*lt(t\,1.501500)'[gfx1]`,
        "[gfx1]null[vout]",
        "[a0]anull[aout]",
      ].join(";"),
    );
    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
  });

  it.each([["a missing image path", {}, "Every graphics image layer requires an input path"]])(
    "refuses graphics with %s",
    (_name, graphicsImagePathsByAssetId, message) => {
      const revision = makeV2Revision({
        stillAsset: true,
        graphicsTracks: [
          {
            id: "9a000000-0000-4000-8000-0000000000b2",
            graphicsClips: [graphicsClipAt("9a000000-0000-4000-8000-0000000000c2", 0, 30, true)],
          },
        ],
      });

      expect(() =>
        compileActiveSequenceRenderPlan({
          planId: ids.plan,
          revision,
          inputPathsByAssetId: { [ids.asset]: inputPath },
          graphicsImagePathsByAssetId,
          outputPath,
        }),
      ).toThrow(message);
    },
  );

  it("refuses more graphics clips than one export can composite", () => {
    const clips = Array.from({ length: 65 }, (_, index) =>
      graphicsClipAt(
        `9a000000-0000-4000-8000-${(0xd00 + index).toString(16).padStart(12, "0")}`,
        index,
        1,
      ),
    );
    const revision = makeV2Revision({
      graphicsTracks: [{ id: "9a000000-0000-4000-8000-0000000000b2", graphicsClips: clips }],
    });

    expect(() =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      }),
    ).toThrow("At most 64 graphics clips can be exported per sequence");
  });

  it.each([
    ["17 different images", 17, 900, "A graphics clip can use at most 16 different images"],
    [
      "images over 40 MB in total",
      2,
      21 * 1024 * 1024,
      "The images in one graphics clip can total at most 40 MB",
    ],
  ])("refuses a graphics clip with %s", (_name, imageCount, fileSizeBytes, message) => {
    const stills = Array.from({ length: imageCount }, (_, index) => ({
      ...stillAsset,
      id: `9a000000-0000-4000-8000-${(0xe00 + index).toString(16).padStart(12, "0")}`,
      probe: { ...stillAsset.probe, fileSizeBytes },
    }));
    const clip = graphicsClipAt("9a000000-0000-4000-8000-0000000000c2", 0, 30, true);
    const imageLayer = clip.layers[1];
    if (imageLayer?.kind !== "image") throw new Error("expected image layer fixture");
    const revision = makeV2Revision({
      graphicsTracks: [
        {
          id: "9a000000-0000-4000-8000-0000000000b2",
          graphicsClips: [
            {
              ...clip,
              layers: stills.map((still) => ({ ...imageLayer, assetId: still.id })),
            },
          ],
        },
      ],
    });
    revision.state.assets.push(...stills);

    expect(() =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        graphicsImagePathsByAssetId: Object.fromEntries(
          stills.map((still) => [still.id, String.raw`C:\Media\${still.id}.png`]),
        ),
        outputPath,
      }),
    ).toThrow(message);
  });

  it("rejects plans whose graphics image paths do not match the image layers", () => {
    const revision = makeV2Revision({
      stillAsset: true,
      graphicsTracks: [
        {
          id: "9a000000-0000-4000-8000-0000000000b2",
          graphicsClips: [graphicsClipAt("9a000000-0000-4000-8000-0000000000c2", 0, 30, true)],
        },
      ],
    });
    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      graphicsImagePathsByAssetId: { [stillAsset.id]: stillPath },
      outputPath,
    });
    const graphics = plan.graphics?.[0];
    if (graphics === undefined) throw new Error("expected graphics");

    expect(
      renderPlanV2Schema.safeParse({
        ...plan,
        graphics: [{ ...graphics, imagePathsByAssetId: {} }],
      }).success,
    ).toBe(false);
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

  it("tags ducking without an audible dialogue track as an audio mix error", () => {
    const revision = structuredClone(makeV2Revision());
    const sequence = revision.state.sequences[0]!;
    Object.assign(sequence, {
      loudnessTarget: {
        integratedLufs: -14,
        truePeakCeilingDbtp: -1,
        ducking: true,
        dialogueCleanup: false,
      },
    });
    Object.assign(sequence.tracks[0]!, { audioRole: "music" });

    const error = expectInvalidRenderPlan(() =>
      compileActiveSequenceRenderPlan({
        planId: ids.plan,
        revision,
        inputPathsByAssetId: { [ids.asset]: inputPath },
        outputPath,
      }),
    );

    expect(error.details["category"]).toBe("audio_mix_invalid");
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
    expect(shownFilter).toContain(
      "[stack0]drawtext=text=Speaker\\\\: we\\\\\\'re ready\\, 100\\\\\\\\%:fontcolor=",
    );
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

describe("V2 rights context", () => {
  const receiptId = "00000000-0000-4000-8000-00000000a001";
  const compileWith = (
    revision: ReturnType<typeof makeV2Revision>,
    intendedUse?: "private-preview" | "broadcast",
  ) =>
    compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      outputPath,
      ...(intendedUse === undefined ? {} : { intendedUse }),
    });

  it("leaves plans without a declared use byte-identical to before", () => {
    const plan = compileWith(makeV2Revision());
    expect("rights" in plan).toBe(false);
  });

  it("claims acquired assets by receipt id and records the declared use", () => {
    const revision = makeV2Revision();
    const asset = revision.state.assets[0]!;
    revision.state.assets[0] = {
      ...asset,
      origin: { kind: "acquired", acquisitionReceiptId: receiptId },
    };
    const plan = compileWith(revision, "broadcast");
    expect(plan.rights).toEqual({
      intendedUse: "broadcast",
      acquisitionReceiptIdsByAssetId: { [ids.asset]: receiptId },
    });
    expect(plan.argv).toEqual(compileWith(makeV2Revision()).argv);
  });

  it("declares the use with no claims for local-only projects", () => {
    const plan = compileWith(makeV2Revision(), "private-preview");
    expect(plan.rights).toEqual({
      intendedUse: "private-preview",
      acquisitionReceiptIdsByAssetId: {},
    });
  });

  it("claims acquired graphics still images so the release gate checks them", () => {
    const revision = makeV2Revision({
      stillAsset: true,
      graphicsTracks: [
        {
          id: "9a000000-0000-4000-8000-0000000000b2",
          graphicsClips: [graphicsClipAt("9a000000-0000-4000-8000-0000000000c2", 0, 30, true)],
        },
      ],
    });
    revision.state.assets = revision.state.assets.map((asset) =>
      asset.id === stillAsset.id
        ? { ...asset, origin: { kind: "acquired", acquisitionReceiptId: receiptId } }
        : asset,
    );
    const plan = compileActiveSequenceRenderPlan({
      planId: ids.plan,
      revision,
      inputPathsByAssetId: { [ids.asset]: inputPath },
      graphicsImagePathsByAssetId: { [stillAsset.id]: stillPath },
      outputPath,
      intendedUse: "broadcast",
    });
    expect(plan.rights).toEqual({
      intendedUse: "broadcast",
      acquisitionReceiptIdsByAssetId: { [stillAsset.id]: receiptId },
    });
    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
  });

  it("rejects claims for assets that are not render inputs", () => {
    const plan = compileWith(makeV2Revision(), "private-preview");
    expect(
      renderPlanV2Schema.safeParse({
        ...plan,
        rights: {
          intendedUse: "private-preview",
          acquisitionReceiptIdsByAssetId: { "00000000-0000-4000-8000-00000000ffff": receiptId },
        },
      }).success,
    ).toBe(false);
  });
});
