import { describe, expect, it } from "vitest";

import {
  err,
  maxProducedEdits,
  ok,
  parseProducerId,
  provenanceOf,
  runProposalProducer,
  type ProducedEdit,
  type ProducerId,
  type ProposalProducer,
} from "./proposal-producer.js";
import { fixtureArtifact, fixtureProjection, fixtureScope } from "./proposal-test-fixtures.js";

const input = fixtureScope(
  fixtureArtifact([{ startUs: 100_000, endUs: 200_000 }]),
  fixtureProjection(),
);

function producer(
  produce: ProposalProducer["produce"],
  overrides: Partial<Pick<ProposalProducer, "id" | "version">> = {},
): ProposalProducer {
  return {
    id: overrides.id ?? ("test-rule" as ProducerId),
    version: overrides.version ?? "1.0.0",
    kind: "rule",
    parameters: { zeta: 1, alpha: ["b", "a"] },
    produce,
  };
}

const words = (editId: string): ProducedEdit => ({
  kind: "delete-words",
  editId,
  occurrenceIds: ["occ"],
  reason: "test",
});

describe("proposal producer contract", () => {
  it("returns edits sorted by id", async () => {
    const result = await runProposalProducer(
      producer(async () => ok([words("b"), words("a")])),
      input,
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: [words("a"), words("b")] });
  });

  it.each([
    ["duplicate ids", [words("a"), words("a")]],
    ["empty word list", [{ ...words("a"), occurrenceIds: [] }]],
    [
      "inverted gap",
      [
        {
          kind: "delete-gap",
          editId: "g",
          clipId: "c",
          sourceStartFrame: 5,
          sourceEndFrame: 5,
          reason: "x",
        },
      ],
    ],
    ["too many edits", Array.from({ length: maxProducedEdits + 1 }, (_, i) => words(`e${i}`))],
  ] as const)("rejects malformed output: %s", async (_label, edits) => {
    const result = await runProposalProducer(
      producer(async () => ok(edits as readonly ProducedEdit[])),
      input,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_output" } });
  });

  it("reports cancellation before and after producing", async () => {
    const before = new AbortController();
    before.abort();
    let called = false;
    const early = await runProposalProducer(
      producer(async () => {
        called = true;
        return ok([]);
      }),
      input,
      before.signal,
    );
    expect(early).toEqual(err({ code: "cancelled" }));
    expect(called).toBe(false);

    const during = new AbortController();
    const late = await runProposalProducer(
      producer(async () => {
        during.abort();
        return ok([words("a")]);
      }),
      input,
      during.signal,
    );
    expect(late).toEqual(err({ code: "cancelled" }));
  });

  it("turns thrown errors into producer_failed", async () => {
    const result = await runProposalProducer(
      producer(async () => {
        throw new Error("boom");
      }),
      input,
      new AbortController().signal,
    );
    expect(result).toEqual(err({ code: "producer_failed", message: "boom" }));
  });

  it("passes producer errors through unchanged", async () => {
    const failure = err({ code: "invalid_input" as const, message: "no words" });
    const result = await runProposalProducer(
      producer(async () => failure),
      input,
      new AbortController().signal,
    );
    expect(result).toBe(failure);
  });

  it("rejects malformed producer identity", async () => {
    const result = await runProposalProducer(
      producer(async () => ok([]), { id: "Bad Id" as ProducerId }),
      input,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(parseProducerId("silence-gap").ok).toBe(true);
    expect(parseProducerId("Silence").ok).toBe(false);
  });

  it("captures provenance with canonically ordered parameters", () => {
    const provenance = provenanceOf(producer(async () => ok([])));
    expect(provenance).toEqual({
      id: "test-rule",
      version: "1.0.0",
      kind: "rule",
      parameters: { alpha: ["b", "a"], zeta: 1 },
    });
    expect(Object.keys(provenance.parameters)).toEqual(["alpha", "zeta"]);
    expect(Object.isFrozen(provenance)).toBe(true);
  });
});
