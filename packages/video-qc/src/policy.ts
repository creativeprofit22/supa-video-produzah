/*
 * Release policy: manifest findings + validated review decisions decide
 * whether an export may be delivered. A blocker is resolved only by an
 * `accept_anyway` decision for that finding; rights blockers never resolve.
 * The native Deliver gate mirrors this in `video/review_record.rs`.
 */
import type { QcFinding } from "@supa-video/contracts";
import type { ReviewDecision } from "./review-decision.js";

export type ReleaseDecision =
  | {
      readonly status: "releasable";
      /** Decision ids of the overrides this release relies on, sorted. */
      readonly acceptedDecisionIds: readonly string[];
      readonly acceptedFindingIds: readonly string[];
    }
  | { readonly status: "blocked"; readonly unresolvedFindingIds: readonly string[] };

export function isOverridable(finding: Pick<QcFinding, "source" | "kind">): boolean {
  return finding.source !== "rights" && finding.kind !== "rights_blocked";
}

/** Latest accept_anyway per finding id, ignoring overrides on rights findings. */
export function acceptedOverrides(
  findings: readonly QcFinding[],
  decisions: readonly ReviewDecision[],
): ReadonlyMap<string, string> {
  const overridable = new Set(
    findings.filter((finding) => isOverridable(finding)).map((finding) => finding.findingId),
  );
  const accepted = new Map<string, string>();
  for (const decision of decisions) {
    if (decision.type === "accept_anyway" && overridable.has(decision.findingId)) {
      accepted.set(decision.findingId, decision.decisionId);
    }
  }
  return accepted;
}

export function evaluateRelease(
  findings: readonly QcFinding[],
  decisions: readonly ReviewDecision[],
): ReleaseDecision {
  const accepted = acceptedOverrides(findings, decisions);
  const unresolved = findings
    .filter((finding) => finding.severity === "blocker" && !accepted.has(finding.findingId))
    .map((finding) => finding.findingId);
  if (unresolved.length > 0) {
    return { status: "blocked", unresolvedFindingIds: [...new Set(unresolved)].sort() };
  }
  const relied = findings
    .filter((finding) => accepted.has(finding.findingId))
    .map((finding) => finding.findingId);
  const acceptedFindingIds = [...new Set(relied)].sort();
  return {
    status: "releasable",
    acceptedFindingIds,
    acceptedDecisionIds: acceptedFindingIds
      .map((findingId) => accepted.get(findingId))
      .filter((id): id is string => id !== undefined)
      .sort(),
  };
}
