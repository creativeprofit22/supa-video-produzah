import type {
  GraphicsProposalWire,
  ProjectProjection,
  VideoSequenceV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { compileAgentGraphics, type GraphicsStyleDefaults } from "./compile-agent-graphics.js";
import {
  decideAllRanges,
  decideRange,
  deriveApprovedGraphicsProposal,
  isGraphicsProposal,
  markApplied,
  openProposalRecord,
  type ProposalRecord,
  rejectProposal,
} from "./proposal-lifecycle.js";
import { fixtureProjection } from "./proposal-test-fixtures.js";

const defaults: GraphicsStyleDefaults = {
  fontKey: "segoe-ui-bold",
  palette: { fg: "#FFFFFF", bg: "#101418", accent: "#FFB300" },
  presetByCardRole: { title: "pop", lowerThird: "tiltIn", endCard: "pop" },
  captionReveal: null,
  defaultDurationUs: 1_000_000,
  maxOverlapping: 1,
};

function ids(prefix: number): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `9f0000${prefix.toString(16).padStart(2, "0")}-0000-4000-8000-${next.toString().padStart(12, "0")}`;
  };
}

function sequenceOf(projection: ProjectProjection): VideoSequenceV2 {
  const [sequence] = projection.state.sequences;
  if (sequence === undefined) throw new Error("fixture has a sequence");
  return sequence;
}

function graphicsProposal(projection: ProjectProjection): GraphicsProposalWire {
  const result = compileAgentGraphics({
    description: {
      schemaVersion: 1,
      items: [
        { kind: "card", id: "title", role: "title", text: "Hello", atUs: 0 },
        { kind: "card", id: "lower", role: "lowerThird", text: "Name", atUs: 2_000_000 },
        { kind: "caption", id: "cap", text: "Tip", atUs: 4_000_000 },
      ],
    },
    defaults,
    projectId: projection.projectId,
    revision: projection.revision,
    sequence: sequenceOf(projection),
    producer: { id: "test-agent", version: "1", kind: "model", parameters: {} },
    newId: ids(1),
  });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function openRecord(projection = fixtureProjection()): ProposalRecord<GraphicsProposalWire> {
  const proposal = graphicsProposal(projection);
  const opened = openProposalRecord({
    proposal,
    scope: { sequenceId: proposal.sequenceId, trackId: proposal.trackId },
    nowMs: 1_000,
  });
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

function decided(
  record: ProposalRecord<GraphicsProposalWire>,
  accepted: readonly string[],
): ProposalRecord<GraphicsProposalWire> {
  let current = record;
  for (const { rangeId } of record.ranges) {
    const next = decideRange(
      current,
      rangeId,
      accepted.includes(rangeId) ? "accepted" : "rejected",
    );
    if (!next.ok) throw new Error(next.error.code);
    current = next.value;
  }
  return current;
}

function withRevision(projection: ProjectProjection, number: number): ProjectProjection {
  return {
    ...projection,
    revision: {
      ...projection.revision,
      number,
      id: `9c000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
    },
  };
}

describe("graphics proposal lifecycle", () => {
  it("opens one decision per item", () => {
    const record = openRecord();
    expect(isGraphicsProposal(record.proposal)).toBe(true);
    expect(record.ranges).toEqual([
      { rangeId: "title", decision: "undecided" },
      { rangeId: "lower", decision: "undecided" },
      { rangeId: "cap", decision: "undecided" },
    ]);
    expect(record.status).toBe("pending");
  });

  it("reuses a fully accepted proposal at its own base", () => {
    const record = openRecord();
    const all = decideAllRanges(record, "accepted");
    if (!all.ok) throw new Error(all.error.code);
    const derived = deriveApprovedGraphicsProposal({
      record: all.value,
      projection: fixtureProjection(),
      newId: ids(2),
    });
    expect(derived).toMatchObject({
      ok: true,
      value: { kind: "ready", proposal: record.proposal },
    });
  });

  it("keeps only accepted items and their exact commands under fresh ids", () => {
    const record = decided(openRecord(), ["title", "cap"]);
    const derived = deriveApprovedGraphicsProposal({
      record,
      projection: fixtureProjection(),
      newId: ids(2),
    });
    if (!derived.ok || derived.value.kind !== "ready") throw new Error("expected ready");
    const { proposal } = derived.value;
    const offered = record.proposal;
    expect(proposal.items.map(({ itemId }) => itemId)).toEqual(["title", "cap"]);
    expect(proposal.proposalId).not.toBe(offered.proposalId);
    expect(proposal.commandGroup.groupId).not.toBe(offered.commandGroup.groupId);
    const [insert, ...adds] = proposal.commandGroup.commands;
    expect(insert).toEqual(offered.commandGroup.commands[0]);
    expect(adds).toEqual([offered.commandGroup.commands[1], offered.commandGroup.commands[3]]);
  });

  it("re-bases onto a newer revision as a repair", () => {
    const record = decided(openRecord(), ["lower"]);
    const projection = withRevision(fixtureProjection(), 5);
    const derived = deriveApprovedGraphicsProposal({ record, projection, newId: ids(2) });
    if (!derived.ok || derived.value.kind !== "ready") throw new Error("expected ready");
    expect(derived.value.record.repairCount).toBe(1);
    expect(derived.value.proposal.projectRevision).toEqual(projection.revision);
    expect(derived.value.proposal.commandGroup.baseRevision).toBe(5);
  });

  it("drops the track insert once the track exists", () => {
    const record = decided(openRecord(), ["lower"]);
    const base = fixtureProjection();
    const sequence = sequenceOf(base);
    const projection: ProjectProjection = {
      ...withRevision(base, 2),
      state: {
        ...base.state,
        sequences: [
          {
            ...sequence,
            tracks: [
              {
                id: record.proposal.trackId,
                name: "Graphics",
                kind: "graphics",
                graphicsClips: [],
              },
              ...sequence.tracks,
            ],
          },
        ],
      },
    };
    const derived = deriveApprovedGraphicsProposal({ record, projection, newId: ids(2) });
    if (!derived.ok || derived.value.kind !== "ready") throw new Error("expected ready");
    expect(derived.value.proposal.commandGroup.commands.map(({ type }) => type)).toEqual([
      "AddGraphicsClip",
    ]);
  });

  it.each([
    ["the track is locked", true, false, 0],
    ["the track is hidden", false, true, 0],
    ["the repair budget is spent", false, false, 3],
  ])("goes stale when %s", (_name, locked, hidden, repairCount) => {
    const record = decided(openRecord(), ["lower"]);
    const base = fixtureProjection();
    const sequence = sequenceOf(base);
    const projection: ProjectProjection = {
      ...withRevision(base, 2),
      state: {
        ...base.state,
        sequences: [
          {
            ...sequence,
            tracks: [
              {
                id: record.proposal.trackId,
                name: "Graphics",
                kind: "graphics",
                graphicsClips: [],
                locked,
                hidden,
              },
              ...sequence.tracks,
            ],
          },
        ],
      },
    };
    const derived = deriveApprovedGraphicsProposal({
      record: { ...record, repairCount },
      projection,
      newId: ids(2),
    });
    expect(derived).toMatchObject({ ok: true, value: { kind: "stale" } });
  });

  it("refuses when nothing is accepted and after rejection", () => {
    const record = decided(openRecord(), []);
    expect(
      deriveApprovedGraphicsProposal({ record, projection: fixtureProjection(), newId: ids(2) }),
    ).toEqual({ ok: false, error: { code: "nothing_accepted" } });
    const rejected = rejectProposal(record);
    if (!rejected.ok) throw new Error(rejected.error.code);
    expect(
      deriveApprovedGraphicsProposal({
        record: rejected.value,
        projection: fixtureProjection(),
        newId: ids(2),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
  });

  it("marks the applied proposal", () => {
    const record = decided(openRecord(), ["title"]);
    const applied = markApplied(record, { proposalId: "9d000000-0000-4000-8000-000000000001" });
    expect(applied).toMatchObject({
      ok: true,
      value: { status: "applied", appliedProposalId: "9d000000-0000-4000-8000-000000000001" },
    });
  });
});
