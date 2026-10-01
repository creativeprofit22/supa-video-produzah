import { describe, expect, it } from "vitest";
import { createFinding } from "./finding.js";
import { evaluateRelease } from "./policy.js";
import { parseReviewRecord, repairProducerFor, repairProgress } from "./review-record.js";
import type { ReviewDecision } from "./review-decision.js";

const STATE = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const OUTPUT = "c".repeat(64);

const blocker = await createFinding({
  kind: "black_frames",
  source: "deterministic",
  subject: "",
  range: { startUs: 0, endUs: 2_000_000 },
  revisionStateHash: STATE,
  severity: "blocker",
  message: "Black frames",
});
const rights = await createFinding({
  kind: "rights_blocked",
  source: "rights",
  subject: "asset",
  range: { startUs: 0, endUs: 1 },
  revisionStateHash: STATE,
  severity: "blocker",
  message: "Rights withdrawn",
});
const binding = { manifestSha256: MANIFEST, outputSha256: OUTPUT, findings: [blocker, rights] };

let counter = 0;
function decision(patch: Partial<ReviewDecision> & Pick<ReviewDecision, "type">): ReviewDecision {
  counter += 1;
  const base = {
    schemaVersion: 1 as const,
    decisionId: `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`,
    findingId: blocker.findingId,
    outputSha256: OUTPUT,
    manifestSha256: MANIFEST,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  if (patch.type === "accept_anyway")
    return { ...base, reason: "Intentional", ...patch } as ReviewDecision;
  if (patch.type === "repair_attempt")
    return {
      ...base,
      attempt: 1,
      proposalId: "p1",
      outcome: "proposed",
      ...patch,
    } as ReviewDecision;
  return { ...base, reason: "user_stopped", ...patch } as ReviewDecision;
}

const lines = (...decisions: ReviewDecision[]): string =>
  decisions.map((item) => `${JSON.stringify(item)}\n`).join("");

describe("review record reader", () => {
  it("reads an empty record and resolves an accepted blocker", () => {
    expect(parseReviewRecord("", binding)).toEqual({ ok: true, value: [] });
    const parsed = parseReviewRecord(lines(decision({ type: "accept_anyway" })), binding);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluateRelease([blocker], parsed.value).status).toBe("releasable");
    }
  });

  it.each<[string, string, string]>([
    ["not json", "nope\n", "malformed_line"],
    ["missing newline", JSON.stringify(decision({ type: "accept_anyway" })), "malformed_line"],
    [
      "unknown field",
      `${JSON.stringify({ ...decision({ type: "accept_anyway" }), approvedBy: "x" })}\n`,
      "malformed_line",
    ],
    [
      "other manifest",
      lines(decision({ type: "accept_anyway", manifestSha256: "d".repeat(64) })),
      "digest_mismatch",
    ],
    [
      "other output",
      lines(decision({ type: "accept_anyway", outputSha256: "d".repeat(64) })),
      "digest_mismatch",
    ],
    [
      "unknown finding",
      lines(decision({ type: "accept_anyway", findingId: "e".repeat(64) })),
      "unknown_finding",
    ],
  ])("fails closed on %s", (_name, text, kind) => {
    const parsed = parseReviewRecord(text, binding);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe(kind);
  });

  it("ignores forged rights overrides", () => {
    const parsed = parseReviewRecord(
      lines(decision({ type: "accept_anyway", findingId: rights.findingId })),
      binding,
    );
    expect(parsed).toEqual({ ok: true, value: [] });
    expect(evaluateRelease([rights], []).status).toBe("blocked");
  });
});

describe("bounded repair", () => {
  it("allows three distinct proposals per finding, then stops", () => {
    const history = ["p1", "p2", "p3"].map((proposalId, index) =>
      decision({ type: "repair_attempt", proposalId, attempt: index + 1 }),
    );
    expect(repairProgress(history.slice(0, 2), blocker.findingId)).toMatchObject({
      attempts: 2,
      canAttempt: true,
    });
    expect(repairProgress(history, blocker.findingId)).toMatchObject({
      attempts: 3,
      canAttempt: false,
    });
  });

  it("counts outcome updates of the same proposal once and honours an explicit stop", () => {
    const history = [
      decision({ type: "repair_attempt", proposalId: "p1" }),
      decision({ type: "repair_attempt", proposalId: "p1", outcome: "applied" }),
      decision({ type: "repair_stopped" }),
    ];
    expect(repairProgress(history, blocker.findingId)).toEqual({
      attempts: 1,
      stopped: true,
      accepted: false,
      canAttempt: false,
    });
  });

  it.each([
    ["silence", "silence-gap"],
    ["black_frames", null],
    ["rights_blocked", null],
  ] as const)("repair producer for %s is %s", (kind, producer) => {
    expect(repairProducerFor(kind)).toBe(producer);
  });
});
