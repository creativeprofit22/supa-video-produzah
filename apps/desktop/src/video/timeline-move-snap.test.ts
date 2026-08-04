import type { ProjectClip, VideoSequenceV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  createTimelineMoveSnapContext,
  resolveTimelineMoveSnap,
  timelineFrameForClipSourceFrame,
} from "./timeline-move-snap";

const frameRate = { numerator: 10, denominator: 1 } as const;
const time = (value: number) => ({
  value,
  rateNumerator: frameRate.numerator,
  rateDenominator: frameRate.denominator,
});

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

function sequence(clips: readonly ProjectClip[]): VideoSequenceV2 {
  return {
    id: "sequence-id",
    name: "Sequence",
    rate: frameRate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      { id: "video-track", name: "Video", kind: "video", clips: [...clips] },
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
  const movingClip = clip("moving", 10, 4);
  const otherClip = clip("other", 30, 5);
  const context = createTimelineMoveSnapContext(sequence([movingClip, otherClip]), 50);

  it("maps the source playhead through clip trim and timeline offsets", () => {
    const trimmedAndMovedClip: ProjectClip = {
      ...movingClip,
      timelineStart: time(40),
      sourceIn: time(10),
      sourceOut: time(20),
    };

    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 12)).toBe(42);
    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 9)).toBeNull();
    expect(timelineFrameForClipSourceFrame(trimmedAndMovedClip, 20)).toBeNull();
  });

  it("chooses the smaller correction from either moving edge", () => {
    const trailingEdge = resolveTimelineMoveSnap(context, {
      movingClipId: movingClip.id,
      proposedStartFrame: 25,
      durationFrames: 4,
      ...snapGeometry,
    });
    expect(trailingEdge).toEqual({
      startFrame: 26,
      guide: { frame: 30, targetKind: "clip-start", movingEdge: "end" },
    });

    const leadingEdge = resolveTimelineMoveSnap(context, {
      movingClipId: movingClip.id,
      proposedStartFrame: 29,
      durationFrames: 4,
      ...snapGeometry,
    });
    expect(leadingEdge).toEqual({
      startFrame: 30,
      guide: { frame: 30, targetKind: "clip-start", movingEdge: "start" },
    });
  });

  it("snaps to the playhead and excludes both edges of the moving clip", () => {
    expect(
      resolveTimelineMoveSnap(context, {
        movingClipId: movingClip.id,
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
        proposedStartFrame: 11,
        durationFrames: 4,
        ...snapGeometry,
      }),
    ).toEqual({ startFrame: 11, guide: null });
  });
});
