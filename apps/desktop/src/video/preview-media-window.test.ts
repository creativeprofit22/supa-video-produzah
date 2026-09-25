import { describe, expect, it } from "vitest";
import { DEFAULT_CLIP_TRANSFORM_GEOMETRY } from "@supa-video/contracts";
import type { ProgramMonitorLayer } from "./ProgramMonitor";
import { previewMediaWindow } from "./preview-media-window";

const rate = { numerator: 30, denominator: 1 };
const layer = (clipId: string, start: number, duration = 30, track = 0): ProgramMonitorLayer => ({
  clipId,
  path: `/${clipId}.mp4`,
  timelineStartFrame: start,
  timelineDurationFrames: duration,
  sourceInFrame: 0,
  sourceOutFrame: duration,
  canonicalTrackIndex: track,
  ...DEFAULT_CLIP_TRANSFORM_GEOMETRY,
  opacityPermille: 1000,
  hidden: false,
  muted: false,
  hasAudio: true,
});
const ids = (layers: readonly ProgramMonitorLayer[]) => layers.map((item) => item.clipId);

describe("preview media window", () => {
  it("keeps all active video/audio/hidden layers and their existing stacking order", () => {
    const layers = [
      layer("v", 0),
      { ...layer("a", 0, 30, 1), audioOnly: true },
      { ...layer("hidden", 0, 30, 2), hidden: true },
    ];
    expect(previewMediaWindow(layers, 15, rate, "v")).toEqual(layers);
  });
  it("caps short-clip prefetch to one nearest neighbour on each side per track", () => {
    const layers = Array.from({ length: 1000 }, (_, i) => layer(`c${i}`, i, 1));
    expect(ids(previewMediaWindow(layers, 500, rate, "c500"))).toEqual(["c499", "c500", "c501"]);
    expect(layers).toHaveLength(1000);
  });
  it("keeps each track's neighbour without dropping simultaneous overlapping clips", () => {
    const layers = [
      layer("v", 0, 30),
      layer("overlap", 0, 30),
      layer("next-v", 30),
      layer("a", 0, 30, 1),
      layer("next-a", 30, 30, 1),
    ];
    expect(ids(previewMediaWindow(layers, 10, rate, "v"))).toEqual(ids(layers));
  });
  it("retains the clock across a long gap without loading the rest of the future", () => {
    const layers = [layer("past", 0), layer("clock", 3000), layer("later", 6000)];
    expect(ids(previewMediaWindow(layers, 1000, rate, "clock"))).toEqual(["clock"]);
  });
  it.each([
    { numerator: 30, denominator: 1 },
    { numerator: 30000, denominator: 1001 },
  ])("uses sequence durations and a bounded one-second window at %j", (sequenceRate) => {
    const slowed = {
      ...layer("slow", 0, 120),
      sourceOutFrame: 60,
      speed: { numerator: 1, denominator: 2 },
    };
    const layers = [slowed, layer("next", 120, 30), layer("far", 151, 30)];
    expect(ids(previewMediaWindow(layers, 90, sequenceRate, "slow"))).toEqual(["slow", "next"]);
    expect(ids(previewMediaWindow(layers, 152, sequenceRate, "far"))).toEqual(["next", "far"]);
  });
});
