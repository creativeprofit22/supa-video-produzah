/*
 * Reader for the append-only `<output>.review.jsonl` review record. The native
 * worker is the only writer; this mirrors its read rules so the Review UI and
 * tests apply the same fail-closed checks:
 * - every line is one valid decision, newline-terminated;
 * - every line is bound to the sibling manifest and output digests;
 * - accept-anyway on a rights finding is ignored.
 */
import type { QcFinding } from "@supa-video/contracts";
import { isOverridable } from "./policy.js";
import type { Result } from "./result.js";
import {
  REPAIR_ATTEMPT_LIMIT,
  reviewDecisionSchema,
  type ReviewDecision,
} from "./review-decision.js";

export type ReviewRecordError =
  | { readonly kind: "malformed_line"; readonly line: number }
  | { readonly kind: "digest_mismatch"; readonly line: number }
  | { readonly kind: "unknown_finding"; readonly line: number };

export interface ReviewRecordBinding {
  readonly manifestSha256: string;
  readonly outputSha256: string;
  readonly findings: readonly QcFinding[];
}

export function parseReviewRecord(
  text: string,
  binding: ReviewRecordBinding,
): Result<readonly ReviewDecision[], ReviewRecordError> {
  if (text === "") return { ok: true, value: [] };
  if (!text.endsWith("\n")) {
    return { ok: false, error: { kind: "malformed_line", line: text.split("\n").length } };
  }
  const findings = new Map(binding.findings.map((finding) => [finding.findingId, finding]));
  const decisions: ReviewDecision[] = [];
  const lines = text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { ok: false, error: { kind: "malformed_line", line: number } };
    }
    const parsed = reviewDecisionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { kind: "malformed_line", line: number } };
    const decision = parsed.data;
    if (
      decision.manifestSha256 !== binding.manifestSha256 ||
      decision.outputSha256 !== binding.outputSha256
    ) {
      return { ok: false, error: { kind: "digest_mismatch", line: number } };
    }
    const finding = findings.get(decision.findingId);
    if (finding === undefined) {
      return { ok: false, error: { kind: "unknown_finding", line: number } };
    }
    if (decision.type === "accept_anyway" && !isOverridable(finding)) continue;
    decisions.push(decision);
  }
  return { ok: true, value: decisions };
}

/** Repair progress for one finding. */
export interface RepairProgress {
  readonly attempts: number;
  readonly stopped: boolean;
  readonly accepted: boolean;
  /** True while another repair proposal may still be started. */
  readonly canAttempt: boolean;
}

export function repairProgress(
  decisions: readonly ReviewDecision[],
  findingId: string,
): RepairProgress {
  const proposals = new Set<string>();
  let stopped = false;
  let accepted = false;
  for (const decision of decisions) {
    if (decision.findingId !== findingId) continue;
    if (decision.type === "repair_attempt") proposals.add(decision.proposalId);
    if (decision.type === "repair_stopped") stopped = true;
    if (decision.type === "accept_anyway") accepted = true;
  }
  return {
    attempts: proposals.size,
    stopped,
    accepted,
    canAttempt: !stopped && proposals.size < REPAIR_ATTEMPT_LIMIT,
  };
}

/**
 * Which existing proposal producer can offer a repair for a finding kind.
 * Repairs are always proposals reviewed through the normal approval path;
 * nothing is applied silently. `null` means the fix is a manual edit.
 */
export function repairProducerFor(kind: QcFinding["kind"]): "silence-gap" | null {
  return kind === "silence" ? "silence-gap" : null;
}
