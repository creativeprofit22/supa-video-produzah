import type {
  AcquisitionReceipt,
  ReleaseGateReason,
  UsePolicyProfile,
} from "@supa-video/contracts";

import { missingAttributionFields } from "./attribution.js";
import { evaluatePolicy } from "./policy.js";

/*
 * UI preflight mirror of `src-tauri/src/rights/gate.rs`. It explains likely
 * gate failures before a render starts. It is never an authority: Rust
 * re-checks every input by content digest, including snapshot integrity,
 * which this preflight cannot see.
 */

export const DEFAULT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

export interface PreflightAsset {
  readonly id: string;
  readonly displayName: string;
  readonly digest: string | null;
  readonly acquisitionReceiptId: string | null;
}

export interface PreflightIssue {
  readonly assetId: string;
  readonly displayName: string;
  readonly receiptId: string | null;
  readonly reason: ReleaseGateReason;
  readonly message: string;
}

export const releaseGateMessages: Readonly<Record<ReleaseGateReason, string>> = {
  "receipt-missing": "Its rights receipt is missing. Acquire it again from the media search.",
  "receipt-mismatch": "Its rights receipt belongs to different media. Acquire it again.",
  "snapshot-missing": "Saved license evidence is missing. Acquire it again.",
  "snapshot-tampered": "Saved license evidence was altered. Acquire it again.",
  "refresh-stale": "License evidence is out of date. Refresh it in the rights inspector.",
  "upstream-changed": "The provider changed this item's record. Review it in the rights inspector.",
  "upstream-withdrawn": "The provider no longer offers this item. Remove it from the timeline.",
  "use-blocked": "Its license does not allow this export's intended use.",
  "attribution-incomplete": "Required credit information is missing.",
};

function issue(
  asset: PreflightAsset,
  receiptId: string | null,
  reason: ReleaseGateReason,
): PreflightIssue {
  return {
    assetId: asset.id,
    displayName: asset.displayName,
    receiptId,
    reason,
    message: releaseGateMessages[reason],
  };
}

function checkReceipt(
  receipt: AcquisitionReceipt,
  intendedUse: UsePolicyProfile | null,
  nowMs: number,
  freshnessMs: number,
): ReleaseGateReason | null {
  if (nowMs - receipt.lastRefreshAtMs > freshnessMs) return "refresh-stale";
  if (receipt.lastRefreshStatus === "changed") return "upstream-changed";
  if (receipt.lastRefreshStatus === "withdrawn") return "upstream-withdrawn";
  const conflict = receipt.policy.reasons.includes("license-conflict");
  const profile = intendedUse ?? receipt.intendedUse;
  if (evaluatePolicy(receipt.license.code, profile, conflict).outcome === "block") {
    return "use-blocked";
  }
  if (missingAttributionFields(receipt.license.code, receipt.attribution).length > 0) {
    return "attribution-incomplete";
  }
  return null;
}

/** Issues sorted by asset display name then asset id (deterministic). */
export function rightsPreflight(
  assets: readonly PreflightAsset[],
  receipts: readonly AcquisitionReceipt[],
  intendedUse: UsePolicyProfile | null,
  nowMs: number,
  freshnessMs: number = DEFAULT_FRESHNESS_MS,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const asset of assets) {
    const byDigest =
      asset.digest === null ? [] : receipts.filter((r) => r.content.digest === asset.digest);
    const claimed = asset.acquisitionReceiptId;
    if (claimed !== null && !byDigest.some((r) => r.receiptId === claimed)) {
      const exists = receipts.some((r) => r.receiptId === claimed);
      issues.push(issue(asset, claimed, exists ? "receipt-mismatch" : "receipt-missing"));
      continue;
    }
    if (byDigest.length === 0) continue; // Local import.
    const sticky =
      byDigest.find((r) => r.lastRefreshStatus === "withdrawn") ??
      byDigest.find((r) => r.lastRefreshStatus === "changed");
    const selected =
      sticky ??
      byDigest.find((r) => r.receiptId === claimed) ??
      [...byDigest].sort(
        (a, b) => b.lastRefreshAtMs - a.lastRefreshAtMs || (a.receiptId < b.receiptId ? 1 : -1),
      )[0];
    if (selected === undefined) continue;
    const reason = checkReceipt(selected, intendedUse, nowMs, freshnessMs);
    if (reason !== null) issues.push(issue(asset, selected.receiptId, reason));
  }
  return issues.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0),
  );
}

/** Maps Rust's `invalid_render_plan` rights categories to gate reasons. */
export function gateReasonFromRenderCategory(category: unknown): ReleaseGateReason | null {
  const table: Readonly<Record<string, ReleaseGateReason>> = {
    rights_receipt_missing: "receipt-missing",
    rights_receipt_mismatch: "receipt-mismatch",
    rights_snapshot_missing: "snapshot-missing",
    rights_snapshot_tampered: "snapshot-tampered",
    rights_refresh_stale: "refresh-stale",
    rights_upstream_changed: "upstream-changed",
    rights_upstream_withdrawn: "upstream-withdrawn",
    rights_use_blocked: "use-blocked",
    rights_attribution_incomplete: "attribution-incomplete",
  };
  return typeof category === "string" ? (table[category] ?? null) : null;
}
