import {
  VideoDomainError,
  type AcquisitionReceipt,
  type UsePolicyProfile,
  type VideoProjectStateV2,
} from "@supa-video/contracts";
import {
  gateReasonFromRenderCategory,
  releaseGateMessages,
  rightsPreflight,
  type PreflightAsset,
  type PreflightIssue,
} from "@supa-video/rights";

/*
 * Export-side rights preflight. It explains likely release-gate failures before
 * a render starts. Rust's render authority re-checks every input by content
 * digest regardless, so a skipped or failed preflight never weakens the gate.
 */

export interface RightsPreflightBackend {
  readonly listRightsReceipts: (projectId: string | null) => Promise<readonly AcquisitionReceipt[]>;
}

export const intendedUseLabels: Readonly<Record<UsePolicyProfile, string>> = {
  "private-preview": "Private preview",
  "noncommercial-public": "Non-commercial public",
  "commercial-online": "Commercial online",
  "commercial-client": "Commercial client work",
  broadcast: "Broadcast",
};

export function preflightAssets(state: Readonly<VideoProjectStateV2>): PreflightAsset[] {
  return state.assets.map((asset) => ({
    id: asset.id,
    displayName: asset.displayName,
    digest: asset.contentIdentity?.digest ?? null,
    acquisitionReceiptId: asset.origin?.acquisitionReceiptId ?? null,
  }));
}

/** Preflight is worth a round-trip only when rights can be involved. */
export function needsRightsPreflight(
  state: Readonly<VideoProjectStateV2>,
  intendedUse: UsePolicyProfile | null,
): boolean {
  return intendedUse !== null || state.assets.some((asset) => asset.origin !== undefined);
}

export function rightsPreflightError(issues: readonly PreflightIssue[]): VideoDomainError {
  const first = issues[0];
  const summary =
    first === undefined
      ? "A rights check failed."
      : `${first.displayName}: ${first.message}${
          issues.length > 1
            ? ` (${issues.length - 1} more media item${issues.length > 2 ? "s" : ""} also blocked.)`
            : ""
        }`;
  return new VideoDomainError("invalid_render_plan", summary, {
    category: "rights_preflight",
    reasons: issues.map((issue) => issue.reason),
  });
}

/**
 * Runs the UI preflight. Returns the blocking error, or null to proceed. A
 * failure to list receipts proceeds: the Rust gate is the authority.
 */
export async function runRightsPreflight(
  backend: RightsPreflightBackend | null,
  state: Readonly<VideoProjectStateV2>,
  intendedUse: UsePolicyProfile | null,
  nowMs: number,
): Promise<VideoDomainError | null> {
  if (backend === null || !needsRightsPreflight(state, intendedUse)) return null;
  let receipts: readonly AcquisitionReceipt[];
  try {
    receipts = await backend.listRightsReceipts(null);
  } catch {
    return null;
  }
  const issues = rightsPreflight(preflightAssets(state), receipts, intendedUse, nowMs);
  return issues.length === 0 ? null : rightsPreflightError(issues);
}

/** Message for a render refused by Rust's release gate, or null if not a rights failure. */
export function rightsRenderErrorMessage(error: VideoDomainError): string | null {
  if (error.code !== "invalid_render_plan") return null;
  const category = error.details["category"];
  if (category === "rights_preflight") return error.message;
  if (category === "rights_credits_write") {
    return "The credits file could not be written next to the export. Choose another folder.";
  }
  if (category === "rights_context" || category === "rights_unavailable") {
    return "Rights checks are unavailable. Restart the app and try again.";
  }
  const reason = gateReasonFromRenderCategory(category);
  return reason === null ? null : `Rights check failed: ${releaseGateMessages[reason]}`;
}
