import { describe, expect, it } from "vitest";

import { seekMediaTime } from "./mediaSeek";

describe("media-boundary seek quantization", () => {
  it.each([
    [30 * 1001 / 30000, 1.001001, 30],
    [1001 / 30000, 0.033368, 1],
  ])("seeks inside fractional-rate boundary %s without changing canonical input", (seconds, expected, frame) => {
    const canonical = Object.freeze({ frame, rate: Object.freeze({ numerator: 30000, denominator: 1001 }), seconds });
    const video = { currentTime: 0, duration: 10 };
    seekMediaTime(video, canonical.seconds);
    expect(video.currentTime).toBe(expected);
    // Model the runtime's truncation to integer microseconds, then decoded frame selection.
    const runtimeTime = Math.floor(video.currentTime * 1_000_000) / 1_000_000;
    expect(Math.floor(runtimeTime * 30000 / 1001)).toBe(frame);
    expect(canonical.seconds).toBe(frame * canonical.rate.denominator / canonical.rate.numerator);
    expect(canonical.frame).toBe(frame);
    expect(canonical.rate).toEqual({ numerator: 30000, denominator: 1001 });
  });

  it("clamps endpoints and permits seeking before duration metadata is available", () => {
    const video = { currentTime: 5, duration: 2 };
    seekMediaTime(video, -1);
    expect(video.currentTime).toBe(0);
    seekMediaTime(video, 0);
    expect(video.currentTime).toBe(0);
    seekMediaTime(video, 1.9999999);
    expect(video.currentTime).toBe(2);
    seekMediaTime(video, 3);
    expect(video.currentTime).toBe(2);
    video.duration = NaN;
    seekMediaTime(video, 1.001);
    expect(video.currentTime).toBe(1.001001);
  });
});
