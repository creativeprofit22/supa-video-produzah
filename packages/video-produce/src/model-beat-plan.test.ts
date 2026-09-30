import { describe, expect, it } from "vitest";

import { buildAssetIndex } from "./asset-index.js";
import { planFirstCut } from "./first-cut-proposal.js";
import { acceptModelBeatPlan } from "./model-beat-plan.js";
import { DEFAULT_RANKING_CONFIG } from "./ranking-config.js";
import { TEST_NOW_MS, TEST_PROJECT_ID, testAsset, testUuid } from "./test-support.js";

describe("acceptModelBeatPlan", () => {
  it.each([
    ["not an object", "nope"],
    ["unknown keys", { schemaVersion: 1, language: "en", beats: [], extra: true }],
    ["empty beats", { schemaVersion: 1, language: "en", beats: [] }],
    [
      "a-roll intent",
      {
        schemaVersion: 1,
        language: "en",
        beats: [
          {
            text: "x",
            startUs: 0,
            endUs: 1,
            intent: {
              kind: "a-roll",
              assetId: "20000000-0000-4000-8000-000000000001",
              clipId: "20000000-0000-4000-8000-000000000002",
            },
          },
        ],
      },
    ],
    [
      "fractional timestamps",
      { schemaVersion: 1, language: "en", beats: [{ text: "x", startUs: 0.5, endUs: 1 }] },
    ],
  ])("rejects %s", (_name, input) => {
    const result = acceptModelBeatPlan(input, 10_000_000);
    expect(result.ok ? null : result.error.code).toBe("invalid-shape");
  });

  it("clamps, trims overlaps, drops empty spans, fills gaps and reports each repair", () => {
    const result = acceptModelBeatPlan(
      {
        schemaVersion: 1,
        language: "de",
        beats: [
          { text: "Anfang", startUs: -500, endUs: 4_000_000 },
          { text: "Überlappung", startUs: 3_000_000, endUs: 6_000_000, mustShow: ["Fluss"] },
          { text: "Leer", startUs: 5_000_000, endUs: 5_500_000 },
          { text: "Ende", startUs: 8_000_000, endUs: 99_000_000 },
        ],
      },
      10_000_000,
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.beats.map((beat) => [beat.text, beat.startUs, beat.endUs])).toEqual([
      ["Anfang", 0, 4_000_000],
      ["Überlappung", 4_000_000, 8_000_000],
      ["Ende", 8_000_000, 10_000_000],
    ]);
    expect(result.value.repairs).toEqual([
      { index: 0, kind: "clamped-start", fromUs: -500 },
      { index: 1, kind: "trimmed-overlap", fromUs: 3_000_000 },
      { index: 2, kind: "trimmed-overlap", fromUs: 5_000_000 },
      { index: 2, kind: "dropped-empty" },
      { index: 3, kind: "clamped-end", fromUs: 99_000_000 },
      { index: 1, kind: "filled-gap", fromUs: 6_000_000, toUs: 8_000_000 },
    ]);
    expect(result.value.beats.map((beat) => beat.order)).toEqual([0, 1, 2]);
  });

  it("fills a leading gap into the first beat and a trailing gap into the last", () => {
    const result = acceptModelBeatPlan(
      {
        schemaVersion: 1,
        language: "en",
        beats: [
          { text: "second", startUs: 5_000_000, endUs: 7_000_000 },
          { text: "first", startUs: 2_000_000, endUs: 4_000_000 },
        ],
      },
      10_000_000,
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.beats.map((beat) => [beat.text, beat.startUs, beat.endUs])).toEqual([
      ["first", 0, 5_000_000],
      ["second", 5_000_000, 10_000_000],
    ]);
    expect(result.value.repairs).toEqual([
      { index: 1, kind: "filled-gap", fromUs: 2_000_000, toUs: 0 },
      { index: 1, kind: "filled-gap", fromUs: 4_000_000, toUs: 5_000_000 },
      { index: 0, kind: "filled-gap", fromUs: 7_000_000, toUs: 10_000_000 },
    ]);
  });

  it("produces beats that planFirstCut accepts", async () => {
    const accepted = acceptModelBeatPlan(
      {
        schemaVersion: 1,
        language: "en",
        beats: [
          { text: "The river cuts the canyon.", startUs: 1_000_000, endUs: 3_000_000 },
          { text: "A kayak on the river.", startUs: 4_000_000, endUs: 6_000_000 },
        ],
      },
      8_000_000,
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    const assets = [
      testAsset({ id: testUuid(0x72, 1), name: "river canyon.mp4", durationUs: 6_000_000 }),
      testAsset({ id: testUuid(0x72, 2), name: "kayak river.mp4", durationUs: 6_000_000 }),
    ];
    const planned = await planFirstCut({
      projectId: TEST_PROJECT_ID,
      projectRevision: 1,
      workflow: "explainer",
      beats: accepted.value.beats,
      index: buildAssetIndex({ assets, receipts: [] }),
      receipts: [],
      intendedUse: "private-preview",
      nowMs: TEST_NOW_MS,
      config: DEFAULT_RANKING_CONFIG,
    });
    expect(planned.ok).toBe(true);
  });

  it("fails when every beat falls outside the plan", () => {
    const result = acceptModelBeatPlan(
      { schemaVersion: 1, language: "en", beats: [{ text: "late", startUs: 20, endUs: 30 }] },
      10,
    );
    expect(result.ok ? null : result.error.code).toBe("no-usable-beats");
  });
});
