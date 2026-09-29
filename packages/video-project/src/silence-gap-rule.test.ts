import { describe, expect, it } from "vitest";

import { produceProposal, proposalFromEdits } from "./produce-proposal.js";
import { provenanceOf } from "./proposal-producer.js";
import { rangeIdOf } from "./proposal-lifecycle.js";
import {
  fixtureArtifact,
  fixtureClip,
  fixtureId,
  fixtureProjection,
  fixtureScope,
  type FixtureWord,
} from "./proposal-test-fixtures.js";
import { createSilenceGapRule, findSilenceGaps } from "./silence-gap-rule.js";
import { projectTranscriptToTimeline } from "./transcript-edit.js";

// Fixture rate is 10 fps: one frame is 100 ms.
function gapsFor(
  words: readonly FixtureWord[],
  options = { minGapMs: 800, paddingMs: 100 },
): unknown {
  const scope = fixtureScope(fixtureArtifact(words), fixtureProjection());
  const result = findSilenceGaps(
    projectTranscriptToTimeline(scope).occurrences,
    options,
    new AbortController().signal,
  );
  if (!result.ok) return result.error;
  return result.value.map((edit) =>
    edit.kind === "delete-gap" ? [edit.sourceStartFrame, edit.sourceEndFrame] : edit.kind,
  );
}

describe("silence-gap rule", () => {
  it.each([
    ["no words", [], []],
    ["single word", [{ startUs: 0, endUs: 500_000 }], []],
    [
      "pause below threshold",
      [
        { startUs: 0, endUs: 500_000 },
        { startUs: 1_200_000, endUs: 1_500_000 },
      ],
      [],
    ],
    [
      "pause at threshold, padded",
      [
        { startUs: 0, endUs: 500_000 },
        { startUs: 1_300_000, endUs: 1_500_000 },
      ],
      [[6, 12]],
    ],
    [
      "two long pauses",
      [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 3_000_000, endUs: 4_000_000 },
        { startUs: 6_000_000, endUs: 7_000_000 },
      ],
      [
        [11, 29],
        [41, 59],
      ],
    ],
    [
      "overlapping words do not create a false gap",
      [
        { startUs: 0, endUs: 3_000_000 },
        { startUs: 500_000, endUs: 1_000_000 },
        { startUs: 3_200_000, endUs: 3_500_000 },
      ],
      [],
    ],
  ] as const)("%s", (_label, words, expected) => {
    expect(gapsFor(words)).toEqual(expected);
  });

  it.each([
    ["zero threshold", { minGapMs: 0, paddingMs: 0 }],
    ["padding swallows the gap", { minGapMs: 400, paddingMs: 200 }],
    ["negative padding", { minGapMs: 800, paddingMs: -1 }],
    ["not finite", { minGapMs: Number.NaN, paddingMs: 0 }],
  ])("rejects invalid options: %s", (_label, options) => {
    expect(gapsFor([], options)).toMatchObject({ code: "invalid_input" });
  });

  it("is deterministic and honours cancellation", () => {
    const words = [
      { startUs: 0, endUs: 1_000_000 },
      { startUs: 3_000_000, endUs: 4_000_000 },
    ];
    expect(gapsFor(words)).toEqual(gapsFor(words));
    const controller = new AbortController();
    controller.abort();
    const scope = fixtureScope(fixtureArtifact(words), fixtureProjection());
    expect(
      findSilenceGaps(
        projectTranscriptToTimeline(scope).occurrences,
        { minGapMs: 800, paddingMs: 100 },
        controller.signal,
      ),
    ).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  it("produces a proposal attributed to the rule", async () => {
    const scope = fixtureScope(
      fixtureArtifact([
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 3_000_000, endUs: 4_000_000 },
      ]),
      fixtureProjection([fixtureClip(100, 0, 100)]),
    );
    const result = await produceProposal(
      createSilenceGapRule({ minGapMs: 800, paddingMs: 100 }),
      scope,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposal.producer).toEqual({
      id: "silence-gap",
      version: "1",
      kind: "rule",
      parameters: { minGapMs: 800, paddingMs: 100 },
    });
    expect(result.value.proposal.deletedGaps).toEqual([
      { clipId: fixtureId(100), sourceStartFrame: 11, sourceEndFrame: 29 },
    ]);
    const [range] = result.value.proposal.deletedRanges;
    expect(range).toBeDefined();
    if (range === undefined) return;
    expect(result.value.proposal.reasons).toEqual([
      { rangeId: rangeIdOf(range), text: "Pause of about 2000 ms" },
    ]);
  });

  it("keeps the proposal id the same whatever the reason says", async () => {
    const scope = fixtureScope(
      fixtureArtifact([
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 3_000_000, endUs: 4_000_000 },
      ]),
      fixtureProjection([fixtureClip(100, 0, 100)]),
    );
    const edit = (reason: string) =>
      [
        {
          kind: "delete-gap",
          editId: "gap-1",
          clipId: fixtureId(100),
          sourceStartFrame: 11,
          sourceEndFrame: 29,
          reason,
        },
      ] as const;
    const producer = provenanceOf(createSilenceGapRule());
    const first = await proposalFromEdits(scope, edit("one"), producer);
    const second = await proposalFromEdits(scope, edit("two"), producer);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.proposalId).toBe(second.value.proposalId);
    expect(first.value.reasons).not.toEqual(second.value.reasons);
  });

  it("reports no_edits when there is nothing to cut", async () => {
    const scope = fixtureScope(
      fixtureArtifact([{ startUs: 0, endUs: 1_000_000 }]),
      fixtureProjection(),
    );
    const result = await produceProposal(
      createSilenceGapRule(),
      scope,
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: false, error: { code: "no_edits" } });
  });
});
