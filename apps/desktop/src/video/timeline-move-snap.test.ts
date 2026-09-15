import type { ProjectClip, VideoSequenceV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  createTimelineMoveSnapContext,
  resolveTimelineMoveSnap,
  timelineFrameForClipSourceFrame,
} from "./timeline-move-snap";

const frameRate = { numerator: 10, denominator: 1 } as const;
const sourceFrameRate = { numerator: 20, denominator: 1 } as const;
const timeAtRate = (value: number, rate: typeof frameRate | typeof sourceFrameRate) => ({
  value,
  rateNumerator: rate.numerator,
  rateDenominator: rate.denominator,
});
const time = (value: number) => timeAtRate(value, frameRate);
const sourceTime = (value: number) => timeAtRate(value, sourceFrameRate);

function clip(id: string, startFrame: number, durationFrames: number): ProjectClip {
  return {
    id,
    source: { kind: "asset", assetId: "asset-id" },
    timelineStart: time(startFrame),
    sourceIn: time(0),
    sourceOut: time(durationFrames),
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
  clips: readonly ProjectClip[],
  crossTrackClips: readonly ProjectClip[] = [],
): VideoSequenceV2 {
  return {
    id: "sequence-id",
    name: "Sequence",
    rate: frameRate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      { id: "video-track", name: "Video", kind: "video", clips: [...clips] },
      {
        id: "cross-track",
        name: "Cross-track video",
        kind: "video",
        clips: [...crossTrackClips],
      },
      { id: "caption-track", name: "Captions", kind: "caption", captions: [] },
    ],
    markers: [],
  };
}

const snapGeometry = {
  zoomScale: { numerator: 10, denominator: 1 } as const,
  maximumSnapDistancePixels: 6,
};

describe("timeline move snap resolution", () => {
  it("uses retimed endpoints and rejects inexact source-to-timeline edit positions", () => {
    const target = {
      ...clip("retimed", 10, 35),
      sourceIn: time(5),
      speed: { numerator: 3, denominator: 2 },
    };
    const retimed = createTimelineMoveSnapContext(sequence([target]), null);
    expect(retimed.clipIntervals).toEqual([
      { clipId: "retimed", trackId: "video-track", startFrame: 10, endFrameExclusive: 30 },
    ]);
    expect(timelineFrameForClipSourceFrame(target, 8)).toBe(12);
    expect(timelineFrameForClipSourceFrame(target, 6)).toBeNull();
    expect(timelineFrameForClipSourceFrame(target, 35)).toBeNull();
    expect(
      resolveTimelineMoveSnap(retimed, {
        movingClipId: "moving",
        destinationTrackId: "video-track",
        proposedStartFrame: 29,
        durationFrames: 2,
        ...snapGeometry,
      }),
    ).toMatchObject({ startFrame: 30, guide: { frame: 30, targetKind: "clip-end" } });
  });
  it("cancels speed before an otherwise inexact source-rate rescale", () => {
    const target = {
      ...clip("tiny", 4, 1),
      sourceIn: sourceTime(0),
      sourceOut: sourceTime(1),
      speed: { numerator: 1, denominator: 2 },
    };
    expect(
      createTimelineMoveSnapContext(sequence([target]), null).clipIntervals[0]?.endFrameExclusive,
    ).toBe(5);
  });
  const movingClip = clip("moving", 10, 4);
  const otherClip = clip("other", 30, 5);
  const context = createTimelineMoveSnapContext(sequence([movingClip, otherClip]), 50);

  it("rescales source-rate playheads and clip-edge targets into sequence frames", () => {
    const trimmedAndMovedClip: ProjectClip = {
      ...movingClip,
      timelineStart: time(40),
      sourceIn: sourceTime(10),
      sourceOut: sourceTime(20),
    };
    const mixedRateTarget: ProjectClip = {
      ...otherClip,
      sourceIn: sourceTime(10),
      sourceOut: sourceTime(20),
    };

    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 12)).toBe(41);
    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 9)).toBeNull();
    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 20)).toBeNull();
    expect(
      resolveTimelineMoveSnap(
        createTimelineMoveSnapContext(sequence([movingClip], [mixedRateTarget]), null),
        {
          movingClipId: movingClip.id,
          destinationTrackId: "video-track",
          proposedStartFrame: 31,
          durationFrames: 4,
          ...snapGeometry,
        },
      ),
    ).toEqual({
      startFrame: 31,
      guide: { frame: 35, targetKind: "clip-end", movingEdge: "end" },
    });
  });

  it("returns no playhead for an in-range source frame without an exact sequence-frame mapping", () => {
    const mixedRateClip: ProjectClip = {
      ...movingClip,
      timelineStart: time(40),
      sourceIn: sourceTime(10),
      sourceOut: sourceTime(20),
    };

    expect(timelineFrameForClipSourceFrame(mixedRateClip, 11)).toBeNull();
  });

  it("keeps legal same-track butt adjacency", () => {
    const trailingEdge = resolveTimelineMoveSnap(context, {
      movingClipId: movingClip.id,
      destinationTrackId: "video-track",
      proposedStartFrame: 25,
      durationFrames: 4,
      ...snapGeometry,
    });
    expect(trailingEdge).toEqual({
      startFrame: 26,
      guide: { frame: 30, targetKind: "clip-start", movingEdge: "end" },
    });
  });

  it("rejects same-track start-to-start and end-to-end overlap candidates", () => {
    const startToStart = resolveTimelineMoveSnap(context, {
      movingClipId: movingClip.id,
      destinationTrackId: "video-track",
      proposedStartFrame: 29,
      durationFrames: 4,
      ...snapGeometry,
    });
    expect(startToStart).toEqual({ startFrame: 29, guide: null });

    const endToEnd = resolveTimelineMoveSnap(context, {
      movingClipId: movingClip.id,
      destinationTrackId: "video-track",
      proposedStartFrame: 31,
      durationFrames: 4,
      ...snapGeometry,
    });
    expect(endToEnd).toEqual({ startFrame: 31, guide: null });
  });

  it("snaps to the playhead and excludes both edges of the moving clip", () => {
    expect(
      resolveTimelineMoveSnap(context, {
        movingClipId: movingClip.id,
        destinationTrackId: "video-track",
        proposedStartFrame: 49,
        durationFrames: 4,
        ...snapGeometry,
      }),
    ).toEqual({
      startFrame: 50,
      guide: { frame: 50, targetKind: "playhead", movingEdge: "start" },
    });

    const selfOnlyContext = createTimelineMoveSnapContext(sequence([movingClip]), 100);
    expect(
      resolveTimelineMoveSnap(selfOnlyContext, {
        movingClipId: movingClip.id,
        destinationTrackId: "video-track",
        proposedStartFrame: 11,
        durationFrames: 4,
        ...snapGeometry,
      }),
    ).toEqual({ startFrame: 11, guide: null });
  });
});
