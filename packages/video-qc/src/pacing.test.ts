import { createRationalTime, type ProjectClip, type VideoSequenceV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { evaluateEditorial } from "./editorial.js";
import {
  cutsOnMusicBeat,
  musicBeatPacing,
  pacingFindings,
  sequenceShots,
  shotsFromCuts,
  type PacingDraft,
} from "./pacing.js";

const FPS = 30;
const rate = { numerator: FPS, denominator: 1 };
const uuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/** Known-tempo fixture: a 120 BPM track, one music beat every 0.5 s for 60 s. */
const MUSIC_BEATS_120_BPM = Array.from({ length: 121 }, (_, index) => index * 500_000);

function shot(index: number, startFrame: number, frames: number): ProjectClip {
  return {
    id: uuid(100 + index),
    source: { kind: "asset", assetId: uuid(index + 1) },
    timelineStart: createRationalTime(startFrame, rate),
    sourceIn: createRationalTime(0, rate),
    sourceOut: createRationalTime(frames, rate),
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

/** Butt-joined shots of the given lengths (frames at 30 fps) on one video track. */
function cutTo(lengths: readonly number[]): VideoSequenceV2 {
  let start = 0;
  const clips = lengths.map((frames, index) => {
    const clip = shot(index, start, frames);
    start += frames;
    return clip;
  });
  return {
    id: uuid(900),
    name: "Main",
    rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{ id: uuid(901), name: "V1", kind: "video", clips }],
    markers: [],
  };
}

const ofKind = (drafts: readonly PacingDraft[], kind: PacingDraft["kind"]): PacingDraft[] =>
  drafts.filter((draft) => draft.kind === kind);

describe("shots", () => {
  it("are the intervals between 0, each cut and the picture end", () => {
    expect(shotsFromCuts([30, 90], 120)).toEqual([
      { index: 0, startFrame: 0, endFrame: 30 },
      { index: 1, startFrame: 30, endFrame: 90 },
      { index: 2, startFrame: 90, endFrame: 120 },
    ]);
    expect(sequenceShots(cutTo([45, 60, 75])).map((item) => item.endFrame)).toEqual([45, 105, 180]);
    expect(shotsFromCuts([], 0)).toEqual([]);
  });
});

describe("music fit on a known 120 BPM track", () => {
  it("2 s shots cut on the music beat: fraction 1.0 and shot/music beat ratio 4", () => {
    // 2 s, 1.5 s, 2.5 s, 2 s shots: every cut on a music beat, median 2 s.
    const drafts = pacingFindings({
      sequence: cutTo([60, 45, 75, 60]),
      musicBeatsUs: MUSIC_BEATS_120_BPM,
    });
    expect(ofKind(drafts, "cut_off_music_beat")).toEqual([]);
    const [fit] = ofKind(drafts, "music_fit");
    expect(fit?.severity).toBe("info");
    expect(fit?.range).toEqual({ startUs: 0, endUs: 8_000_000 });
    expect(fit?.message).toContain("Cuts on music beat 3/3 (100%, ±40 ms)");
    expect(fit?.message).toContain("music beat 0.50 s, shot/music beat 4.00 (≈4, deviation +0.00)");

    expect(cutsOnMusicBeat([2_000_000, 3_500_000, 6_000_000], MUSIC_BEATS_120_BPM, 40_000)).toEqual(
      { hits: 3, total: 3, fraction: 1, toleranceUs: 40_000 },
    );
    expect(musicBeatPacing(MUSIC_BEATS_120_BPM, 2_000_000)).toEqual({
      periodUs: 500_000,
      ratio: 4,
      nearest: "4",
      deviation: 0,
    });
  });

  it("cuts shifted 100 ms off the music beat: fraction 0 and one finding per cut", () => {
    // +3 frames (100 ms) on the first shot moves every later cut by 100 ms.
    const drafts = pacingFindings({
      sequence: cutTo([63, 45, 75, 57]),
      musicBeatsUs: MUSIC_BEATS_120_BPM,
    });
    const offBeat = ofKind(drafts, "cut_off_music_beat");
    expect(offBeat.map((draft) => draft.range.startUs)).toEqual([2_100_000, 3_600_000, 6_100_000]);
    expect(offBeat.every((draft) => draft.severity === "info")).toBe(true);
    expect(offBeat[0]?.message).toBe(
      "Cut at 2.10 s is 100 ms from the nearest music beat (on-beat within 40 ms)",
    );
    expect(ofKind(drafts, "music_fit")[0]?.message).toContain("Cuts on music beat 0/3 (0%");
  });

  it("counts a cut one frame off as on the music beat at 24 fps", () => {
    expect(cutsOnMusicBeat([2_041_667], MUSIC_BEATS_120_BPM, 41_667).fraction).toBe(1);
    expect(cutsOnMusicBeat([2_050_000], MUSIC_BEATS_120_BPM, 41_667).fraction).toBe(0);
  });

  it("snaps the shot/music beat ratio to the nearest musical ratio", () => {
    expect(musicBeatPacing(MUSIC_BEATS_120_BPM, 750_000)?.nearest).toBe("3/2");
    expect(musicBeatPacing(MUSIC_BEATS_120_BPM, 260_000)?.nearest).toBe("1/2");
    expect(musicBeatPacing([0], 2_000_000)).toBeUndefined();
  });

  it("labels music beats from the in-app tempo fallback", () => {
    const drafts = pacingFindings({
      sequence: cutTo([60, 60]),
      musicBeatsUs: MUSIC_BEATS_120_BPM,
      musicBeatsFromTempoFallback: true,
    });
    expect(ofKind(drafts, "music_fit")[0]?.message).toContain("in-app tempo fallback");
  });

  it("reports no music findings without music beats", () => {
    const drafts = pacingFindings({ sequence: cutTo([63, 45, 75, 57]), musicBeatsUs: [] });
    expect(ofKind(drafts, "cut_off_music_beat")).toEqual([]);
    expect(ofKind(drafts, "music_fit")).toEqual([]);
  });
});

describe("shot length and steady runs", () => {
  it("flags a 0.6 s shot and an 8 s shot but not 1 s or 7 s shots", () => {
    const drafts = pacingFindings({ sequence: cutTo([30, 18, 210, 240]), musicBeatsUs: [] });
    const flagged = ofKind(drafts, "shot_length_out_of_range");
    expect(flagged.map((draft) => draft.message)).toEqual([
      "Shot 2 is 0.60 s; shots usually run 1–7 s",
      "Shot 4 is 8.00 s; shots usually run 1–7 s",
    ]);
    expect(flagged.every((draft) => draft.severity === "info")).toBe(true);
  });

  it("flags four equal shots in a row but not three", () => {
    const four = ofKind(
      pacingFindings({ sequence: cutTo([60, 60, 61, 59, 90]), musicBeatsUs: [] }),
      "steady_shot_run",
    );
    expect(four).toHaveLength(1);
    expect(four[0]?.range).toEqual({ startUs: 0, endUs: 8_000_000 });
    expect(four[0]?.message).toBe(
      "4 shots in a row of 2.00 s ±1 frame make a steady tick, not a rhythm",
    );
    expect(
      ofKind(
        pacingFindings({ sequence: cutTo([60, 60, 60, 90]), musicBeatsUs: [] }),
        "steady_shot_run",
      ),
    ).toEqual([]);
  });
});

describe("editorial evaluation with pacing", () => {
  it("adds info pacing findings under editorial-v3", async () => {
    const evaluation = await evaluateEditorial({
      revisionId: uuid(1),
      revisionStateHash: "a".repeat(64),
      sequence: cutTo([63, 45, 75, 57]),
      // No assets: the clips also raise missing-media blockers, which this test ignores.
      assets: [],
      beats: [],
      musicBeatsUs: MUSIC_BEATS_120_BPM,
    });
    expect(evaluation.evaluatorVersion).toBe("editorial-v3");
    const kinds = evaluation.findings.map((finding) => finding.kind);
    expect(kinds.filter((kind) => kind === "cut_off_music_beat")).toHaveLength(3);
    expect(kinds).toContain("music_fit");
    const pacing = evaluation.findings.filter((finding) =>
      ["cut_off_music_beat", "music_fit", "shot_length_out_of_range", "steady_shot_run"].includes(
        finding.kind,
      ),
    );
    expect(pacing.every((finding) => finding.severity === "info")).toBe(true);
    expect(pacing.every((finding) => finding.source === "editorial")).toBe(true);
  });
});
