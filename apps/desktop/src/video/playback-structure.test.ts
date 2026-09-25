import { DEFAULT_CLIP_TRANSFORM_GEOMETRY, type VideoSequenceV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import type { ProgramMonitorLayer } from "./ProgramMonitor";
import {
  LEGACY_PLAYBACK_STRUCTURE_KEY,
  activeCaptionCuesForTimelineFrame,
  playbackStructureKey,
} from "./playback-structure";

const rate30 = { numerator: 30, denominator: 1 } as const;
const rateNtsc = { numerator: 30_000, denominator: 1_001 } as const;

const layer = (
  clipId: string,
  start: number,
  duration: number,
  track = 0,
  extra: Partial<ProgramMonitorLayer> = {},
): ProgramMonitorLayer => ({
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
  ...extra,
});

const captionSequence = (
  rate: { numerator: number; denominator: number },
  cues: readonly { id: string; start: number; end: number }[],
): VideoSequenceV2 =>
  ({
    id: "sequence",
    name: "Main",
    rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [],
    tracks: [
      {
        id: "captions",
        name: "Captions",
        kind: "caption",
        captions: cues.map((cue) => ({
          id: cue.id,
          text: cue.id,
          start: {
            value: cue.start,
            rateNumerator: rate.numerator,
            rateDenominator: rate.denominator,
          },
          end: { value: cue.end, rateNumerator: rate.numerator, rateDenominator: rate.denominator },
        })),
      },
    ],
  }) as unknown as VideoSequenceV2;

/** Frames in [from, to) where the key differs from the previous frame's key. */
function keyChanges(
  layers: readonly ProgramMonitorLayer[],
  rate: { numerator: number; denominator: number },
  from: number,
  to: number,
  sequence: VideoSequenceV2 | null = null,
): number[] {
  const changes: number[] = [];
  let previous = playbackStructureKey(from, layers, rate, sequence);
  for (let frame = from + 1; frame < to; frame += 1) {
    const key = playbackStructureKey(frame, layers, rate, sequence);
    if (key !== previous) changes.push(frame);
    previous = key;
  }
  return changes;
}

describe("playback structure key", () => {
  it("is constant in legacy mode", () => {
    expect(playbackStructureKey(0, [], rate30, null)).toBe(LEGACY_PLAYBACK_STRUCTURE_KEY);
    expect(playbackStructureKey(999, [], rate30, null)).toBe(LEGACY_PLAYBACK_STRUCTURE_KEY);
  });

  it.each([
    {
      name: "stable inside a long clip",
      layers: [layer("a", 0, 300)],
      rate: rate30,
      range: [0, 300],
      expected: [],
    },
    {
      name: "changes at clip end/start and neighbour window entry (30 fps)",
      // b enters the one-second window at 100 - 30 = 70, becomes active at 100;
      // a leaves the window 30 frames after its end (131).
      layers: [layer("a", 0, 100), layer("b", 100, 200)],
      rate: rate30,
      range: [0, 300],
      expected: [70, 100, 131],
    },
    {
      name: "uses the ceil of the fractional rate for the window (29.97 fps)",
      layers: [layer("a", 0, 100), layer("b", 100, 200)],
      rate: rateNtsc,
      range: [0, 300],
      expected: [70, 100, 131],
    },
    {
      name: "follows fractional-speed timeline durations, not source length",
      layers: [
        layer("fast", 0, 17, 0, {
          sourceOutFrame: 25,
          speed: { numerator: 3, denominator: 2 },
        }),
        layer("next", 17, 100),
      ],
      rate: rate30,
      range: [0, 117],
      expected: [17, 48],
    },
    {
      name: "changes when an overlapping upper layer starts and stops",
      layers: [layer("base", 0, 300, 1), layer("overlay", 150, 50, 0)],
      rate: rate30,
      range: [0, 300],
      expected: [120, 150, 200, 231],
    },
  ])("$name", ({ layers, rate, range, expected }) => {
    expect(keyChanges(layers, rate, range[0]!, range[1]!)).toEqual(expected);
  });

  it("changes the clock layer inside gaps and at the gap end", () => {
    // Gap 100..200: the upcoming clip becomes the clock (and is loaded) at 100,
    // a leaves the window at 131, and b becomes active at 200.
    const layers = [layer("a", 0, 100), layer("b", 200, 100)];
    expect(keyChanges(layers, rate30, 0, 300)).toEqual([100, 131, 200]);
  });

  it("changes exactly at caption cue start and end", () => {
    const layers = [layer("a", 0, 300)];
    const sequence = captionSequence(rate30, [
      { id: "one", start: 40, end: 60 },
      { id: "two", start: 60, end: 75 },
    ]);
    expect(keyChanges(layers, rate30, 0, 300, sequence)).toEqual([40, 60, 75]);
  });

  it("ignores captions where no layer is active, as the editor does", () => {
    const layers = [layer("a", 0, 10), layer("b", 200, 100)];
    const sequence = captionSequence(rate30, [{ id: "gap", start: 100, end: 120 }]);
    expect(keyChanges(layers, rate30, 60, 160, sequence)).toEqual([]);
  });

  it("changes on every frame outside the composition", () => {
    const layers = [layer("a", 10, 20)];
    expect(playbackStructureKey(3, layers, rate30, null)).not.toBe(
      playbackStructureKey(4, layers, rate30, null),
    );
    expect(playbackStructureKey(30, layers, rate30, null)).not.toBe(
      playbackStructureKey(31, layers, rate30, null),
    );
  });

  it("reports active captions with floor starts and ceil ends", () => {
    const sequence = captionSequence(rate30, [{ id: "cue", start: 5, end: 9 }]);
    expect(activeCaptionCuesForTimelineFrame(sequence, 4)).toEqual([]);
    expect(activeCaptionCuesForTimelineFrame(sequence, 5)).toEqual([
      { captionId: "cue", text: "cue" },
    ]);
    expect(activeCaptionCuesForTimelineFrame(sequence, 9)).toEqual([]);
  });
});
