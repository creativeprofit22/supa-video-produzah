import type { ProjectProjection } from "@supa-video/contracts";
import type { TranscriptArtifactV1 } from "@supa-video/media";

import { err, ok, type Result } from "./proposal-producer.js";
import {
  createTranscriptEditProposal,
  type TranscriptEditDeletedRange,
  type TranscriptEditGapSelection,
  type TranscriptEditProposal,
} from "./transcript-edit-proposal.js";

export const proposalStatuses = [
  "pending",
  "partially_approved",
  "applied",
  "rejected",
  "expired",
  "stale",
  "restored",
] as const;
export type ProposalStatus = (typeof proposalStatuses)[number];

export type RangeDecision = "undecided" | "accepted" | "rejected";

/** Terminal statuses allow no further transitions; applied can only be restored. */
const allowedTransitions: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> =
  Object.freeze({
    pending: ["partially_approved", "applied", "rejected", "expired", "stale"],
    partially_approved: [
      "pending",
      "partially_approved",
      "applied",
      "rejected",
      "expired",
      "stale",
    ],
    applied: ["restored"],
    rejected: [],
    expired: [],
    stale: [],
    restored: [],
  });

export function isTerminalStatus(status: ProposalStatus): boolean {
  return allowedTransitions[status].length === 0;
}

/** Statuses still awaiting a decision; applied is settled but not terminal. */
function isOpenStatus(status: ProposalStatus): boolean {
  return status === "pending" || status === "partially_approved";
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export interface ProposalPolicy {
  /** Wall-clock lifetime of a pending proposal. */
  readonly ttlMs: number;
  /** Expire once the project moved this many revisions past the proposal base. */
  readonly maxRevisionDrift: number;
  /** How many times an approval may be re-derived against a newer revision. */
  readonly maxRepairs: number;
}

export const defaultProposalPolicy: ProposalPolicy = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1_000,
  maxRevisionDrift: 20,
  maxRepairs: 3,
});

/** Limits a proposal to one sequence and track. */
export interface ProposalScope {
  readonly sequenceId: string;
  readonly trackId: string;
}

export interface ProposalRangeState {
  readonly rangeId: string;
  readonly decision: RangeDecision;
}

export interface ProposalRecord {
  readonly schemaVersion: 1;
  readonly proposal: TranscriptEditProposal;
  readonly status: ProposalStatus;
  readonly scope: ProposalScope;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly ranges: readonly ProposalRangeState[];
  readonly repairCount: number;
  /** Set once applied: the proposal (possibly re-derived) that was committed. */
  readonly appliedProposalId: string | null;
  readonly statusReason: string | null;
}

export type LifecycleError =
  | {
      readonly code: "invalid_transition";
      readonly from: ProposalStatus;
      readonly to: ProposalStatus;
    }
  | { readonly code: "out_of_scope"; readonly rangeId: string }
  | { readonly code: "unknown_range"; readonly rangeId: string }
  | { readonly code: "nothing_accepted" }
  | { readonly code: "invalid_policy"; readonly message: string };

export function rangeIdOf(range: TranscriptEditDeletedRange): string {
  return `${range.clipId}:${range.sourceRange.start.value}:${range.sourceRange.end.value}`;
}

function validatePolicy(policy: ProposalPolicy): LifecycleError | null {
  const valid =
    Number.isSafeInteger(policy.ttlMs) &&
    policy.ttlMs > 0 &&
    Number.isSafeInteger(policy.maxRevisionDrift) &&
    policy.maxRevisionDrift >= 0 &&
    Number.isSafeInteger(policy.maxRepairs) &&
    policy.maxRepairs >= 0;
  return valid
    ? null
    : { code: "invalid_policy", message: "Policy values must be non-negative integers" };
}

function withStatus(
  record: ProposalRecord,
  status: ProposalStatus,
  statusReason: string | null,
): Result<ProposalRecord, LifecycleError> {
  if (!canTransition(record.status, status)) {
    return err({ code: "invalid_transition", from: record.status, to: status });
  }
  return ok(Object.freeze({ ...record, status, statusReason }));
}

export function openProposalRecord(input: {
  readonly proposal: TranscriptEditProposal;
  readonly scope: ProposalScope;
  readonly nowMs: number;
  readonly policy?: ProposalPolicy;
}): Result<ProposalRecord, LifecycleError> {
  const policy = input.policy ?? defaultProposalPolicy;
  const invalid = validatePolicy(policy);
  if (invalid !== null) return err(invalid);
  const { proposal, scope } = input;
  for (const range of proposal.deletedRanges) {
    const inTrack = proposal.sequenceId === scope.sequenceId && proposal.trackId === scope.trackId;
    if (!inTrack) return err({ code: "out_of_scope", rangeId: rangeIdOf(range) });
  }
  return ok(
    Object.freeze({
      schemaVersion: 1,
      proposal,
      status: "pending",
      scope,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + policy.ttlMs,
      ranges: Object.freeze(
        proposal.deletedRanges.map((range) =>
          Object.freeze({ rangeId: rangeIdOf(range), decision: "undecided" as const }),
        ),
      ),
      repairCount: 0,
      appliedProposalId: null,
      statusReason: null,
    }),
  );
}

/** Records the user's decision for one range. Any decision makes it partially approved. */
export function decideRange(
  record: ProposalRecord,
  rangeId: string,
  decision: RangeDecision,
): Result<ProposalRecord, LifecycleError> {
  if (!record.ranges.some((range) => range.rangeId === rangeId)) {
    return err({ code: "unknown_range", rangeId });
  }
  const ranges = Object.freeze(
    record.ranges.map((range) =>
      range.rangeId === rangeId ? Object.freeze({ rangeId, decision }) : range,
    ),
  );
  const status = ranges.every(({ decision: value }) => value === "undecided")
    ? "pending"
    : "partially_approved";
  const next = withStatus(record, status, null);
  return next.ok ? ok(Object.freeze({ ...next.value, ranges })) : next;
}

export function decideAllRanges(
  record: ProposalRecord,
  decision: Exclude<RangeDecision, "undecided">,
): Result<ProposalRecord, LifecycleError> {
  let current: Result<ProposalRecord, LifecycleError> = ok(record);
  for (const { rangeId } of record.ranges) {
    if (!current.ok) return current;
    current = decideRange(current.value, rangeId, decision);
  }
  return current;
}

export function rejectProposal(
  record: ProposalRecord,
  reason = "Rejected by user",
): Result<ProposalRecord, LifecycleError> {
  return withStatus(record, "rejected", reason);
}

/**
 * Checks time- and revision-based expiry. Returns the record unchanged if it is
 * still live or already settled (applied or terminal).
 */
export function refreshExpiry(
  record: ProposalRecord,
  nowMs: number,
  currentRevision: number,
  policy: ProposalPolicy = defaultProposalPolicy,
): ProposalRecord {
  if (!isOpenStatus(record.status)) return record;
  if (nowMs >= record.expiresAtMs) {
    return Object.freeze({ ...record, status: "expired", statusReason: "Proposal timed out" });
  }
  const drift = currentRevision - record.proposal.projectRevision.number;
  if (drift < 0) {
    return Object.freeze({
      ...record,
      status: "stale",
      statusReason: "Project history moved backwards",
    });
  }
  if (drift > policy.maxRevisionDrift) {
    return Object.freeze({
      ...record,
      status: "expired",
      statusReason: `Project changed ${drift} times since the proposal`,
    });
  }
  return record;
}

/** Word occurrences and gaps covered by the accepted ranges. */
export function acceptedSelection(record: ProposalRecord): {
  readonly occurrenceIds: readonly string[];
  readonly gaps: readonly TranscriptEditGapSelection[];
} {
  const accepted = new Set(
    record.ranges.filter(({ decision }) => decision === "accepted").map(({ rangeId }) => rangeId),
  );
  const occurrenceIds: string[] = [];
  const gaps: TranscriptEditGapSelection[] = [];
  for (const range of record.proposal.deletedRanges) {
    if (!accepted.has(rangeIdOf(range))) continue;
    occurrenceIds.push(...range.selectedWords.map(({ occurrenceId }) => occurrenceId));
    for (const gap of record.proposal.deletedGaps) {
      if (
        gap.clipId === range.clipId &&
        gap.sourceStartFrame >= range.sourceRange.start.value &&
        gap.sourceEndFrame <= range.sourceRange.end.value
      ) {
        gaps.push(gap);
      }
    }
  }
  return { occurrenceIds: Object.freeze(occurrenceIds), gaps: Object.freeze(gaps) };
}

export type DeriveApprovalResult =
  | {
      readonly kind: "ready";
      readonly record: ProposalRecord;
      readonly proposal: TranscriptEditProposal;
    }
  | { readonly kind: "stale"; readonly record: ProposalRecord };

/**
 * Builds the proposal to apply from the accepted ranges against the current
 * project. A full approval at the proposal's own base reuses it unchanged.
 * Otherwise the subset is re-derived through `createTranscriptEditProposal`;
 * re-deriving against a newer revision counts as a repair, and once
 * `maxRepairs` is used up, or the re-derivation fails, the record goes stale
 * rather than risking a wrong cut.
 */
export async function deriveApprovedProposal(input: {
  readonly record: ProposalRecord;
  readonly artifact: TranscriptArtifactV1;
  readonly projection: ProjectProjection;
  readonly policy?: ProposalPolicy;
}): Promise<Result<DeriveApprovalResult, LifecycleError>> {
  const policy = input.policy ?? defaultProposalPolicy;
  const { record } = input;
  if (!isOpenStatus(record.status)) {
    return err({ code: "invalid_transition", from: record.status, to: "applied" });
  }
  const selection = acceptedSelection(record);
  if (selection.occurrenceIds.length === 0 && selection.gaps.length === 0) {
    return err({ code: "nothing_accepted" });
  }
  const allAccepted = record.ranges.every(({ decision }) => decision === "accepted");
  const sameBase =
    input.projection.projectId === record.proposal.projectId &&
    input.projection.revision.id === record.proposal.projectRevision.id;
  if (allAccepted && sameBase) {
    return ok({ kind: "ready", record, proposal: record.proposal });
  }
  const repairCount = sameBase ? record.repairCount : record.repairCount + 1;
  const goStale = (reason: string): Result<DeriveApprovalResult, LifecycleError> =>
    ok({
      kind: "stale",
      record: Object.freeze({ ...record, status: "stale", statusReason: reason, repairCount }),
    });
  if (repairCount > policy.maxRepairs) {
    return goStale("Project changed too often while this proposal was waiting");
  }
  try {
    const proposal = await createTranscriptEditProposal({
      artifact: input.artifact,
      projection: input.projection,
      sequenceId: record.proposal.sequenceId,
      trackId: record.proposal.trackId,
      deletedOccurrenceIds: selection.occurrenceIds,
      deletedGaps: selection.gaps,
      producer: record.proposal.producer,
    });
    // Re-derivation drops producer reasons; keep those of the cuts that survived.
    const survivingIds = new Set(proposal.deletedRanges.map(rangeIdOf));
    const reasons = (record.proposal.reasons ?? []).filter(({ rangeId }) =>
      survivingIds.has(rangeId),
    );
    return ok({
      kind: "ready",
      record: Object.freeze({ ...record, repairCount }),
      proposal: reasons.length === 0 ? proposal : Object.freeze({ ...proposal, reasons }),
    });
  } catch (error) {
    return goStale(error instanceof Error ? error.message : String(error));
  }
}

export function markApplied(
  record: ProposalRecord,
  appliedProposal: TranscriptEditProposal,
): Result<ProposalRecord, LifecycleError> {
  const next = withStatus(record, "applied", null);
  return next.ok
    ? ok(Object.freeze({ ...next.value, appliedProposalId: appliedProposal.proposalId }))
    : next;
}
