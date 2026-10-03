import {
  applyGraphicsGroup,
  type GraphicsKeyframe,
  type GraphicsLayer,
  type VideoProjectStateV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { fixtureGraphicsClip, fixtureGraphicsTrack } from "./graphics-test-fixtures.js";
import { snapGraphicsKeyframesToMusicBeats } from "./snap-graphics-to-music-beats.js";

const rate = { numerator: 30, denominator: 1 };
const ids = {
  sequence: "9c000000-0000-4000-8000-000000000001",
  track: "9c000000-0000-4000-8000-000000000002",
  clip: "9c000000-0000-4000-8000-000000000003",
  command: "9c000000-0000-4000-8000-000000000004",
};
const ref = { sequenceId: ids.sequence, trackId: ids.track, graphicsClipId: ids.clip };
const inverseId = (commandId: string, ordinal: number): string =>
  `${commandId.slice(0, 24)}${String(ordinal).padStart(12, "0")}`;
const keys = (...times: number[]): GraphicsKeyframe[] =>
  times.map((timeMicroseconds, index) => ({ timeMicroseconds, value: index / 10 }));
const hold = (value: number): GraphicsKeyframe[] => [{ timeMicroseconds: 0, value }];
// 120 BPM on the timeline: a music beat every 0.5 s.
const musicBeats120 = Array.from({ length: 20 }, (_, index) => index * 500_000);
const tolerance = 100_000;

function rect(opacity: GraphicsKeyframe[]): GraphicsLayer {
  return {
    kind: "rect",
    width: 300,
    height: 80,
    cornerRadius: 0,
    fill: "#000000",
    x: hold(10),
    y: hold(10),
    scale: hold(1),
    rotation: hold(0),
    opacity,
  };
}

/** A 4 s graphics clip starting at `startFrame` (30 fps). */
function state(
  layers: GraphicsLayer[],
  options: { locked?: boolean; startFrame?: number } = {},
): VideoProjectStateV2 {
  const clip = fixtureGraphicsClip(ids.clip, rate, options.startFrame ?? 0, 120);
  return {
    assets: [],
    sequences: [
      {
        id: ids.sequence,
        name: "Main",
        rate,
        width: 1920,
        height: 1080,
        audioSampleRate: 48_000,
        tracks: [
          {
            ...fixtureGraphicsTrack(ids.track, [{ ...clip, layers }]),
            ...(options.locked === true ? { locked: true } : {}),
          },
        ],
        markers: [],
      },
    ],
    activeSequenceId: ids.sequence,
  };
}

function snappedOpacityTimes(base: VideoProjectStateV2, beats = musicBeats120): number[] {
  const result = snapGraphicsKeyframesToMusicBeats(base, ref, beats, tolerance, ids.command);
  if (!result.ok) throw new Error(result.error.message);
  const layer = result.command.layers[0];
  if (layer === undefined) throw new Error("missing layer");
  return layer.opacity.map(({ timeMicroseconds }) => timeMicroseconds);
}

describe("snapGraphicsKeyframesToMusicBeats", () => {
  it("moves keyframes within tolerance onto the nearest music beat", () => {
    const base = state([rect(keys(0, 460_000, 1_080_000, 1_700_000))]);
    // 460 ms → 500 ms, 1080 ms → 1000 ms; 1700 ms is 200 ms from any music beat.
    expect(snappedOpacityTimes(base)).toEqual([0, 500_000, 1_000_000, 1_700_000]);
  });

  it("works in timeline time for a clip that starts mid-sequence", () => {
    // Clip starts at frame 9 = 300 ms; music beats at 500/1000 ms → clip time 200/700 ms.
    const base = state([rect(keys(0, 230_000, 650_000))], { startFrame: 9 });
    expect(snappedOpacityTimes(base)).toEqual([0, 200_000, 700_000]);
  });

  it("keeps keys in order and never merges two keys onto one music beat", () => {
    // Both 470 ms and 530 ms are nearest to the 500 ms music beat.
    const base = state([rect(keys(0, 470_000, 530_000))]);
    expect(snappedOpacityTimes(base)).toEqual([0, 500_000, 530_000]);
  });

  it("leaves a key whose music beat is already taken by the previous key", () => {
    // 1020 ms snaps to 1000 ms; 1080 ms would then collide with it, so it stays.
    const base = state([rect(keys(0, 1_020_000, 1_080_000))]);
    expect(snappedOpacityTimes(base)).toEqual([0, 1_000_000, 1_080_000]);
  });

  it("returns one command that applies and undoes in one step", () => {
    const base = state([rect(keys(0, 960_000))]);
    const result = snapGraphicsKeyframesToMusicBeats(
      base,
      ref,
      musicBeats120,
      tolerance,
      ids.command,
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.snappedKeyframes).toBe(1);
    expect(result.command).toMatchObject({ type: "SetGraphicsClipLayers", ...ref });

    const applied = applyGraphicsGroup(base, [result.command], inverseId);
    if (!applied.ok) throw new Error(applied.category);
    expect(applied.inverse).toHaveLength(1);
    const undone = applyGraphicsGroup(applied.state, applied.inverse, inverseId);
    if (!undone.ok) throw new Error(undone.category);
    expect(undone.state).toEqual(base);
  });

  it("ignores music beats past the clip end", () => {
    const base = state([rect(keys(0, 3_960_000))]);
    expect(
      snapGraphicsKeyframesToMusicBeats(base, ref, [4_100_000], 200_000, ids.command),
    ).toMatchObject({ ok: false, error: { code: "nothing_to_snap" } });
  });

  it.each([
    ["locked track", state([rect(keys(0, 460_000))], { locked: true }), "track_locked"],
    ["no nearby music beat", state([rect(keys(0, 250_000))]), "nothing_to_snap"],
  ])("rejects %s", (_name, base, code) => {
    expect(
      snapGraphicsKeyframesToMusicBeats(base, ref, musicBeats120, tolerance, ids.command),
    ).toMatchObject({ ok: false, error: { code } });
  });

  it("rejects an unknown clip and a negative tolerance", () => {
    const base = state([rect(keys(0, 460_000))]);
    expect(
      snapGraphicsKeyframesToMusicBeats(
        base,
        { ...ref, graphicsClipId: ids.command },
        musicBeats120,
        tolerance,
        ids.command,
      ),
    ).toMatchObject({ ok: false, error: { code: "unknown_graphics_clip" } });
    expect(
      snapGraphicsKeyframesToMusicBeats(base, ref, musicBeats120, -1, ids.command),
    ).toMatchObject({ ok: false, error: { code: "invalid_tolerance" } });
  });

  it("does not mutate the input state", () => {
    const base = state([rect(keys(0, 460_000))]);
    const before = structuredClone(base);
    snapGraphicsKeyframesToMusicBeats(base, ref, musicBeats120, tolerance, ids.command);
    expect(base).toEqual(before);
  });
});
