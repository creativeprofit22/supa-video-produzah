import { z } from "zod";

import {
  AGENT_GRAPHICS_MAX_ITEMS,
  agentGraphicsDescriptionSchema,
} from "./agent-graphics-description.js";
import { commandGroupRequestSchema } from "./project-commands-v2.js";
import { projectRevisionDescriptorV2Schema } from "./project-revision.js";
import { projectUuidSchema } from "./project.js";
import { mediaContentIdentityV1Schema } from "./source-content.js";
import { rationalTimeSchema } from "./time.js";

/**
 * Most canonical-JSON bytes a proposal's command group may take. Mirrors `MAX_COMMAND_GROUP_BYTES`
 * in apps/desktop/src-tauri/src/video/project/types.rs.
 */
export const MAX_PROPOSAL_COMMAND_GROUP_BYTES = 1024 * 1024;
/**
 * Most canonical-JSON bytes a whole proposal may take. Mirrors `MAX_PROPOSAL_BYTES` in
 * apps/desktop/src-tauri/src/video/project/proposal.rs.
 */
export const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;

const boundedString = z.string().min(1).max(1_024);
const nonNegativeInteger = z.number().int().safe().nonnegative();

export const producerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const producerParameterValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(64)).max(256).readonly(),
]);

export const producerProvenanceSchema = z
  .object({
    id: producerIdSchema,
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
    kind: z.enum(["user", "rule", "model"]),
    parameters: z.record(z.string().max(64), producerParameterValueSchema).readonly(),
  })
  .strict();
export type ProducerProvenanceWire = z.infer<typeof producerProvenanceSchema>;

const frameRangeSchema = z
  .object({ start: rationalTimeSchema, end: rationalTimeSchema })
  .strict()
  .refine((range) => range.end.value >= range.start.value, { message: "Range end precedes start" });

const wordSnapshotSchema = z
  .object({
    occurrenceId: boundedString,
    wordId: boundedString,
    text: z.string().max(1_024),
    sourceStartUs: nonNegativeInteger,
    sourceEndUs: nonNegativeInteger,
  })
  .strict();

const keptRangeShape = {
  clipId: projectUuidSchema,
  assetId: projectUuidSchema,
  sourceRange: frameRangeSchema,
  originalTimelineRange: frameRangeSchema,
  previewTimelineRange: frameRangeSchema,
};

const proposalBaseShape = {
  proposalId: projectUuidSchema,
  artifactIdentityKey: z.string().regex(/^[0-9a-f]{64}$/),
  sourceIdentity: mediaContentIdentityV1Schema,
  projectId: projectUuidSchema,
  projectRevision: projectRevisionDescriptorV2Schema,
  sequenceId: projectUuidSchema,
  trackId: projectUuidSchema,
  selectedOccurrenceIds: z.array(boundedString).max(10_000),
  assetIdentities: z
    .array(
      z
        .object({ assetId: projectUuidSchema, contentIdentity: mediaContentIdentityV1Schema })
        .strict(),
    )
    .max(100),
  selectedWords: z.array(wordSnapshotSchema).max(10_000),
  keptRanges: z.array(z.object(keptRangeShape).strict()).max(10_000),
  deletedRanges: z
    .array(
      z
        .object({ ...keptRangeShape, selectedWords: z.array(wordSnapshotSchema).max(10_000) })
        .strict(),
    )
    .min(1)
    .max(1_000),
  commandGroup: commandGroupRequestSchema,
};

export const transcriptEditGapSelectionSchema = z
  .object({
    clipId: projectUuidSchema,
    sourceStartFrame: nonNegativeInteger,
    sourceEndFrame: nonNegativeInteger,
  })
  .strict()
  .refine((gap) => gap.sourceEndFrame > gap.sourceStartFrame, { message: "Empty gap" });

export const transcriptEditProposalV1WireSchema = z
  .object({ schemaVersion: z.literal(1), ...proposalBaseShape })
  .strict();

/** Why a producer proposed one cut, keyed by the cut's range id. Display only. */
export const proposalReasonSchema = z
  .object({ rangeId: boundedString, text: z.string().min(1).max(280) })
  .strict();

export const transcriptEditProposalV2WireSchema = z
  .object({
    schemaVersion: z.literal(2),
    ...proposalBaseShape,
    producer: producerProvenanceSchema,
    deletedGaps: z.array(transcriptEditGapSelectionSchema).max(1_000),
    reasons: z.array(proposalReasonSchema).max(1_000).optional(),
  })
  .strict();

/** Accepts both proposal schema versions; callers upgrade v1 to v2. */
export const transcriptEditProposalWireSchema = z.discriminatedUnion("schemaVersion", [
  transcriptEditProposalV1WireSchema,
  transcriptEditProposalV2WireSchema,
]);
export type TranscriptEditProposalWire = z.infer<typeof transcriptEditProposalWireSchema>;

/**
 * Graphics proposal: agent-authored graphics clips offered for review (see CONTEXT.md and
 * docs/adr/0005-agent-graphics-proposals.md). Each item maps 1:1 to one `AddGraphicsClip` in the
 * command group; an optional leading `InsertTrack` creates the empty graphics track first.
 */
export const graphicsProposalItemSchema = z
  .object({
    itemId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    label: z.string().min(1).max(280),
    graphicsClipId: projectUuidSchema,
  })
  .strict();
export type GraphicsProposalItem = z.infer<typeof graphicsProposalItemSchema>;

export const graphicsProposalV1WireSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalKind: z.literal("graphics"),
    proposalId: projectUuidSchema,
    projectId: projectUuidSchema,
    projectRevision: projectRevisionDescriptorV2Schema,
    sequenceId: projectUuidSchema,
    trackId: projectUuidSchema,
    producer: producerProvenanceSchema,
    description: agentGraphicsDescriptionSchema,
    items: z.array(graphicsProposalItemSchema).min(1).max(AGENT_GRAPHICS_MAX_ITEMS),
    commandGroup: commandGroupRequestSchema,
  })
  .strict();
export type GraphicsProposalWire = z.infer<typeof graphicsProposalV1WireSchema>;

/** Any proposal the native store holds: transcript cuts (v2) or graphics (v1). */
export const agentProposalWireSchema = z.union([
  transcriptEditProposalV2WireSchema,
  graphicsProposalV1WireSchema,
]);
export type AgentProposalWire = z.infer<typeof agentProposalWireSchema>;

export function isGraphicsProposalWire(
  proposal: AgentProposalWire,
): proposal is GraphicsProposalWire {
  return "proposalKind" in proposal && proposal.proposalKind === "graphics";
}

// ---- Native proposal store, as returned over IPC -------------------------

export const nativeProposalStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
  "expired",
  "stale",
  "restored",
]);
export type NativeProposalStatus = z.infer<typeof nativeProposalStatusSchema>;

export const storedProposalSchema = z
  .object({
    proposalId: projectUuidSchema,
    producer: producerProvenanceSchema,
    sequenceId: projectUuidSchema,
    trackId: projectUuidSchema,
    baseRevision: projectRevisionDescriptorV2Schema,
    status: nativeProposalStatusSchema,
    statusReason: z.string().max(512).nullable(),
    createdAtMs: nonNegativeInteger,
    expiresAtMs: nonNegativeInteger,
    appliedGroupId: projectUuidSchema.nullable(),
    preApplyRevision: projectRevisionDescriptorV2Schema.nullable(),
    approvedRangeIds: z.array(boundedString).max(1_000),
    restoreOperationId: projectUuidSchema.nullable(),
    restoreSteps: nonNegativeInteger,
    proposal: agentProposalWireSchema,
  })
  .strict();
export type StoredProposal = z.infer<typeof storedProposalSchema>;

export const proposalAuditSchema = z
  .object({
    action: z.enum(["applied", "rejected", "expired", "stale", "restored"]),
    proposalId: projectUuidSchema,
    appliedProposalId: projectUuidSchema.nullable(),
    producer: producerProvenanceSchema,
    approvedRangeIds: z.array(boundedString).max(1_000),
    baseRevision: nonNegativeInteger,
    resultingRevision: nonNegativeInteger.nullable(),
    affectedRanges: z.array(frameRangeSchema).max(1_000),
    atMs: nonNegativeInteger,
  })
  .strict();
export type ProposalAudit = z.infer<typeof proposalAuditSchema>;

export const proposalListingSchema = z
  .object({
    proposals: z.array(storedProposalSchema).max(256),
    audit: z.array(proposalAuditSchema).max(500),
    storeDiscarded: z.boolean(),
  })
  .strict();
export type ProposalListing = z.infer<typeof proposalListingSchema>;

export const agentProposalsSwitchSchema = z.object({ enabled: z.boolean() }).strict();
