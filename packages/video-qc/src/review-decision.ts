/*
 * Review decisions live in the append-only `<output>.review.jsonl` record, one
 * canonical JSON object per line. Each line is bound to exactly one manifest
 * through `outputSha256` and `manifestSha256`.
 */
import { z } from "zod";
import { qcSha256HexSchema as sha256HexSchema } from "@supa-video/contracts";

export const REVIEW_DECISION_SCHEMA_VERSION = 1;
export const ACCEPT_REASON_MAX = 480;
export const REPAIR_ATTEMPT_LIMIT = 3;

const decisionBase = {
  schemaVersion: z.literal(REVIEW_DECISION_SCHEMA_VERSION),
  decisionId: z.uuid(),
  findingId: sha256HexSchema,
  outputSha256: sha256HexSchema,
  manifestSha256: sha256HexSchema,
  recordedAt: z.iso.datetime({ offset: true }),
};

export const reviewDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...decisionBase,
    type: z.literal("accept_anyway"),
    reason: z.string().trim().min(1).max(ACCEPT_REASON_MAX),
  }),
  z.strictObject({
    ...decisionBase,
    type: z.literal("repair_attempt"),
    attempt: z.number().int().min(1).max(REPAIR_ATTEMPT_LIMIT),
    proposalId: z.string().min(1).max(128),
    outcome: z.enum(["proposed", "applied", "rejected", "undone"]),
  }),
  z.strictObject({
    ...decisionBase,
    type: z.literal("repair_stopped"),
    reason: z.enum(["user_stopped", "attempt_limit"]),
  }),
]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
