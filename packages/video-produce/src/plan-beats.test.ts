import { describe, expect, it } from "vitest";

import {
  GRAPHIC_BEAT_US,
  MIN_NARRATION_BEAT_US,
  planBeatsFromScript,
  planBeatsFromTranscript,
} from "./plan-beats.js";

const clip = {
  assetId: "20000000-0000-4000-8000-000000000001",
  clipId: "20000000-0000-4000-8000-000000000002",
  timelineStartUs: 2_000_000,
  sourceInUs: 1_000_000,
  sourceOutUs: 9_000_000,
};

function word(text: string, startUs: number, endUs: number) {
  return { text, sourceStartUs: startUs, sourceEndUs: endUs };
}

describe("planBeatsFromScript", () => {
  it("creates contiguous beats timed by words per minute", () => {
    const result = planBeatsFromScript(
      "Rivers carve canyons over millions of years. Water always wins.",
      {
        language: "en",
        wordsPerMinute: 120,
      },
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map((beat) => [beat.startUs, beat.endUs])).toEqual([
      [0, 3_500_000],
      [3_500_000, 5_000_000],
    ]);
    expect(result.value[1]?.endUs).toBe(5_000_000);
    expect(new Set(result.value.map((beat) => beat.id)).size).toBe(2);
  });

  it.each([
    ["# The water cycle", "title", GRAPHIC_BEAT_US],
    ["Lower third: Dr. Ana Ruiz", "lower-third", GRAPHIC_BEAT_US],
    ["Map: Colorado river basin", "map", GRAPHIC_BEAT_US],
    ["Chart: flow by month", "chart", GRAPHIC_BEAT_US],
    ["Screenshot: gauge website", "screenshot", GRAPHIC_BEAT_US],
    ["Still: old survey photo", "still-motion", GRAPHIC_BEAT_US],
  ])("parses directive %s", (line, kind, duration) => {
    const result = planBeatsFromScript(line, { language: "en" });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value[0]?.intent.kind).toBe(kind);
    expect(result.value[0]?.endUs).toBe(duration);
  });

  it("parses inline must-show, avoid and orientation tags", () => {
    const result = planBeatsFromScript(
      "Kayakers race downstream. [show: kayak] [avoid: crowd] [portrait]",
      {
        language: "en",
      },
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value[0]).toMatchObject({
      text: "Kayakers race downstream.",
      mustShow: ["kayak"],
      mustNotShow: ["crowd"],
      orientation: "portrait",
      intent: { kind: "owned-footage" },
    });
    expect(result.value[0]?.endUs).toBe(MIN_NARRATION_BEAT_US);
  });

  it("is deterministic for the same script", () => {
    const first = planBeatsFromScript("Un río. Otro río.", { language: "es" });
    const second = planBeatsFromScript("Un río. Otro río.", { language: "es" });
    expect(first).toEqual(second);
  });

  it.each([
    ["   \n  ", { language: "en" }, "empty-script"],
    ["Words.", { language: "en", wordsPerMinute: 5 }, "invalid-words-per-minute"],
  ] as const)("rejects %j", (script, options, code) => {
    const result = planBeatsFromScript(script, options);
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});

describe("planBeatsFromTranscript", () => {
  it("groups sentences by punctuation and pauses and spans the clip exactly", () => {
    const result = planBeatsFromTranscript(
      [
        word("Welcome", 1_200_000, 1_600_000),
        word("back.", 1_600_000, 2_000_000),
        word("Today", 2_300_000, 2_600_000),
        word("rivers", 2_600_000, 3_000_000),
        word("and", 4_500_000, 4_700_000),
        word("canyons.", 4_700_000, 5_200_000),
        word("outside", 9_500_000, 9_900_000),
      ],
      clip,
      { language: "en" },
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map((beat) => [beat.text, beat.startUs, beat.endUs])).toEqual([
      ["Welcome back.", 2_000_000, 3_300_000],
      ["Today rivers", 3_300_000, 5_500_000],
      ["and canyons.", 5_500_000, 10_000_000],
    ]);
    expect(result.value.every((beat) => beat.intent.kind === "a-roll")).toBe(true);
  });

  it("rejects ranges without words", () => {
    const result = planBeatsFromTranscript([word("late", 9_500_000, 9_800_000)], clip, {
      language: "en",
    });
    expect(result.ok ? null : result.error.code).toBe("empty-transcript-range");
  });
});
