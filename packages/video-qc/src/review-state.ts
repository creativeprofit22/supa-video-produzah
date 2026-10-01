/*
 * Response of `video_read_review_state` / `video_record_review_decision`:
 * the manifest, the validated review decisions and the native release
 * decision. Validated at the IPC boundary.
 */
import { qcSha256HexSchema } from "@supa-video/contracts";
import { z } from "zod";
import { renderManifestSchema } from "./manifest.js";
import { reviewDecisionSchema } from "./review-decision.js";

export const releaseDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("releasable"),
    acceptedFindingIds: z.array(qcSha256HexSchema),
    acceptedDecisionIds: z.array(z.uuid()),
  }),
  z.strictObject({
    status: z.literal("blocked"),
    unresolvedFindingIds: z.array(qcSha256HexSchema).min(1),
  }),
]);

export const reviewStateSchema = z.strictObject({
  manifest: renderManifestSchema,
  manifestSha256: qcSha256HexSchema,
  decisions: z.array(reviewDecisionSchema),
  release: releaseDecisionSchema,
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

/** Untrusted decision request; ids, digests and timestamps are native. */
export const reviewDecisionRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("accept_anyway"),
    findingId: qcSha256HexSchema,
    reason: z.string().trim().min(1).max(480),
  }),
  z.strictObject({
    type: z.literal("repair_attempt"),
    findingId: qcSha256HexSchema,
    proposalId: z.string().min(1).max(128),
    outcome: z.enum(["proposed", "applied", "rejected", "undone"]),
  }),
  z.strictObject({ type: z.literal("repair_stopped"), findingId: qcSha256HexSchema }),
]);
export type ReviewDecisionRequest = z.infer<typeof reviewDecisionRequestSchema>;
