import { describe, expect, it } from "vitest";

import { BEAT_LABEL_MAX_LENGTH, beatLabel } from "./narrative-beat.js";

describe("beatLabel", () => {
  it("keeps the first eight words of a short beat unchanged", () => {
    const label = beatLabel({ order: 2, text: "one two three four five six seven eight nine" });

    expect(label).toBe("Beat 3: one two three four five six seven eight");
  });

  it.each([
    ["one long unspaced word", "a".repeat(600)],
    ["long words joined by spaces", Array.from({ length: 8 }, () => "b".repeat(100)).join(" ")],
    ["unspaced Thai script", "สวัสดี".repeat(200)],
  ])("truncates %s with an ellipsis", (_name, text) => {
    const label = beatLabel({ order: 0, text });

    expect(label.length).toBeLessThanOrEqual(BEAT_LABEL_MAX_LENGTH);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("Beat 1: ")).toBe(true);
  });

  it("does not split a surrogate pair when truncating", () => {
    const label = beatLabel({ order: 0, text: "😀".repeat(400) });

    expect(label.length).toBeLessThanOrEqual(BEAT_LABEL_MAX_LENGTH);
    const body = label.slice(0, -1);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
