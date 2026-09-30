import type { AcquisitionReceipt, UsePolicyProfile } from "@supa-video/contracts";
import { DEFAULT_FRESHNESS_MS, evaluatePolicy, rightsPreflight } from "@supa-video/rights";

import type { LocalAssetIndexEntry } from "./asset-index.js";

/*
 * Rights hard filter for first-cut retrieval. Acquired media must carry a
 * receipt that matches its content digest and passes the same checks as the
 * export release gate (freshness, upstream change/withdrawal, intended-use
 * policy, attribution). Unknown licenses are always excluded, even for private
 * previews. Local imports pass as owned. Similarity scores never feed this.
 */

export type RightsRejectionReason =
  | "receipt-missing"
  | "receipt-mismatch"
  | "snapshot-missing"
  | "snapshot-tampered"
  | "refresh-stale"
  | "upstream-changed"
  | "upstream-withdrawn"
  | "use-blocked"
  | "attribution-incomplete"
  | "license-unknown";

export type RightsDecision =
  | {
      readonly assetId: string;
      readonly eligible: true;
      readonly receiptId: string | null;
      readonly policyOutcome: "owned" | "allow" | "warn";
      /** Owned-first: 1 for owned media, 0.8 when policy allows, 0.5 when it warns. */
      readonly rightsConfidence: number;
    }
  | {
      readonly assetId: string;
      readonly eligible: false;
      readonly receiptId: string | null;
      readonly reason: RightsRejectionReason;
      readonly message: string;
    };

export interface RightsFilterInput {
  readonly entries: readonly LocalAssetIndexEntry[];
  readonly receipts: readonly AcquisitionReceipt[];
  readonly intendedUse: UsePolicyProfile;
  readonly nowMs: number;
  readonly freshnessMs?: number;
}

export function filterByRights(input: RightsFilterInput): RightsDecision[] {
  const freshnessMs = input.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  return input.entries.map((entry): RightsDecision => {
    if (entry.provenance === "owned") {
      return {
        assetId: entry.assetId,
        eligible: true,
        receiptId: null,
        policyOutcome: "owned",
        rightsConfidence: 1,
      };
    }
    const [issue] = rightsPreflight(
      [
        {
          id: entry.assetId,
          displayName: entry.displayName,
          digest: entry.contentDigest,
          acquisitionReceiptId: entry.acquisitionReceiptId,
        },
      ],
      input.receipts,
      input.intendedUse,
      input.nowMs,
      freshnessMs,
    );
    if (issue !== undefined) {
      return {
        assetId: entry.assetId,
        eligible: false,
        receiptId: issue.receiptId,
        reason: issue.reason,
        message: issue.message,
      };
    }
    const receipt = input.receipts.find(
      (candidate) =>
        candidate.receiptId === entry.acquisitionReceiptId &&
        candidate.content.digest === entry.contentDigest,
    );
    if (receipt === undefined) {
      return {
        assetId: entry.assetId,
        eligible: false,
        receiptId: entry.acquisitionReceiptId,
        reason: "receipt-missing",
        message: "Acquired media has no matching rights receipt.",
      };
    }
    if (receipt.license.code === "unknown") {
      return {
        assetId: entry.assetId,
        eligible: false,
        receiptId: receipt.receiptId,
        reason: "license-unknown",
        message: "Its license is unknown, so it is never proposed automatically.",
      };
    }
    const outcome = evaluatePolicy(
      receipt.license.code,
      input.intendedUse,
      receipt.policy.reasons.includes("license-conflict"),
    ).outcome;
    if (outcome === "block") {
      return {
        assetId: entry.assetId,
        eligible: false,
        receiptId: receipt.receiptId,
        reason: "use-blocked",
        message: "Its license does not allow this export's intended use.",
      };
    }
    return {
      assetId: entry.assetId,
      eligible: true,
      receiptId: receipt.receiptId,
      policyOutcome: outcome,
      rightsConfidence: outcome === "allow" ? 0.8 : 0.5,
    };
  });
}
