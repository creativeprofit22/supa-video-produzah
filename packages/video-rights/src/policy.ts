import type {
  LicenseCode,
  PolicyDecision,
  PolicyReasonCode,
  UsePolicyProfile,
} from "@supa-video/contracts";

/* UI mirror of `src-tauri/src/rights/policy.rs`; pinned by the shared matrix. */

type Outcome = PolicyDecision["outcome"];

const REASON_ORDER: readonly PolicyReasonCode[] = [
  "attribution-required",
  "share-alike-obligation",
  "noncommercial-only",
  "no-derivatives",
  "custom-terms-review",
  "license-unknown",
  "license-conflict",
];

function reasonsFor(code: LicenseCode): PolicyReasonCode[] {
  const reasons: PolicyReasonCode[] = [];
  if (code.startsWith("by")) reasons.push("attribution-required");
  if (code.endsWith("-sa")) reasons.push("share-alike-obligation");
  if (code.includes("-nc")) reasons.push("noncommercial-only");
  if (code.endsWith("-nd")) reasons.push("no-derivatives");
  if (code === "custom") reasons.push("custom-terms-review");
  if (code === "unknown") reasons.push("license-unknown");
  return reasons;
}

function baseOutcome(code: LicenseCode, profile: UsePolicyProfile): Outcome {
  const isPrivate = profile === "private-preview";
  const isCommercial = profile !== "private-preview" && profile !== "noncommercial-public";
  const isHighStakes = profile === "commercial-client" || profile === "broadcast";
  switch (code) {
    case "cc0":
    case "pdm":
    case "by":
      return "allow";
    case "by-sa":
      if (isPrivate) return "allow";
      return isHighStakes ? "block" : "warn";
    case "by-nc":
      return isCommercial ? "block" : "allow";
    case "by-nc-sa":
      if (isPrivate) return "allow";
      return isCommercial ? "block" : "warn";
    case "by-nd":
    case "by-nc-nd":
      return isPrivate ? "allow" : "block";
    case "custom":
      return isPrivate ? "allow" : "warn";
    case "unknown":
      return isPrivate ? "warn" : "block";
  }
}

export function evaluatePolicy(
  code: LicenseCode,
  profile: UsePolicyProfile,
  conflict: boolean,
): PolicyDecision {
  let outcome = baseOutcome(code, profile);
  const reasons = reasonsFor(code);
  if (conflict) {
    reasons.push("license-conflict");
    if (outcome === "allow") outcome = "warn";
  }
  reasons.sort((left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right));
  return { outcome, reasons };
}
