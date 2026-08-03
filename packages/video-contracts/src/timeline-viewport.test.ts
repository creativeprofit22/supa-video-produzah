import { describe, expect, it } from "vitest";

import { VideoDomainError } from "./errors.js";
import { createRationalRate, createRationalTime } from "./time.js";
import {
  createTimelineViewport,
  frameToPixel,
  intersectTimelineFrameRanges,
  pixelToFrame,
  pixelToTime,
  timelineFrameRangesIntersect,
  timeToPixel,
  validateTimelineFrameRange,
  type TimelineViewport,
  type TimelineViewportInput,
} from "./timeline-viewport.js";

const frameRate24 = createRationalRate(24, 1);

function viewportInput(overrides: Partial<TimelineViewportInput> = {}): TimelineViewportInput {
  return {
    frameRate: frameRate24,
    zoomScale: createRationalRate(24, 1),
    scrollOrigin: createRationalTime(0, frameRate24),
    viewportWidthPixels: 10,
    overscanPixels: 2,
    timelineRange: { start: 0, endExclusive: 100 },
    ...overrides,
  };
}

describe("timeline viewport conversions", () => {
  it("maps zero origins and derives immutable half-open ranges", () => {
    const viewport = createTimelineViewport(viewportInput());

    expect(timeToPixel(createRationalTime(0, frameRate24), viewport)).toBe(0);
    expect(frameToPixel(0, viewport)).toBe(0);
    expect(pixelToTime(0, viewport, "nearestTiesAwayFromZero")).toEqual(
      createRationalTime(0, frameRate24),
    );
    expect(viewport.visibleRange).toEqual({ start: 0, endExclusive: 10 });
    expect(viewport.overscanRange).toEqual({ start: 0, endExclusive: 12 });
    expect(Object.isFrozen(viewport)).toBe(true);
    expect(Object.isFrozen(viewport.visibleRange)).toBe(true);
  });

  it("supports signed frame positions and explicit negative rounding", () => {
    const viewport = createTimelineViewport(viewportInput());

    expect(frameToPixel(-1, viewport)).toBe(-1);
    expect(pixelToFrame(-0.5, viewport, "floor")).toBe(-1);
    expect(pixelToFrame(-0.5, viewport, "ceil")).toBe(0);
    expect(pixelToFrame(-0.5, viewport, "nearestTiesAwayFromZero")).toBe(-1);
    expect(pixelToFrame(-1.5, viewport, "nearestTiesAwayFromZero")).toBe(-2);
    expect(() => pixelToTime(-1, viewport, "floor")).toThrowError(VideoDomainError);
  });

  it("uses the exact scroll origin for time and frame projections", () => {
    const oneSecond = createRationalTime(24, frameRate24);
    const viewport = createTimelineViewport(viewportInput({ scrollOrigin: oneSecond }));

    expect(timeToPixel(oneSecond, viewport)).toBe(0);
    expect(timeToPixel(createRationalTime(2, createRationalRate(1, 1)), viewport)).toBe(24);
    expect(frameToPixel(23, viewport)).toBe(-1);
    expect(pixelToFrame(-1, viewport, "nearestTiesAwayFromZero")).toBe(23);
  });

  it.each([
    [30_000, 1_001, 50, 1],
    [30_000, 1_001, 125, 2],
    [60_000, 1_001, 125, 1],
  ] as const)(
    "round-trips fractional rate %i/%i at zoom %i/%i",
    (rateNumerator, rateDenominator, zoomNumerator, zoomDenominator) => {
      const frameRate = createRationalRate(rateNumerator, rateDenominator);
      const viewport = createTimelineViewport(
        viewportInput({
          frameRate,
          zoomScale: createRationalRate(zoomNumerator, zoomDenominator),
          scrollOrigin: createRationalTime(1_000, frameRate),
          timelineRange: { start: 0, endExclusive: 10_000 },
        }),
      );
      const pixel = frameToPixel(1_337, viewport);

      expect(pixelToFrame(pixel, viewport, "nearestTiesAwayFromZero")).toBe(1_337);
      expect(pixelToTime(pixel, viewport, "nearestTiesAwayFromZero")).toEqual(
        createRationalTime(1_337, frameRate),
      );
    },
  );

  it("documents exact boundaries, adjacent values, and half ties", () => {
    const viewport = createTimelineViewport(viewportInput());

    expect(pixelToFrame(1, viewport, "floor")).toBe(1);
    expect(pixelToFrame(1, viewport, "ceil")).toBe(1);
    expect(pixelToFrame(1, viewport, "nearestTiesAwayFromZero")).toBe(1);
    expect(pixelToFrame(1 - Number.EPSILON, viewport, "floor")).toBe(0);
    expect(pixelToFrame(1 - Number.EPSILON, viewport, "ceil")).toBe(1);
    expect(pixelToFrame(1 + Number.EPSILON, viewport, "floor")).toBe(1);
    expect(pixelToFrame(1 + Number.EPSILON, viewport, "ceil")).toBe(2);
    expect(pixelToFrame(1.5, viewport, "nearestTiesAwayFromZero")).toBe(2);
  });

  it("applies reverse rounding to the represented pixel boundary", () => {
    const onePerSecond = createRationalRate(1, 1);
    const viewport = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: createRationalRate(1, 3),
        scrollOrigin: createRationalTime(0, onePerSecond),
      }),
    );
    const representedPixel = frameToPixel(1, viewport);

    expect(representedPixel).toBe(0.3333333333333333);
    expect(timeToPixel(createRationalTime(1, onePerSecond), viewport)).toBe(representedPixel);
    expect(pixelToFrame(representedPixel, viewport, "floor")).toBe(0);
    expect(pixelToFrame(representedPixel, viewport, "ceil")).toBe(1);
    expect(pixelToFrame(representedPixel, viewport, "nearestTiesAwayFromZero")).toBe(1);
  });

  it("returns frame-rate RationalTime after reverse conversion", () => {
    const viewport = createTimelineViewport(
      viewportInput({ zoomScale: createRationalRate(48, 1) }),
    );

    expect(timeToPixel(createRationalTime(2, createRationalRate(1, 1)), viewport)).toBe(96);
    expect(pixelToTime(96, viewport, "nearestTiesAwayFromZero")).toEqual(
      createRationalTime(48, frameRate24),
    );
  });

  it.each([
    [1, 1],
    [5, 4],
    [3, 2],
    [2, 1],
  ] as const)("keeps logical results equivalent at DPI scale %i/%i", (numerator, denominator) => {
    const viewport = createTimelineViewport(
      viewportInput({
        zoomScale: createRationalRate(24 * numerator, denominator),
        viewportWidthPixels: (10 * numerator) / denominator,
        overscanPixels: (2 * numerator) / denominator,
      }),
    );
    const frameFivePixel = (5 * numerator) / denominator;

    expect(viewport.visibleRange).toEqual({ start: 0, endExclusive: 10 });
    expect(viewport.overscanRange).toEqual({ start: 0, endExclusive: 12 });
    expect(frameToPixel(5, viewport)).toBe(frameFivePixel);
    expect(pixelToFrame(frameFivePixel, viewport, "nearestTiesAwayFromZero")).toBe(5);
  });
});

describe("timeline viewport ranges", () => {
  it("includes every partially visible frame with floor/ceil boundaries", () => {
    const halfFrameOrigin = createRationalTime(1, createRationalRate(48, 1));
    const viewport = createTimelineViewport(
      viewportInput({
        scrollOrigin: halfFrameOrigin,
        viewportWidthPixels: 2,
        overscanPixels: 0,
      }),
    );

    expect(viewport.visibleRange).toEqual({ start: 0, endExclusive: 3 });
  });

  it("clamps viewports before, after, and inside timeline bounds", () => {
    const before = createTimelineViewport(
      viewportInput({
        timelineRange: { start: 10, endExclusive: 20 },
        viewportWidthPixels: 2,
        overscanPixels: 0,
      }),
    );
    const after = createTimelineViewport(
      viewportInput({
        scrollOrigin: createRationalTime(30, frameRate24),
        timelineRange: { start: 10, endExclusive: 20 },
        viewportWidthPixels: 2,
        overscanPixels: 0,
      }),
    );
    const empty = createTimelineViewport(
      viewportInput({ timelineRange: { start: 5, endExclusive: 5 } }),
    );

    expect(before.visibleRange).toEqual({ start: 10, endExclusive: 10 });
    expect(after.visibleRange).toEqual({ start: 20, endExclusive: 20 });
    expect(empty.visibleRange).toEqual({ start: 5, endExclusive: 5 });
  });

  it("caps overscan at one viewport per side and clamps it to timeline bounds", () => {
    const viewport = createTimelineViewport(
      viewportInput({
        scrollOrigin: createRationalTime(10, frameRate24),
        viewportWidthPixels: 4,
        overscanPixels: 10,
        timelineRange: { start: 8, endExclusive: 16 },
      }),
    );

    expect(viewport.effectiveOverscanPixels).toBe(4);
    expect(viewport.visibleRange).toEqual({ start: 10, endExclusive: 14 });
    expect(viewport.overscanRange).toEqual({ start: 8, endExclusive: 16 });
  });

  it("clamps exact derived endpoints before narrowing them to safe frame numbers", () => {
    const onePerSecond = createRationalRate(1, 1);
    const viewport = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: onePerSecond,
        scrollOrigin: createRationalTime(Number.MAX_SAFE_INTEGER, onePerSecond),
        viewportWidthPixels: 1,
        overscanPixels: 0,
        timelineRange: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER },
      }),
    );

    expect(viewport.visibleRange).toEqual({
      start: Number.MAX_SAFE_INTEGER,
      endExclusive: Number.MAX_SAFE_INTEGER,
    });
  });

  it("adds fractional overscan exactly at large safe widths", () => {
    const onePerSecond = createRationalRate(1, 1);
    const viewport = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: onePerSecond,
        scrollOrigin: createRationalTime(0, onePerSecond),
        viewportWidthPixels: Number.MAX_SAFE_INTEGER - 1,
        overscanPixels: 0.1,
        timelineRange: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER },
      }),
    );

    expect(viewport.overscanRange.endExclusive).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("uses normalized half-open intersection semantics", () => {
    const visible = { start: 10, endExclusive: 20 };

    expect(timelineFrameRangesIntersect(visible, { start: 12, endExclusive: 18 })).toBe(true);
    expect(timelineFrameRangesIntersect(visible, { start: 20, endExclusive: 30 })).toBe(false);
    expect(timelineFrameRangesIntersect(visible, { start: 5, endExclusive: 10 })).toBe(false);
    expect(timelineFrameRangesIntersect(visible, { start: 15, endExclusive: 15 })).toBe(false);
    expect(intersectTimelineFrameRanges(visible, { start: 15, endExclusive: 25 })).toEqual({
      start: 15,
      endExclusive: 20,
    });
    expect(intersectTimelineFrameRanges(visible, { start: 20, endExclusive: 25 })).toBeNull();
  });

  it("supports negative normalized timeline ranges", () => {
    expect(validateTimelineFrameRange({ start: -100, endExclusive: 0 })).toEqual({
      start: -100,
      endExclusive: 0,
    });
    expect(
      timelineFrameRangesIntersect({ start: -10, endExclusive: 2 }, { start: -2, endExclusive: 4 }),
    ).toBe(true);
  });
});

describe("timeline viewport validation", () => {
  it("handles very large safe values and rejects unsafe results", () => {
    const onePerSecond = createRationalRate(1, 1);
    const viewport = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: onePerSecond,
        scrollOrigin: createRationalTime(0, onePerSecond),
        viewportWidthPixels: 1,
        overscanPixels: 0,
        timelineRange: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER },
      }),
    );

    expect(frameToPixel(Number.MAX_SAFE_INTEGER, viewport)).toBe(Number.MAX_SAFE_INTEGER);
    expect(pixelToFrame(Number.MAX_SAFE_INTEGER, viewport, "nearestTiesAwayFromZero")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => frameToPixel(Number.MAX_SAFE_INTEGER + 1, viewport)).toThrowError(
      VideoDomainError,
    );

    const doubled = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: createRationalRate(2, 1),
        scrollOrigin: createRationalTime(0, onePerSecond),
      }),
    );
    expect(() => frameToPixel(Number.MAX_SAFE_INTEGER, doubled)).toThrowError(VideoDomainError);

    const lossyFractionalZoom = createTimelineViewport(
      viewportInput({
        frameRate: onePerSecond,
        zoomScale: createRationalRate(1, 3),
        scrollOrigin: createRationalTime(0, onePerSecond),
        timelineRange: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER },
      }),
    );
    expect(() => frameToPixel(Number.MAX_SAFE_INTEGER, lossyFractionalZoom)).toThrowError(
      VideoDomainError,
    );
  });

  it.each([
    { viewportWidthPixels: 0 },
    { viewportWidthPixels: -1 },
    { viewportWidthPixels: Number.NaN },
    { viewportWidthPixels: Number.POSITIVE_INFINITY },
    { overscanPixels: -1 },
    { overscanPixels: Number.NaN },
    { overscanPixels: Number.NEGATIVE_INFINITY },
    { timelineRange: { start: 2, endExclusive: 1 } },
    { timelineRange: { start: 0.5, endExclusive: 2 } },
    { timelineRange: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER + 1 } },
  ] as const)("rejects invalid viewport geometry %#", (override) => {
    expect(() => createTimelineViewport(viewportInput(override))).toThrowError(VideoDomainError);
  });

  it("rejects malformed rates, times, pixels, frames, and rounding modes", () => {
    expect(() =>
      createTimelineViewport(viewportInput({ zoomScale: { numerator: 48, denominator: 2 } })),
    ).toThrowError(VideoDomainError);
    expect(() =>
      createTimelineViewport(
        viewportInput({
          scrollOrigin: { value: -1, rateNumerator: 24, rateDenominator: 1 },
        }),
      ),
    ).toThrowError(VideoDomainError);

    const viewport = createTimelineViewport(viewportInput());
    expect(() => pixelToFrame(Number.NaN, viewport, "floor")).toThrowError(VideoDomainError);
    expect(() => pixelToFrame(Number.POSITIVE_INFINITY, viewport, "floor")).toThrowError(
      VideoDomainError,
    );
    expect(() => frameToPixel(0.5, viewport)).toThrowError(VideoDomainError);
    expect(() => pixelToFrame(0, viewport, "truncate" as "floor")).toThrowError(VideoDomainError);
    expect(() =>
      pixelToFrame(0, viewportInput() as unknown as TimelineViewport, "floor"),
    ).toThrowError(VideoDomainError);

    const tamperedViewport = {
      ...viewport,
      frameRate: { numerator: 1.5, denominator: 1 },
    } as TimelineViewport;
    expect(() => frameToPixel(1, tamperedViewport)).toThrowError(VideoDomainError);
  });

  it("keeps transient viewport state independent of persisted/editor concerns", () => {
    const viewport = createTimelineViewport(viewportInput());
    const keys = Object.keys(viewport);

    expect(new Set(keys)).toEqual(
      new Set([
        "frameRate",
        "zoomScale",
        "scrollOrigin",
        "viewportWidthPixels",
        "overscanPixels",
        "timelineRange",
        "effectiveOverscanPixels",
        "visibleRange",
        "overscanRange",
      ]),
    );
    expect(keys).not.toContain("selection");
    expect(keys).not.toContain("drag");
    expect(keys).not.toContain("command");
  });
});
