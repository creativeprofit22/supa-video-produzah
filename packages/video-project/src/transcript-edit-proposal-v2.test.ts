import { VideoDomainError } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { userSelectionProvenance, type ProducerId } from "./proposal-producer.js";
import {
  fixtureArtifact,
  fixtureClip,
  fixtureId,
  fixtureProjection,
  fixtureScope,
} from "./proposal-test-fixtures.js";
import {
  assertTranscriptEditProposalCurrent,
  createTranscriptEditProposal,
  parseTranscriptEditProposal,
  projectTranscriptToTimeline,
  upgradeTranscriptEditProposal,
  type TranscriptEditProposalV1,
} from "./transcript-edit.js";

const artifact = fixtureArtifact([
  { startUs: 1_000_000, endUs: 1_500_000, text: "hello" },
  { startUs: 3_000_000, endUs: 3_500_000, text: "um" },
  { startUs: 3_600_000, endUs: 4_000_000, text: "world" },
]);
const projection = fixtureProjection([fixtureClip(100, 0, 100)]);
const scope = fixtureScope(artifact, projection);
const ruleProducer = {
  id: "silence-gap" as ProducerId,
  version: "1",
  kind: "rule" as const,
  parameters: { minGapMs: 700 },
};

function occurrenceId(text: string): string {
  const occurrence = projectTranscriptToTimeline(scope).occurrences.find(
    (candidate) => candidate.text === text,
  );
  if (occurrence === undefined) throw new Error(`missing ${text}`);
  return occurrence.occurrenceId;
}

describe("transcript edit proposal schema v2", () => {
  it("records user-selection provenance by default", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
    });
    expect(proposal.schemaVersion).toBe(2);
    expect(proposal.producer).toEqual(userSelectionProvenance);
    expect(proposal.deletedGaps).toEqual([]);
  });

  it("records producer provenance and gives it a distinct deterministic id", async () => {
    const user = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
    });
    const first = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
      producer: ruleProducer,
    });
    const second = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
      producer: ruleProducer,
    });
    expect(first.producer).toEqual(ruleProducer);
    expect(first.proposalId).toBe(second.proposalId);
    expect(first.proposalId).not.toBe(user.proposalId);
  });

  it("cuts a non-speech gap without selecting words", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [],
      deletedGaps: [{ clipId: fixtureId(100), sourceStartFrame: 16, sourceEndFrame: 29 }],
      producer: ruleProducer,
    });
    expect(proposal.deletedRanges).toHaveLength(1);
    expect(proposal.deletedRanges[0]?.sourceRange.start.value).toBe(16);
    expect(proposal.deletedRanges[0]?.sourceRange.end.value).toBe(29);
    expect(proposal.deletedRanges[0]?.selectedWords).toEqual([]);
    expect(proposal.commandGroup.commands.length).toBeGreaterThan(0);
  });

  it("unions a gap with an adjacent selected word into one cut", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
      deletedGaps: [{ clipId: fixtureId(100), sourceStartFrame: 16, sourceEndFrame: 30 }],
    });
    expect(proposal.deletedRanges).toHaveLength(1);
    expect(proposal.deletedRanges[0]?.sourceRange.start.value).toBe(16);
    expect(proposal.deletedRanges[0]?.selectedWords.map(({ text }) => text)).toEqual(["um"]);
  });

  it.each([
    ["overlaps a kept word", { sourceStartFrame: 12, sourceEndFrame: 20 }, "gap_overlaps_word"],
    ["leaves the clip", { sourceStartFrame: 90, sourceEndFrame: 120 }, "gap_outside_clip"],
    ["is empty", { sourceStartFrame: 20, sourceEndFrame: 20 }, "gap_outside_clip"],
  ])("rejects a gap that %s", async (_label, range, reason) => {
    const failure = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [],
      deletedGaps: [{ clipId: fixtureId(100), ...range }],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VideoDomainError);
    expect(failure).toMatchObject({ details: { reason } });
  });

  it("parses v1 proposals as user selections and round-trips v2", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
      producer: ruleProducer,
    });
    const wire = JSON.parse(JSON.stringify(proposal)) as unknown;
    expect(parseTranscriptEditProposal(wire)).toEqual({ ok: true, value: proposal });

    const v1 = { ...proposal, schemaVersion: 1 } as Record<string, unknown>;
    delete v1["producer"];
    delete v1["deletedGaps"];
    const upgraded = parseTranscriptEditProposal(JSON.parse(JSON.stringify(v1)));
    expect(upgraded).toMatchObject({
      ok: true,
      value: { schemaVersion: 2, producer: { id: "user-selection", kind: "user" } },
    });
    const typedV1 = v1 as unknown as TranscriptEditProposalV1;
    expect(upgradeTranscriptEditProposal(typedV1).deletedGaps).toEqual([]);
    expect(() =>
      assertTranscriptEditProposalCurrent({ proposal: typedV1, artifact, projection }),
    ).not.toThrow();
  });

  it.each([
    ["unknown schema", { schemaVersion: 3 }],
    ["not an object", "proposal"],
  ])("rejects malformed wire proposals: %s", (_label, value) => {
    expect(parseTranscriptEditProposal(value)).toMatchObject({
      ok: false,
      error: { code: "invalid_proposal" },
    });
  });

  it("rejects a v2 proposal with a malformed producer", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [occurrenceId("um")],
    });
    const tampered = { ...JSON.parse(JSON.stringify(proposal)), producer: { id: "Bad" } };
    expect(parseTranscriptEditProposal(tampered).ok).toBe(false);
  });

  it("still rejects a v2 proposal against a newer revision", async () => {
    const proposal = await createTranscriptEditProposal({
      ...scope,
      deletedOccurrenceIds: [],
      deletedGaps: [{ clipId: fixtureId(100), sourceStartFrame: 16, sourceEndFrame: 29 }],
    });
    const newer = fixtureProjection([fixtureClip(100, 0, 100)], { revisionNumber: 8 });
    expect(() =>
      assertTranscriptEditProposalCurrent({ proposal, artifact, projection: newer }),
    ).toThrow("stale project revision");
  });
});
