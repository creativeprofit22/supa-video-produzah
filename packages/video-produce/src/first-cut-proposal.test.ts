import type { AcquisitionReceipt, VideoAsset } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { buildAssetIndex } from "./asset-index.js";
import { canonicalJson } from "./canonical.js";
import { type FirstCutProposal, planFirstCut, proposalDurationUs } from "./first-cut-proposal.js";
import type { NarrativeBeat } from "./narrative-beat.js";
import { planBeatsFromScript, planBeatsFromTranscript } from "./plan-beats.js";
import { DEFAULT_RANKING_CONFIG, type RankingConfigV1 } from "./ranking-config.js";
import { TEST_NOW_MS, TEST_PROJECT_ID, testAsset, testReceipt, testUuid } from "./test-support.js";

const SCRIPT = [
  "# Rivers of the West",
  "The river cuts through the canyon.",
  "Kayakers ride the rapids. [show: kayak]",
  "A bridge crosses the river at dusk.",
  "Map: Colorado basin",
  "Snow feeds every stream in spring. [show: snow]",
].join("\n");

function scriptBeats(): NarrativeBeat[] {
  const result = planBeatsFromScript(SCRIPT, { language: "en" });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

interface Scenario {
  readonly assets: VideoAsset[];
  readonly receipts: AcquisitionReceipt[];
}

function scenario(): Scenario {
  const acquiredDigest = "aa".repeat(32);
  const unknownDigest = "bb".repeat(32);
  return {
    assets: [
      testAsset({ id: testUuid(0x50, 1), name: "river canyon.mp4" }),
      testAsset({ id: testUuid(0x50, 2), name: "kayak rapids.mp4" }),
      testAsset({ id: testUuid(0x50, 3), name: "river bridge dusk.mp4", digest: "cc".repeat(32) }),
      testAsset({
        id: testUuid(0x50, 4),
        name: "river bridge dusk copy.mp4",
        digest: "cc".repeat(32),
      }),
      testAsset({
        id: testUuid(0x50, 5),
        name: "snow river spring.webm",
        digest: unknownDigest,
        receiptId: testUuid(0x60, 5),
      }),
      testAsset({
        id: testUuid(0x50, 6),
        name: "canyon river aerial.webm",
        digest: acquiredDigest,
        receiptId: testUuid(0x60, 6),
      }),
    ],
    receipts: [
      testReceipt({ receiptId: testUuid(0x60, 5), digest: unknownDigest, license: "unknown" }),
      testReceipt({ receiptId: testUuid(0x60, 6), digest: acquiredDigest, license: "cc0" }),
    ],
  };
}

async function plan(
  input: Scenario,
  config: RankingConfigV1 = DEFAULT_RANKING_CONFIG,
  beats: readonly NarrativeBeat[] = scriptBeats(),
): Promise<FirstCutProposal> {
  const result = await planFirstCut({
    projectId: TEST_PROJECT_ID,
    projectRevision: 4,
    workflow: "explainer",
    beats,
    index: buildAssetIndex({ assets: input.assets, receipts: input.receipts }),
    receipts: input.receipts,
    intendedUse: "private-preview",
    nowMs: TEST_NOW_MS,
    config,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function offered(proposal: FirstCutProposal): string[] {
  return proposal.beats.flatMap((item) => [
    ...(item.coverage.kind === "footage" ? [item.coverage.selected.candidate.assetId] : []),
    ...item.alternatives.map((alternative) => alternative.candidate.assetId),
  ]);
}

describe("planFirstCut", () => {
  it("covers or explicitly leaves unresolved every beat, spanning the script plan", async () => {
    const proposal = await plan(scenario());
    expect(
      proposal.beats.map((item) => [item.beat.intent.kind, item.status, item.coverage.kind]),
    ).toEqual([
      ["title", "covered", "graphic"],
      ["owned-footage", "covered", "footage"],
      ["owned-footage", "covered", "footage"],
      ["owned-footage", "covered", "footage"],
      ["map", "unresolved", "unresolved"],
      ["owned-footage", "unresolved", "unresolved"],
    ]);
    const beats = scriptBeats();
    expect(proposalDurationUs(proposal)).toBe(
      (beats.at(-1)?.endUs ?? 0) - (beats[0]?.startUs ?? 0),
    );
    expect(proposal.endUs - proposal.startUs).toBe(proposalDurationUs(proposal));
  });

  it("never offers unknown-license media, even for a private preview, and audits why", async () => {
    const proposal = await plan(scenario());
    expect(offered(proposal)).not.toContain(testUuid(0x50, 5));
    const snow = proposal.beats[5];
    expect(snow?.unresolvedReason).toBe("No rights-safe media shows: snow.");
    expect(snow?.rejected.find((item) => item.assetId === testUuid(0x50, 5))).toMatchObject({
      reason: "rights",
      detail: expect.stringContaining("license-unknown"),
    });
    expect(snow?.acquisitionSuggestion?.query).toContain("snow");
  });

  it("keeps must-show beats unresolved rather than dropping the term", async () => {
    const input = scenario();
    const withoutKayak = {
      ...input,
      assets: input.assets.filter((asset) => asset.id !== testUuid(0x50, 2)),
    };
    const proposal = await plan(withoutKayak);
    expect(proposal.beats[2]).toMatchObject({
      status: "unresolved",
      unresolvedReason: "No rights-safe media shows: kayak.",
    });
  });

  it("prefers owned media, explains every offer and offers duplicate imports only once", async () => {
    const proposal = await plan(scenario());
    const river = proposal.beats[1];
    if (river?.coverage.kind !== "footage") throw new Error("expected footage");
    expect(river.coverage.selected.candidate.provenance).toBe("owned");
    expect(river.alternatives.map((item) => item.candidate.provenance)).toContain("acquired");
    for (const item of proposal.beats) {
      const candidates = [
        ...(item.coverage.kind === "footage" ? [item.coverage.selected] : []),
        ...item.alternatives,
      ];
      for (const candidate of candidates)
        expect(candidate.score.explanation.length).toBeGreaterThan(0);
    }
    const bridge = proposal.beats[3];
    if (bridge?.coverage.kind !== "footage") throw new Error("expected footage");
    const duplicateOffers = [bridge.coverage.selected, ...bridge.alternatives].filter(
      (item) => item.candidate.identityKey === `sha256:${"cc".repeat(32)}`,
    );
    expect(duplicateOffers).toHaveLength(1);
  });

  it("is deterministic across runs and asset order, and versioned by config", async () => {
    const input = scenario();
    const first = await plan(input);
    const second = await plan(input);
    const shuffled = await plan({
      assets: [...input.assets].reverse(),
      receipts: [...input.receipts].reverse(),
    });
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(first));
    expect(first.proposalId).toMatch(/^first-cut-[0-9a-f]{64}$/);
    const bumped = await plan(input, { ...DEFAULT_RANKING_CONFIG, version: "ranking/test" });
    expect(bumped.proposalId).not.toBe(first.proposalId);
  });

  it("applies reuse limits across beats", async () => {
    const one = testAsset({ id: testUuid(0x51, 1), name: "river.mp4", durationUs: 60_000_000 });
    const beats = planBeatsFromScript("The river. The river again. The river once more.", {
      language: "en",
    });
    if (!beats.ok) throw new Error("beats");
    const proposal = await plan(
      { assets: [one], receipts: [] },
      { ...DEFAULT_RANKING_CONFIG, maxReusePerAsset: 2 },
      beats.value,
    );
    expect(proposal.beats.map((item) => item.status)).toEqual(["covered", "covered", "unresolved"]);
    expect(proposal.beats[2]?.rejected[0]?.reason).toBe("reuse-limit");
    const windows = proposal.beats
      .slice(0, 2)
      .map((item) =>
        item.coverage.kind === "footage" ? item.coverage.selected.candidate.sourceInUs : -1,
      );
    expect(windows).toEqual([0, 1_500_000]);
  });

  it("rejects non-contiguous beats", async () => {
    const beats = scriptBeats();
    const broken = beats.map((beat, index) =>
      index === 2 ? { ...beat, startUs: beat.startUs + 1 } : beat,
    );
    const result = await planFirstCut({
      projectId: TEST_PROJECT_ID,
      projectRevision: 1,
      workflow: "explainer",
      beats: broken,
      index: buildAssetIndex({ assets: [], receipts: [] }),
      receipts: [],
      intendedUse: "private-preview",
      nowMs: TEST_NOW_MS,
      config: DEFAULT_RANKING_CONFIG,
    });
    expect(result.ok ? null : result.error).toEqual({ code: "beats-not-contiguous", order: 2 });
  });
});

describe("podcast workflow", () => {
  it("keeps the A-roll unless a strongly relevant cutaway exists", async () => {
    const aRoll = testAsset({
      id: testUuid(0x52, 1),
      name: "episode 12 studio.mp4",
      durationUs: 30_000_000,
    });
    const bridge = testAsset({ id: testUuid(0x52, 2), name: "Golden Gate bridge fog.mp4" });
    const words = [
      ["Welcome", 0, 400_000],
      ["back.", 400_000, 900_000],
      ["The", 2_000_000, 2_200_000],
      ["bridge", 2_200_000, 2_700_000],
      ["disappeared", 2_700_000, 3_200_000],
      ["in", 3_200_000, 3_300_000],
      ["fog.", 3_300_000, 3_900_000],
    ] as const;
    const beats = planBeatsFromTranscript(
      words.map(([text, sourceStartUs, sourceEndUs]) => ({ text, sourceStartUs, sourceEndUs })),
      {
        assetId: aRoll.id,
        clipId: testUuid(0x52, 9),
        timelineStartUs: 0,
        sourceInUs: 0,
        sourceOutUs: 6_000_000,
      },
      { language: "en" },
    );
    if (!beats.ok) throw new Error(beats.error.code);
    const result = await planFirstCut({
      projectId: TEST_PROJECT_ID,
      projectRevision: 2,
      workflow: "podcast",
      beats: beats.value,
      index: buildAssetIndex({ assets: [aRoll, bridge], receipts: [] }),
      receipts: [],
      intendedUse: "commercial-online",
      nowMs: TEST_NOW_MS,
      config: DEFAULT_RANKING_CONFIG,
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.beats.map((item) => item.coverage.kind)).toEqual(["a-roll", "footage"]);
    expect(result.value.beats[0]?.rejected.find((item) => item.assetId === aRoll.id)?.reason).toBe(
      "a-roll-source",
    );
  });
});
