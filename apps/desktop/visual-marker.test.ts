import { describe, expect, test } from "vitest";

import { findVisualMarker } from "./browser-tests/visual-marker";

describe("parity visual-marker measurement", () => {
  test("uses the first directly observed exact marker without changing its timestamp", () => {
    const target = { id: 42, display: 1123.9, media: 1.4014 };
    const frames = [
      { id: 41, display: 1098.9, media: 1.368033 },
      target,
      { id: 42, display: 1140.5, media: 1.4014 },
      { id: 43, display: 1148.9, media: 1.434767 },
    ];

    expect(findVisualMarker(frames, 42)).toBe(target);
    expect(findVisualMarker(frames, 42)?.display).toBe(1123.9);
  });

  test("rejects a skipped marker rather than substituting or extrapolating", () => {
    // Retained 30000/1001 fps, 150% Preview crossing: frame 42 was not observed.
    const frames = [
      { id: 41, display: 1098.9, media: 1.368033 },
      { id: 43, display: 1148.9, media: 1.434767 },
    ];

    expect(findVisualMarker(frames, 42)).toBeNull();
  });

  test("rejects an absent marker, including an empty observation list", () => {
    expect(findVisualMarker([{ id: 41, display: 1098.9 }], 42)).toBeNull();
    expect(findVisualMarker([], 42)).toBeNull();
  });
});
