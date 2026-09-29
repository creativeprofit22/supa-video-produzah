import { describe, expect, it } from "vitest";

import {
  acceptedSelection,
  canTransition,
  decideAllRanges,
  decideRange,
  defaultProposalPolicy,
  deriveApprovedProposal,
  isTerminalStatus,
  markApplied,
  openProposalRecord,
  proposalStatuses,
  refreshExpiry,
  rejectProposal,
  type ProposalRecord,
} from "./proposal-lifecycle.js";
import {
  fixtureArtifact,
  fixtureClip,
  fixtureId,
  fixtureProjection,
  fixtureScope,
} from "./proposal-test-fixtures.js";
import { createTranscriptEditProposal, projectTranscriptToTimeline } from "./transcript-edit.js";

const artifact = fixtureArtifact([
  { startUs: 1_000_000, endUs: 1_500_000, text: "um" },
  { startUs: 3_000_000, endUs: 3_500_000, text: "hello" },
  { startUs: 5_000_000, endUs: 5_500_000, text: "uh" },
]);
const projection = fixtureProjection([fixtureClip(100, 0, 100)]);
const scope = fixtureScope(artifact, projection);
const trackScope = { sequenceId: fixtureId(2), trackId: fixtureId(10) };
const t0 = 1_000_000;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function openRecord(): Promise<ProposalRecord> {
  const ids = projectTranscriptToTimeline(scope)
    .occurrences.filter(({ text }) => text !== "hello")
    .map(({ occurrenceId }) => occurrenceId);
  const proposal = await createTranscriptEditProposal({ ...scope, deletedOccurrenceIds: ids });
  return unwrap(openProposalRecord({ proposal, scope: trackScope, nowMs: t0 }));
}

describe("proposal lifecycle", () => {
  it("allows only the documented transitions", () => {
    const table = Object.fromEntries(
      proposalStatuses.map((from) => [
        from,
        proposalStatuses.filter((to) => canTransition(from, to)),
      ]),
    );
    expect(table).toEqual({
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
    expect(proposalStatuses.filter(isTerminalStatus)).toEqual([
      "rejected",
      "expired",
      "stale",
      "restored",
    ]);
  });

  it("opens pending with one undecided range per cut and a policy expiry", async () => {
    const record = await openRecord();
    expect(record.status).toBe("pending");
    expect(record.ranges).toHaveLength(2);
    expect(record.ranges.every(({ decision }) => decision === "undecided")).toBe(true);
    expect(record.expiresAtMs).toBe(t0 + defaultProposalPolicy.ttlMs);
  });

  it("rejects proposals outside the scope", async () => {
    const record = await openRecord();
    const otherTrack = openProposalRecord({
      proposal: record.proposal,
      scope: { ...trackScope, trackId: fixtureId(11) },
      nowMs: t0,
    });
    expect(otherTrack).toMatchObject({ ok: false, error: { code: "out_of_scope" } });
    expect(
      openProposalRecord({
        proposal: record.proposal,
        scope: trackScope,
        nowMs: t0,
        policy: { ...defaultProposalPolicy, ttlMs: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_policy" } });
  });

  it("tracks per-range decisions and returns to pending when cleared", async () => {
    const record = await openRecord();
    const first = record.ranges[0]?.rangeId ?? "";
    const decided = unwrap(decideRange(record, first, "accepted"));
    expect(decided.status).toBe("partially_approved");
    expect(unwrap(decideRange(decided, first, "undecided")).status).toBe("pending");
    expect(decideRange(record, "nope", "accepted")).toMatchObject({
      ok: false,
      error: { code: "unknown_range" },
    });
  });

  it("forbids changes after a terminal status", async () => {
    const rejected = unwrap(rejectProposal(await openRecord()));
    expect(rejected.status).toBe("rejected");
    expect(decideRange(rejected, rejected.ranges[0]?.rangeId ?? "", "accepted")).toMatchObject({
      ok: false,
      error: { code: "invalid_transition", from: "rejected" },
    });
    expect(rejectProposal(rejected).ok).toBe(false);
  });

  it.each([
    ["live", t0 + 1, 7, "pending"],
    ["timed out", t0 + defaultProposalPolicy.ttlMs, 7, "expired"],
    ["within revision drift", t0 + 1, 7 + defaultProposalPolicy.maxRevisionDrift, "pending"],
    ["beyond revision drift", t0 + 1, 8 + defaultProposalPolicy.maxRevisionDrift, "expired"],
    ["history moved backwards", t0 + 1, 6, "stale"],
  ] as const)("expiry: %s", async (_label, nowMs, revision, status) => {
    expect(refreshExpiry(await openRecord(), nowMs, revision).status).toBe(status);
  });

  it("reuses the proposal when fully approved at its own base", async () => {
    const record = unwrap(decideAllRanges(await openRecord(), "accepted"));
    const derived = unwrap(await deriveApprovedProposal({ record, artifact, projection }));
    expect(derived).toMatchObject({ kind: "ready", proposal: record.proposal });
    const applied = unwrap(markApplied(derived.record, record.proposal));
    expect(applied).toMatchObject({
      status: "applied",
      appliedProposalId: record.proposal.proposalId,
    });
  });

  it("re-derives a partial approval containing only accepted ranges", async () => {
    const record = await openRecord();
    const [first, second] = record.ranges;
    const partial = unwrap(
      decideRange(
        unwrap(decideRange(record, first?.rangeId ?? "", "accepted")),
        second?.rangeId ?? "",
        "rejected",
      ),
    );
    expect(acceptedSelection(partial).occurrenceIds).toHaveLength(1);
    const derived = unwrap(await deriveApprovedProposal({ record: partial, artifact, projection }));
    if (derived.kind !== "ready") throw new Error("expected ready");
    expect(derived.proposal.selectedWords.map(({ text }) => text)).toEqual(["um"]);
    expect(derived.proposal.producer).toEqual(record.proposal.producer);
    expect(derived.record.repairCount).toBe(0);
  });

  it("refuses to apply with nothing accepted", async () => {
    const record = unwrap(decideAllRanges(await openRecord(), "rejected"));
    expect(await deriveApprovedProposal({ record, artifact, projection })).toEqual({
      ok: false,
      error: { code: "nothing_accepted" },
    });
  });

  it("repairs against a newer revision up to the bound, then goes stale", async () => {
    const record = unwrap(decideAllRanges(await openRecord(), "accepted"));
    const newer = fixtureProjection([fixtureClip(100, 0, 100)], { revisionNumber: 8 });
    const policy = { ...defaultProposalPolicy, maxRepairs: 1 };
    const repaired = unwrap(
      await deriveApprovedProposal({ record, artifact, projection: newer, policy }),
    );
    if (repaired.kind !== "ready") throw new Error("expected ready");
    expect(repaired.record.repairCount).toBe(1);
    expect(repaired.proposal.commandGroup.baseRevision).toBe(8);

    const newest = fixtureProjection([fixtureClip(100, 0, 100)], { revisionNumber: 9 });
    const exhausted = unwrap(
      await deriveApprovedProposal({
        record: repaired.record,
        artifact,
        projection: newest,
        policy,
      }),
    );
    expect(exhausted.kind).toBe("stale");
    expect(exhausted.record).toMatchObject({ status: "stale", repairCount: 2 });
  });

  it("goes stale instead of cutting when the clip changed", async () => {
    const record = unwrap(decideAllRanges(await openRecord(), "accepted"));
    const changed = fixtureProjection([fixtureClip(101, 0, 100)], { revisionNumber: 8 });
    const result = unwrap(await deriveApprovedProposal({ record, artifact, projection: changed }));
    expect(result.kind).toBe("stale");
    expect(result.record.status).toBe("stale");
  });
});
