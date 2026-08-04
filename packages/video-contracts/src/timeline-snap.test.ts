import { describe, expect, it } from "vitest";

import { VideoDomainError } from "./errors.js";
import { createRationalRate, createRationalTime } from "./time.js";
import {
  createTimelineSnapIndex,
  snapTimelineTime,
  type TimelineSnapTarget,
} from "./timeline-snap.js";

const frameRate = createRationalRate(24, 1);
const at = (frame: number) => createRationalTime(frame, frameRate);

interface TestSnapTarget extends TimelineSnapTarget {
  readonly id: string;
  readonly kind: "clip-start" | "clip-end" | "playhead";
}

function target(
  id: string,
  frame: number,
  kind: TestSnapTarget["kind"] = "playhead",
  clipId?: string,
): TestSnapTarget {
  return {
    id,
    kind,
    time: at(frame),
    ...(clipId === undefined ? {} : { clipId }),
  };
}

describe("timeline snap index", () => {
  const generousSnapGeometry = {
    zoomScale: frameRate,
    maximumSnapDistancePixels: 100,
  } as const;

  it("matches predecessor and successor from unsorted targets", () => {
    const index = createTimelineSnapIndex([
      target("right", 110),
      target("left", 90),
      target("far-left", 20),
    ]);

    expect(
      snapTimelineTime(index, { proposedTime: at(95), ...generousSnapGeometry }).matchedTarget?.id,
    ).toBe("left");
    expect(
      snapTimelineTime(index, { proposedTime: at(105), ...generousSnapGeometry }).matchedTarget?.id,
    ).toBe("right");
  });

  it("handles empty and outer index boundaries", () => {
    const emptyIndex = createTimelineSnapIndex<TestSnapTarget>([]);
    expect(
      snapTimelineTime(emptyIndex, { proposedTime: at(100), ...generousSnapGeometry }),
    ).toEqual({ correctedTime: at(100), matchedTarget: null });

    const singleTargetIndex = createTimelineSnapIndex([target("only", 100)]);
    expect(
      snapTimelineTime(singleTargetIndex, { proposedTime: at(99), ...generousSnapGeometry })
        .matchedTarget?.id,
    ).toBe("only");
    expect(
      snapTimelineTime(singleTargetIndex, { proposedTime: at(101), ...generousSnapGeometry })
        .matchedTarget?.id,
    ).toBe("only");
  });

  it("keeps coincident target ordering and preserves matched target identity", () => {
    const suppliedTarget = target("first", 100, "clip-end", "clip-a");
    const index = createTimelineSnapIndex([
      suppliedTarget,
      target("second", 100, "clip-start", "clip-b"),
    ]);

    expect(
      snapTimelineTime(index, { proposedTime: at(100), ...generousSnapGeometry }).matchedTarget,
    ).toBe(suppliedTarget);
    expect(
      snapTimelineTime(index, { proposedTime: at(101), ...generousSnapGeometry }).matchedTarget,
    ).toBe(suppliedTarget);
    expect(
      snapTimelineTime(index, {
        proposedTime: at(100),
        movingClipId: "clip-a",
        ...generousSnapGeometry,
      }).matchedTarget?.id,
    ).toBe("second");
  });

  it("walks past every target owned by the moving clip", () => {
    const index = createTimelineSnapIndex([
      target("external-left", 90, "clip-end", "clip-b"),
      target("self-start", 100, "clip-start", "clip-a"),
      target("self-end", 110, "clip-end", "clip-a"),
      target("external-right", 115, "clip-start", "clip-c"),
    ]);

    expect(
      snapTimelineTime(index, {
        proposedTime: at(93),
        movingClipId: "clip-a",
        ...generousSnapGeometry,
      }).matchedTarget?.id,
    ).toBe("external-left");
    expect(
      snapTimelineTime(index, {
        proposedTime: at(112),
        movingClipId: "clip-a",
        ...generousSnapGeometry,
      }).matchedTarget?.id,
    ).toBe("external-right");
  });
});

describe("timeline snapping", () => {
  it("chooses the nearest neighbor and resolves equal distances to the predecessor", () => {
    const index = createTimelineSnapIndex([target("left", 96), target("right", 104)]);

    const nearest = snapTimelineTime(index, {
      proposedTime: at(101),
      zoomScale: createRationalRate(24, 1),
      maximumSnapDistancePixels: 10,
    });
    expect(nearest.correctedTime).toEqual(at(104));
    expect(nearest.matchedTarget?.id).toBe("right");

    const tie = snapTimelineTime(index, {
      proposedTime: at(100),
      zoomScale: createRationalRate(24, 1),
      maximumSnapDistancePixels: 10,
    });
    expect(tie.correctedTime).toEqual(at(96));
    expect(tie.matchedTarget?.id).toBe("left");
  });

  it("snaps an exact match but rejects nonzero distance at a zero threshold", () => {
    const index = createTimelineSnapIndex([target("exact", 100)]);
    const geometry = { zoomScale: frameRate, maximumSnapDistancePixels: 0 } as const;

    expect(snapTimelineTime(index, { proposedTime: at(100), ...geometry }).matchedTarget?.id).toBe(
      "exact",
    );
    expect(snapTimelineTime(index, { proposedTime: at(99), ...geometry })).toEqual({
      correctedTime: at(99),
      matchedTarget: null,
    });
  });

  it.each([
    { zoomScale: createRationalRate(12, 1), expectedMatch: true },
    { zoomScale: createRationalRate(24, 1), expectedMatch: true },
    { zoomScale: createRationalRate(48, 1), expectedMatch: false },
  ])("applies one logical-pixel threshold at zoom $zoomScale", ({ zoomScale, expectedMatch }) => {
    const index = createTimelineSnapIndex([target("edge", 102, "clip-start", "clip-b")]);
    const result = snapTimelineTime(index, {
      proposedTime: at(100),
      zoomScale,
      maximumSnapDistancePixels: 2,
    });

    expect(result.matchedTarget?.id ?? null).toBe(expectedMatch ? "edge" : null);
    expect(result.correctedTime).toEqual(expectedMatch ? at(102) : at(100));
  });

  it("supports fractional zoom and exact inclusive threshold boundaries", () => {
    const ntscRate = createRationalRate(30_000, 1_001);
    const index = createTimelineSnapIndex([
      {
        id: "one-frame-away",
        kind: "playhead" as const,
        time: createRationalTime(1_001, ntscRate),
      },
    ]);

    const result = snapTimelineTime(index, {
      proposedTime: createRationalTime(1_000, ntscRate),
      zoomScale: ntscRate,
      maximumSnapDistancePixels: 1,
    });

    expect(result.correctedTime).toEqual(createRationalTime(1_001, ntscRate));
    expect(result.matchedTarget?.id).toBe("one-frame-away");
  });

  it("excludes the moving clip before choosing a match", () => {
    const index = createTimelineSnapIndex([
      target("self", 100, "clip-start", "clip-a"),
      target("other", 104, "clip-end", "clip-b"),
    ]);

    const result = snapTimelineTime(index, {
      proposedTime: at(101),
      movingClipId: "clip-a",
      zoomScale: createRationalRate(24, 1),
      maximumSnapDistancePixels: 5,
    });

    expect(result.correctedTime).toEqual(at(104));
    expect(result.matchedTarget?.id).toBe("other");
  });

  it("returns no match when every target belongs to the moving clip", () => {
    const index = createTimelineSnapIndex([
      target("self-start", 100, "clip-start", "clip-a"),
      target("self-end", 110, "clip-end", "clip-a"),
    ]);
    const result = snapTimelineTime(index, {
      proposedTime: at(105),
      movingClipId: "clip-a",
      zoomScale: frameRate,
      maximumSnapDistancePixels: 100,
    });

    expect(result).toEqual({ correctedTime: at(105), matchedTarget: null });
  });

  it.each([
    { maximumSnapDistancePixels: 0.49, expectedMatch: false },
    { maximumSnapDistancePixels: 0.5, expectedMatch: true },
    { maximumSnapDistancePixels: 0.51, expectedMatch: true },
  ])(
    "applies fractional threshold boundary $maximumSnapDistancePixels exactly",
    ({ maximumSnapDistancePixels, expectedMatch }) => {
      const index = createTimelineSnapIndex([target("edge", 101)]);
      const result = snapTimelineTime(index, {
        proposedTime: at(100),
        zoomScale: createRationalRate(12, 1),
        maximumSnapDistancePixels,
      });

      expect(result.matchedTarget?.id ?? null).toBe(expectedMatch ? "edge" : null);
    },
  );

  it("returns the proposed rational time and no target outside the threshold", () => {
    const index = createTimelineSnapIndex([target("distant", 120)]);
    const result = snapTimelineTime(index, {
      proposedTime: at(100),
      zoomScale: createRationalRate(24, 1),
      maximumSnapDistancePixels: 5,
    });

    expect(result).toEqual({ correctedTime: at(100), matchedTarget: null });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("keeps frame-distance arithmetic exact at the safe-integer boundary", () => {
    const lastSafeFrame = Number.MAX_SAFE_INTEGER;
    const index = createTimelineSnapIndex([target("last-safe-frame", lastSafeFrame)]);
    const result = snapTimelineTime(index, {
      proposedTime: at(lastSafeFrame - 1),
      zoomScale: frameRate,
      maximumSnapDistancePixels: 1,
    });

    expect(result.correctedTime).toEqual(at(lastSafeFrame));
    expect(result.matchedTarget?.id).toBe("last-safe-frame");
  });

  it("rejects mixed rates and invalid snap geometry", () => {
    expect(() =>
      createTimelineSnapIndex([
        target("at-24", 10),
        {
          id: "at-25",
          kind: "playhead" as const,
          time: createRationalTime(10, createRationalRate(25, 1)),
        },
      ]),
    ).toThrowError(VideoDomainError);

    const index = createTimelineSnapIndex([target("edge", 10)]);
    const otherRateTime = createRationalTime(9, createRationalRate(25, 1));
    expect(() =>
      snapTimelineTime(index, {
        proposedTime: otherRateTime,
        zoomScale: frameRate,
        maximumSnapDistancePixels: 1,
      }),
    ).toThrowError(VideoDomainError);

    for (const maximumSnapDistancePixels of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        snapTimelineTime(index, {
          proposedTime: at(9),
          zoomScale: frameRate,
          maximumSnapDistancePixels,
        }),
      ).toThrowError(VideoDomainError);
    }
  });
});
