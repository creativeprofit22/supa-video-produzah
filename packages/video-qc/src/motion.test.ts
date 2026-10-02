import {
  createRationalTime,
  type Easing,
  type GraphicsClip,
  type GraphicsKeyframe,
  type GraphicsLayer,
  type ProjectClip,
  type ProjectTrack,
  type RationalRate,
  rationalTimeToMicroseconds,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  layerSpeeds,
  motionFindings,
  motionThresholds,
  sequenceCutFrames,
  splitMoves,
} from "./motion.js";

const EASE: Easing = { kind: "preset", name: "easeInOut" };
const GRAPHICS_ID = uuid(500);
const SUBJECT = `${GRAPHICS_ID}:0`;
const RATES = [25, 30, 60] as const;
/** Overshoots so that at 30 fps the settle wobble splits off as its own slow move. */
const SPRING: Easing = { kind: "spring", bounce: 0.5, durationMs: 800 };

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function rateOf(fps: number): RationalRate {
  return { numerator: fps, denominator: 1 };
}

/** Keyframe at `seconds` from the clip start. */
function key(seconds: number, value: number, easing?: Easing): GraphicsKeyframe {
  const base = { timeMicroseconds: Math.round(seconds * 1_000_000), value };
  return easing === undefined ? base : { ...base, easing };
}

function rect(x: GraphicsKeyframe[], y: GraphicsKeyframe[] = [key(0, 100)]): GraphicsLayer {
  return {
    kind: "rect",
    width: 100,
    height: 100,
    cornerRadius: 0,
    fill: "#FFFFFF",
    x,
    y,
    scale: [key(0, 1)],
    rotation: [key(0, 0)],
    opacity: [key(0, 1)],
  };
}

function graphics(
  fps: number,
  startS: number,
  lengthS: number,
  layers: GraphicsLayer[],
): GraphicsClip {
  const rate = rateOf(fps);
  return {
    graphicsVersion: 1,
    id: GRAPHICS_ID,
    timelineStart: createRationalTime(Math.round(startS * fps), rate),
    duration: createRationalTime(Math.round(lengthS * fps), rate),
    fontKey: "arial-regular",
    layers,
  };
}

function video(id: number, fps: number, startS: number, lengthS: number): ProjectClip {
  const rate = rateOf(fps);
  return {
    id: uuid(id),
    source: { kind: "asset", assetId: uuid(1) },
    timelineStart: createRationalTime(Math.round(startS * fps), rate),
    sourceIn: createRationalTime(0, rate),
    sourceOut: createRationalTime(Math.round(lengthS * fps), rate),
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

function sequence(
  fps: number,
  clip: GraphicsClip,
  videoClips: ProjectClip[] = [],
  graphicsHidden = false,
): VideoSequenceV2 {
  const tracks: ProjectTrack[] = [
    { id: uuid(901), name: "V1", kind: "video", clips: videoClips },
    {
      id: uuid(902),
      name: "G1",
      kind: "graphics",
      hidden: graphicsHidden,
      graphicsClips: [clip],
    },
  ];
  return {
    id: uuid(900),
    name: "Main",
    rate: rateOf(fps),
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
    markers: [],
  };
}

function frameUs(frame: number, fps: number, mode: "floor" | "ceil"): number {
  return rationalTimeToMicroseconds(createRationalTime(frame, rateOf(fps)), mode);
}

/** One graphics clip from 1 s to 4 s; the layer's x track is given in clip-relative seconds. */
function fixture(fps: number, x: GraphicsKeyframe[], videoClips: ProjectClip[] = []) {
  return sequence(fps, graphics(fps, 1, 3, [rect(x)]), videoClips);
}

const kinds = (s: VideoSequenceV2): string[] => motionFindings(s).map((draft) => draft.kind);

describe("motion thresholds", () => {
  it.each([
    [25, 0.01, 1, 5, 13],
    [30, 0.25 / 30, 25 / 30, 6, 15],
    [60, 0.25 / 60, 25 / 60, 12, 30],
  ])("scales the 25 fps tuning to %i fps", (fps, rest, drift, minMove, maxSlow) => {
    const limits = motionThresholds(rateOf(fps));
    expect(limits.restPerFrame).toBeCloseTo(rest, 12);
    expect(limits.driftPerFrame).toBeCloseTo(drift, 12);
    expect(limits.minMoveFrames).toBe(minMove);
    expect(limits.maxSlowFrames).toBe(maxSlow);
  });

  it("never scores moves shorter than 3 frames", () => {
    expect(motionThresholds(rateOf(5)).minMoveFrames).toBe(3);
  });
});

describe.each(RATES)("motion findings at %i fps", (fps) => {
  it("passes an eased move", () => {
    expect(motionFindings(fixture(fps, [key(0.4, 0, EASE), key(1.4, 600)]))).toEqual([]);
  });

  it("flags a linear start/stop as stutter over the move", () => {
    const findings = motionFindings(fixture(fps, [key(0.4, 0), key(1.4, 600)]));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "motion_stutter",
        severity: "warning",
        subject: SUBJECT,
        range: { startUs: 1_400_000, endUs: 2_400_000 },
      }),
    ]);
    expect(findings[0]?.message).toMatch(/SPARC -\d\.\d\d.*allowed SPARC ≥ -1\.8, LDLJ ≥ -11\.5/u);
  });

  it("flags a two-step hitch as stutter", () => {
    const findings = motionFindings(
      fixture(fps, [key(0.4, 0, EASE), key(1, 300, EASE), key(1.6, 600)]),
    );
    expect(findings.map((draft) => [draft.kind, draft.severity])).toEqual([
      ["motion_stutter", "warning"],
    ]);
    expect(findings[0]?.range).toEqual({ startUs: 1_400_000, endUs: 2_600_000 });
  });

  it("flags a move whose peak speed is below the drift speed", () => {
    const findings = motionFindings(fixture(fps, [key(0.4, 0, EASE), key(1.4, 10)]));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "motion_drift",
        severity: "warning",
        subject: SUBJECT,
        range: { startUs: 1_400_000, endUs: 2_400_000 },
      }),
    ]);
    expect(findings[0]?.message).toMatch(/peak \d+\.\d px\/s \(allowed ≥ 25 px\/s\)/u);
  });

  it("flags a long sub-threshold tail as drift", () => {
    // Fast ease to 2 s on the timeline, then a 10 px/s crawl to 3.4 s.
    const findings = motionFindings(
      fixture(fps, [key(0.4, 0, EASE), key(1, 600), key(2.4, 614)]),
    ).filter((draft) => draft.kind === "motion_drift");
    expect(findings).toHaveLength(1);
    const range = findings[0]?.range;
    expect(range?.endUs).toBe(3_400_000);
    expect(range?.startUs).toBeGreaterThan(1_750_000);
    expect(range?.startUs).toBeLessThanOrEqual(2_000_000);
    expect(findings[0]?.message).toMatch(/1\.\d\d s under 25 px\/s \(allowed < 0\.5 s\)/u);
  });

  it("does not flag spring settle wobble after a fast move as drift", () => {
    expect(kinds(fixture(fps, [key(0.2, 0, SPRING), key(1.2, 600)]))).not.toContain("motion_drift");
  });

  it("flags a slow move that starts well after a fast one", () => {
    // Fast ease ends at 1.8 s on the timeline; a 10 px crawl starts 0.7 s later.
    const findings = motionFindings(
      fixture(fps, [key(0.2, 0, EASE), key(0.8, 600), key(1.5, 600, EASE), key(2.5, 610)]),
    ).filter((draft) => draft.kind === "motion_drift");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.range.startUs).toBeGreaterThanOrEqual(2_500_000);
    expect(findings[0]?.message).toMatch(/peak \d+\.\d px\/s \(allowed ≥ 25 px\/s\)/u);
  });

  it("flags a move across a picture cut and splits it there", () => {
    const shots = [video(10, fps, 0, 2), video(11, fps, 2, 3)];
    const s = fixture(fps, [key(0.4, 0, EASE), key(1.6, 600)], shots);
    const cut = 2 * fps;
    expect(sequenceCutFrames(s)).toEqual([cut]);

    const jumps = motionFindings(s).filter((draft) => draft.kind === "motion_cut_jump");
    expect(jumps).toEqual([
      expect.objectContaining({
        severity: "warning",
        subject: SUBJECT,
        range: { startUs: frameUs(cut - 1, fps, "floor"), endUs: frameUs(cut + 1, fps, "ceil") },
      }),
    ]);

    const clip = s.tracks[1]?.kind === "graphics" ? s.tracks[1].graphicsClips[0] : undefined;
    if (clip === undefined) throw new Error("fixture has no graphics clip");
    const moves = splitMoves(
      layerSpeeds(clip, 0, s.rate),
      new Set([cut]),
      motionThresholds(s.rate).restPerFrame,
    );
    expect(moves).toHaveLength(2);
    expect((moves[0]?.f0 ?? 0) + (moves[0]?.speed.length ?? 0)).toBe(cut);
    expect(moves[1]?.f0).toBe(cut + 1);
  });

  it("ignores cuts where the layer is at rest", () => {
    const shots = [video(10, fps, 0, 1.6), video(11, fps, 1.6, 3.4)];
    expect(kinds(fixture(fps, [key(1, 0, EASE), key(2, 600)], shots))).toEqual([]);
  });

  it("skips hidden graphics tracks", () => {
    const clip = graphics(fps, 1, 3, [rect([key(0.4, 0), key(1.4, 600)])]);
    expect(motionFindings(sequence(fps, clip, [], true))).toEqual([]);
  });

  it("ignores a static layer", () => {
    expect(motionFindings(fixture(fps, [key(0, 300)]))).toEqual([]);
    expect(motionFindings(fixture(fps, [key(0.4, 300), key(1.4, 300)]))).toEqual([]);
  });
});

describe("spring settle tail", () => {
  it("splits off a slow move right after the fast one at 30 fps", () => {
    const s = fixture(30, [key(0.2, 0, SPRING), key(1.2, 600)]);
    const clip = s.tracks[1]?.kind === "graphics" ? s.tracks[1].graphicsClips[0] : undefined;
    if (clip === undefined) throw new Error("fixture has no graphics clip");
    const limits = motionThresholds(s.rate);
    const moves = splitMoves(layerSpeeds(clip, 0, s.rate), new Set(), limits.restPerFrame);
    expect(moves).toHaveLength(2);
    expect(Math.max(...(moves[1]?.speed ?? []))).toBeLessThan(limits.driftPerFrame);
  });

  it("is still flagged when a cut separates it from the fast move", () => {
    // The wobble starts on timeline frame 63; a cut at frame 62 lies in the rest gap.
    const shots = [video(10, 30, 0, 62 / 30), video(11, 30, 62 / 30, 2)];
    const s = fixture(30, [key(0.2, 0, SPRING), key(1.2, 600)], shots);
    expect(sequenceCutFrames(s)).toEqual([62]);
    expect(kinds(s)).toContain("motion_drift");
  });
});

describe("motion findings across rates", () => {
  it("gives the same verdicts at 25, 30 and 60 fps", () => {
    const shots = (fps: number) => [video(10, fps, 0, 2), video(11, fps, 2, 3)];
    const cases = [
      [key(0.4, 0, EASE), key(1.4, 600)],
      [key(0.4, 0), key(1.4, 600)],
      [key(0.4, 0, EASE), key(1, 300, EASE), key(1.6, 600)],
      [key(0.4, 0, EASE), key(1.4, 10)],
      [key(0.4, 0, EASE), key(1, 600), key(2.4, 614)],
    ];
    const verdicts = (fps: number) => [
      ...cases.map((x) => kinds(fixture(fps, x)).sort()),
      kinds(fixture(fps, [key(0.4, 0, EASE), key(1.6, 600)], shots(fps))).sort(),
    ];
    expect(verdicts(25)).toEqual(verdicts(30));
    expect(verdicts(60)).toEqual(verdicts(30));
  });

  // Each 36 000-frame move needs a 2^20-point FFT (~0.2 s), so this adversarial clip takes
  // ~14 s; the bound catches a regression to super-linear cost, not ordinary jitter.
  it("scores a worst-case 64-layer, 36 000-frame clip in bounded time", () => {
    const fps = 30;
    const lengthS = 36_000 / fps;
    // 256 linear keys zig-zagging across the canvas: never at rest, one move per layer.
    const layers = Array.from({ length: 64 }, (_, layer) =>
      rect(
        Array.from({ length: 256 }, (_, index) =>
          key((index * lengthS) / 255, (index + layer) % 2 === 0 ? 0 : 1_800),
        ),
      ),
    );
    const started = performance.now();
    const findings = motionFindings(sequence(fps, graphics(fps, 0, lengthS, layers)));
    const elapsed = performance.now() - started;
    expect(findings.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});
