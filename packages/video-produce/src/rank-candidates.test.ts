import type { AcquisitionReceipt, UsePolicyProfile, VideoAsset } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { buildAssetIndex } from "./asset-index.js";
import type { NarrativeBeat } from "./narrative-beat.js";
import { planBeatsFromScript } from "./plan-beats.js";
import { type PriorSelection, rankCandidatesForBeat } from "./rank-candidates.js";
import { DEFAULT_RANKING_CONFIG } from "./ranking-config.js";
import { filterByRights } from "./rights-filter.js";
import { TEST_DAY_MS, TEST_NOW_MS, testAsset, testReceipt, testUuid } from "./test-support.js";

const OWNED = testUuid(0x30, 1);
const ACQUIRED = testUuid(0x30, 2);
const RECEIPT = testUuid(0x40, 2);
const DIGEST = "ab".repeat(32);

function beat(script: string, language = "en"): NarrativeBeat {
  const result = planBeatsFromScript(script, { language });
  if (!result.ok || result.value[0] === undefined) throw new Error("beat");
  return result.value[0];
}

function rank(
  assets: readonly VideoAsset[],
  receipts: readonly AcquisitionReceipt[],
  target: NarrativeBeat,
  options: { intendedUse?: UsePolicyProfile; prior?: readonly PriorSelection[] } = {},
) {
  const index = buildAssetIndex({ assets, receipts });
  const decisions = filterByRights({
    entries: index.entries,
    receipts,
    intendedUse: options.intendedUse ?? "commercial-online",
    nowMs: TEST_NOW_MS,
  });
  return rankCandidatesForBeat({
    beat: target,
    entries: index.entries,
    rights: new Map(decisions.map((decision) => [decision.assetId, decision])),
    config: DEFAULT_RANKING_CONFIG,
    prior: options.prior ?? [],
    beatVector: null,
    minRelevance: DEFAULT_RANKING_CONFIG.minRelevance,
  });
}

describe("rights hard filter", () => {
  const acquired = testAsset({
    id: ACQUIRED,
    name: "river canyon.webm",
    digest: DIGEST,
    receiptId: RECEIPT,
  });

  it.each([
    ["unknown license", { license: "unknown" as const }, "commercial-online", "use-blocked"],
    [
      "unknown license in private preview",
      { license: "unknown" as const },
      "private-preview",
      "license-unknown",
    ],
    [
      "non-commercial under a commercial profile",
      { license: "by-nc" as const },
      "commercial-online",
      "use-blocked",
    ],
    [
      "withdrawn upstream",
      { status: "withdrawn" as const },
      "commercial-online",
      "upstream-withdrawn",
    ],
    ["changed upstream", { status: "changed" as const }, "commercial-online", "upstream-changed"],
    ["stale evidence", { refreshedAgoMs: 60 * TEST_DAY_MS }, "commercial-online", "refresh-stale"],
    [
      "receipt for other bytes",
      { digest: "cd".repeat(32) },
      "commercial-online",
      "receipt-mismatch",
    ],
  ] as const)("rejects %s", (_name, overrides, intendedUse, reason) => {
    const receipt = testReceipt({ receiptId: RECEIPT, digest: DIGEST, ...overrides });
    const result = rank([acquired], [receipt], beat("The river canyon."), { intendedUse });
    expect(result.ranked).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        assetId: ACQUIRED,
        reason: "rights",
        detail: expect.stringContaining(reason),
      }),
    ]);
  });

  it("rejects an acquired asset whose receipt is missing", () => {
    const result = rank([acquired], [], beat("The river canyon."));
    expect(result.rejected[0]?.detail).toContain("receipt-missing");
  });

  it("accepts an allowed receipt with lower confidence than owned media", () => {
    const owned = testAsset({ id: OWNED, name: "river canyon.mp4" });
    const receipt = testReceipt({ receiptId: RECEIPT, digest: DIGEST, license: "cc0" });
    const result = rank([owned, acquired], [receipt], beat("The river canyon."));
    expect(result.ranked.map((item) => item.candidate.assetId)).toEqual([OWNED, ACQUIRED]);
    expect(result.ranked[1]?.score.components.rightsConfidence).toBe(0.8);
    expect(result.ranked[1]?.score.explanation).toContain(
      `Acquired media, receipt ${RECEIPT}; policy allow.`,
    );
  });
});

describe("constraints", () => {
  const kayak = testAsset({ id: testUuid(0x31, 1), name: "kayak river.mp4" });
  const crowd = testAsset({ id: testUuid(0x31, 2), name: "river crowd.mp4" });
  const plain = testAsset({ id: testUuid(0x31, 3), name: "river bank.mp4" });

  it("keeps only candidates that show every must-show term", () => {
    const result = rank([kayak, crowd, plain], [], beat("A calm river. [show: kayak]"));
    expect(result.ranked.map((item) => item.candidate.assetId)).toEqual([kayak.id]);
    expect(result.rejected.filter((item) => item.reason === "must-show-missing")).toHaveLength(2);
  });

  it("rejects candidates that show a must-not-show term, including translations", () => {
    const result = rank(
      [kayak, crowd, plain],
      [],
      beat("Ein ruhiger Fluss. [avoid: Menschenmenge, Menge]", "de"),
    );
    expect(result.ranked.map((item) => item.candidate.assetId)).not.toContain(crowd.id);
    expect(result.rejected.find((item) => item.assetId === crowd.id)?.reason).toBe("must-not-show");
  });

  it("penalizes orientation mismatch and explains it", () => {
    const portrait = testAsset({
      id: testUuid(0x31, 4),
      name: "river bank tall.mp4",
      width: 1080,
      height: 1920,
    });
    const result = rank([plain, portrait], [], beat("A river bank. [portrait]"));
    expect(result.ranked[0]?.candidate.assetId).toBe(portrait.id);
    const landscape = result.ranked.find((item) => item.candidate.assetId === plain.id);
    expect(landscape?.score.components.orientation).toBe(0);
    expect(landscape?.score.explanation.join(" ")).toContain("Orientation mismatch");
  });

  it("rejects irrelevant and too-short media", () => {
    const desert = testAsset({ id: testUuid(0x31, 5), name: "desert.mp4" });
    const short = testAsset({
      id: testUuid(0x31, 6),
      name: "river short.mp4",
      durationUs: 500_000,
    });
    const result = rank([desert, short], [], beat("A long river journey through many valleys."));
    expect(result.rejected.map((item) => [item.assetId, item.reason])).toEqual([
      [desert.id, "low-relevance"],
      [short.id, "too-short"],
    ]);
  });

  it("matches Spanish beats to English file names and diacritic names", () => {
    const bridge = testAsset({ id: testUuid(0x31, 7), name: "Brücke über den Fluss.mov" });
    const result = rank([plain, bridge], [], beat("El puente sobre el río.", "es"));
    expect(result.ranked[0]?.candidate.assetId).toBe(bridge.id);
    expect(result.ranked[0]?.score.explanation[0]).toBe("Name/tags match: bridge, river.");
  });
});

describe("repetition and duplicates", () => {
  const river = testAsset({
    id: testUuid(0x32, 1),
    name: "river.mp4",
    digest: "11".repeat(32),
    durationUs: 8_000_000,
  });
  const duplicate = testAsset({
    id: testUuid(0x32, 2),
    name: "river copy.mp4",
    digest: "11".repeat(32),
    durationUs: 8_000_000,
  });
  const use = (sourceInUs: number, sourceOutUs: number): PriorSelection => ({
    identityKey: `sha256:${"11".repeat(32)}`,
    providerId: "local",
    visualClusterId: null,
    sourceInUs,
    sourceOutUs,
  });

  it("moves reused media to a fresh window and applies a repetition penalty", () => {
    const result = rank([river], [], beat("The river."), { prior: [use(0, 1_500_000)] });
    expect(result.ranked[0]?.candidate.sourceInUs).toBe(1_500_000);
    expect(result.ranked[0]?.score.repetitionPenalty).toBe(0.15);
  });

  it("treats duplicate imports of the same bytes as the same media for reuse limits", () => {
    const result = rank([river, duplicate], [], beat("The river."), {
      prior: [use(0, 1_500_000), use(1_500_000, 3_000_000)],
    });
    expect(result.ranked).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["reuse-limit", "reuse-limit"]);
  });

  it("rejects near-duplicates when no fresh window exists", () => {
    const tiny = testAsset({
      id: testUuid(0x32, 3),
      name: "river tiny.mp4",
      digest: "22".repeat(32),
      durationUs: 2_000_000,
    });
    const result = rank([tiny], [], beat("The river."), {
      prior: [{ ...use(0, 1_500_000), identityKey: `sha256:${"22".repeat(32)}` }],
    });
    expect(result.rejected[0]?.reason).toBe("near-duplicate");
  });

  it("orders ties by asset id then source in", () => {
    const a = testAsset({ id: testUuid(0x33, 2), name: "river.mp4" });
    const b = testAsset({ id: testUuid(0x33, 1), name: "river.mp4" });
    const result = rank([a, b], [], beat("The river."));
    expect(result.ranked.map((item) => item.candidate.assetId)).toEqual([b.id, a.id]);
  });
});

describe("diversity", () => {
  it.each([
    ["provider", { providerId: "wikimedia-commons", visualClusterId: null }],
    ["visual cluster", { providerId: "local", visualClusterId: "cluster-water" }],
  ] as const)("prefers a different %s than the recent shots", (_name, recentShot) => {
    const digestA = "a1".repeat(32);
    const digestB = "b1".repeat(32);
    const receiptA = testUuid(0x41, 1);
    const repeated = testAsset({
      id: testUuid(0x34, 1),
      name: "river.webm",
      digest: digestA,
      receiptId: receiptA,
    });
    const fresh = testAsset({ id: testUuid(0x34, 2), name: "river.mp4", digest: digestB });
    const receipts = [testReceipt({ receiptId: receiptA, digest: digestA })];
    const index = buildAssetIndex({
      assets: [repeated, fresh],
      receipts,
      embeddings: {
        modelId: "fixture",
        modelVersion: "1",
        vectorForContent: () => null,
        vectorForText: () => null,
        clusterForContent: () => "cluster-water",
      },
    });
    const decisions = filterByRights({
      entries: index.entries,
      receipts,
      intendedUse: "commercial-online",
      nowMs: TEST_NOW_MS,
    });
    const result = rankCandidatesForBeat({
      beat: beat("The river."),
      entries: index.entries,
      rights: new Map(decisions.map((decision) => [decision.assetId, decision])),
      config: DEFAULT_RANKING_CONFIG,
      prior: [
        { identityKey: "sha256:" + "ff".repeat(32), sourceInUs: 0, sourceOutUs: 1, ...recentShot },
      ],
      beatVector: null,
      minRelevance: DEFAULT_RANKING_CONFIG.minRelevance,
    });
    const scores = new Map(result.ranked.map((item) => [item.candidate.assetId, item.score]));
    expect(scores.get(repeated.id)?.components.diversity).toBeLessThan(1);
    expect(scores.get(repeated.id)?.explanation.join(" ")).toMatch(
      /Same provider|Visually similar/,
    );
  });
});
