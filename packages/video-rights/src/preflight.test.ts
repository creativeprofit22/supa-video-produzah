import type { AcquisitionReceipt } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FRESHNESS_MS,
  gateReasonFromRenderCategory,
  rightsPreflight,
  type PreflightAsset,
} from "./preflight.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const digest = "ab".repeat(32);
const receiptId = "00000000-0000-4000-8000-00000000a001";

function receipt(overrides: Partial<AcquisitionReceipt> = {}): AcquisitionReceipt {
  return {
    schemaVersion: 1,
    receiptId,
    providerId: "wikimedia-commons",
    providerItemId: "File:Clip.webm",
    projectId: "00000000-0000-4000-8000-00000000b001",
    intendedUse: "commercial-online",
    mediaKind: "video",
    mediaType: "video/webm",
    content: { schemaVersion: 1, algorithm: "sha256", digest, byteLength: 10 },
    license: { code: "by", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    itemLicense: {
      code: "by",
      version: "4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    },
    collectionLicense: null,
    policy: { outcome: "allow", reasons: ["attribution-required"] },
    attribution: {
      title: "Clip",
      creator: "Jane",
      creatorUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
      providerName: "Wikimedia Commons",
      licenseName: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    snapshots: [
      {
        kind: "api-record",
        digest: "cd".repeat(32),
        byteLength: 1,
        url: "https://commons.wikimedia.org/w/api.php",
        mediaType: "application/json",
        fetchedAtMs: NOW - DAY,
      },
    ],
    etag: null,
    acquiredAtMs: NOW - DAY,
    lastRefreshAtMs: NOW - DAY,
    lastRefreshStatus: "unchanged",
    ...overrides,
  };
}

const acquired: PreflightAsset = {
  id: "00000000-0000-4000-8000-00000000c001",
  displayName: "clip.webm",
  digest,
  acquisitionReceiptId: receiptId,
};
const local: PreflightAsset = {
  id: "00000000-0000-4000-8000-00000000c002",
  displayName: "local.mp4",
  digest: "ef".repeat(32),
  acquisitionReceiptId: null,
};

describe("rights preflight (UI mirror of the release gate)", () => {
  it("passes local imports and valid receipts", () => {
    expect(rightsPreflight([local, acquired], [receipt()], "commercial-online", NOW)).toEqual([]);
  });

  it("still gates an acquired asset whose origin was stripped (matched by digest)", () => {
    const stripped = { ...acquired, acquisitionReceiptId: null };
    const issues = rightsPreflight(
      [stripped],
      [receipt({ lastRefreshStatus: "withdrawn" })],
      "commercial-online",
      NOW,
    );
    expect(issues.map((i) => i.reason)).toEqual(["upstream-withdrawn"]);
  });

  it.each([
    [{ lastRefreshAtMs: NOW - DEFAULT_FRESHNESS_MS - 1 }, "commercial-online", "refresh-stale"],
    [{ lastRefreshStatus: "changed" as const }, "commercial-online", "upstream-changed"],
    [
      {
        license: {
          code: "by-nc" as const,
          version: "4.0",
          url: "https://creativecommons.org/licenses/by-nc/4.0/",
        },
      },
      "broadcast",
      "use-blocked",
    ],
    [
      { attribution: { ...receipt().attribution, creator: null } },
      "commercial-online",
      "attribution-incomplete",
    ],
  ] as const)("reports %j for %s as %s", (patch, use, reason) => {
    const issues = rightsPreflight([acquired], [receipt(patch)], use, NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toBe(reason);
    expect(issues[0]?.message.length).toBeGreaterThan(10);
  });

  it("distinguishes missing and mismatched claimed receipts", () => {
    expect(rightsPreflight([acquired], [], null, NOW).map((i) => i.reason)).toEqual([
      "receipt-missing",
    ]);
    const other = receipt({
      content: { schemaVersion: 1, algorithm: "sha256", digest: "99".repeat(32), byteLength: 1 },
    });
    expect(rightsPreflight([acquired], [other], null, NOW).map((i) => i.reason)).toEqual([
      "receipt-mismatch",
    ]);
  });

  it("uses the acquisition's intended use when the export declares none", () => {
    const nc = receipt({
      intendedUse: "noncommercial-public",
      license: {
        code: "by-nc",
        version: "4.0",
        url: "https://creativecommons.org/licenses/by-nc/4.0/",
      },
    });
    expect(rightsPreflight([acquired], [nc], null, NOW)).toEqual([]);
    expect(rightsPreflight([acquired], [nc], "commercial-online", NOW)).toHaveLength(1);
  });

  it("maps every Rust render category to a gate reason", () => {
    expect(gateReasonFromRenderCategory("rights_use_blocked")).toBe("use-blocked");
    expect(gateReasonFromRenderCategory("rights_upstream_withdrawn")).toBe("upstream-withdrawn");
    expect(gateReasonFromRenderCategory("argv_grammar")).toBeNull();
    expect(gateReasonFromRenderCategory(7)).toBeNull();
  });
});
