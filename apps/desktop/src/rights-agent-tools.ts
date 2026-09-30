import {
  mediaKindSchema,
  providerIdSchema,
  providerItemIdSchema,
  usePolicyProfileSchema,
  type RightsAcquireResponse,
  type RightsCandidate,
  type UsePolicyProfile,
} from "@supa-video/contracts";
import { z } from "zod";

import type { RightsBackend } from "./rights-ipc";

/*
 * Agent-facing rights tools. Agent input is untrusted: every call is validated
 * here, search is read-only, and the proposal tool only queues a request. Bytes
 * are acquired solely by `approveAcquisitionProposal`, which the UI calls when
 * the user approves; Rust then re-fetches the record and applies policy itself.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const searchStockMediaInputSchema = z
  .object({
    providerId: providerIdSchema,
    query: z.string().trim().min(1).max(200),
    mediaKind: mediaKindSchema,
  })
  .strict();

export const proposeStockAcquisitionInputSchema = z
  .object({
    providerId: providerIdSchema,
    providerItemId: providerItemIdSchema,
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export const rightsAgentToolDefinitions = [
  {
    name: "search_stock_media",
    description:
      "Search one stock or public-media provider. Read-only: returns candidates with an advisory license check for the project's intended use. Never downloads anything.",
    inputSchema: z.toJSONSchema(searchStockMediaInputSchema),
  },
  {
    name: "propose_stock_acquisition",
    description:
      "Ask the user to approve acquiring one candidate returned by search_stock_media in this session. Queues a proposal only; nothing is downloaded until the user approves.",
    inputSchema: z.toJSONSchema(proposeStockAcquisitionInputSchema),
  },
] as const;

export type RightsAgentToolName = (typeof rightsAgentToolDefinitions)[number]["name"];

export interface AcquisitionProposal {
  readonly proposalId: string;
  readonly candidate: RightsCandidate;
  readonly rationale: string;
  readonly intendedUse: UsePolicyProfile;
  readonly status: "pending" | "approved" | "rejected" | "failed";
}

export type ToolError =
  | { readonly code: "unknown_tool" }
  | { readonly code: "invalid_input"; readonly message: string }
  | { readonly code: "not_from_search" }
  | { readonly code: "policy_blocked" }
  | { readonly code: "too_many_pending" }
  | { readonly code: "backend_failed"; readonly message: string };

export interface RightsAgentSession {
  readonly execute: (
    name: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<Result<unknown, ToolError>>;
  readonly proposals: () => readonly AcquisitionProposal[];
  readonly approveAcquisitionProposal: (
    proposalId: string,
    projectId: string,
  ) => Promise<Result<RightsAcquireResponse, ToolError>>;
  readonly rejectAcquisitionProposal: (proposalId: string) => boolean;
}

const MAX_PENDING = 10;
const MAX_REMEMBERED_CANDIDATES = 200;

function candidateKey(providerId: string, itemId: string): string {
  return `${providerId}\u0000${itemId}`;
}

function toolSummary(candidate: RightsCandidate): Record<string, unknown> {
  // Only fields the model needs; URLs are omitted so tool output cannot steer fetches.
  return {
    providerId: candidate.providerId,
    providerItemId: candidate.providerItemId,
    mediaKind: candidate.mediaKind,
    title: candidate.title,
    creator: candidate.creator,
    license: candidate.license.code,
    licenseVersion: candidate.license.version,
    durationMs: candidate.durationMs,
    width: candidate.width,
    height: candidate.height,
    advisoryPolicy: candidate.advisoryPolicy,
  };
}

export function createRightsAgentSession(options: {
  readonly backend: Pick<RightsBackend, "searchRights" | "acquireRights">;
  readonly intendedUse: () => UsePolicyProfile;
  readonly newId: () => string;
  readonly onChange?: () => void;
}): RightsAgentSession {
  const seen = new Map<string, RightsCandidate>();
  let proposals: AcquisitionProposal[] = [];
  const changed = () => options.onChange?.();
  const update = (proposalId: string, status: AcquisitionProposal["status"]) => {
    proposals = proposals.map((p) => (p.proposalId === proposalId ? { ...p, status } : p));
    changed();
  };

  const search = async (
    input: unknown,
    signal: AbortSignal,
  ): Promise<Result<unknown, ToolError>> => {
    const parsed = searchStockMediaInputSchema.safeParse(input);
    if (!parsed.success)
      return { ok: false, error: { code: "invalid_input", message: parsed.error.message } };
    const intendedUse = usePolicyProfileSchema.parse(options.intendedUse());
    try {
      const result = await options.backend.searchRights({ ...parsed.data, intendedUse });
      if (signal.aborted)
        return { ok: false, error: { code: "backend_failed", message: "cancelled" } };
      for (const candidate of result.candidates) {
        if (seen.size >= MAX_REMEMBERED_CANDIDATES) {
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
        seen.set(candidateKey(candidate.providerId, candidate.providerItemId), candidate);
      }
      return { ok: true, value: { intendedUse, candidates: result.candidates.map(toolSummary) } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "backend_failed",
          message: error instanceof Error ? error.message : "search failed",
        },
      };
    }
  };

  const propose = (input: unknown): Result<unknown, ToolError> => {
    const parsed = proposeStockAcquisitionInputSchema.safeParse(input);
    if (!parsed.success)
      return { ok: false, error: { code: "invalid_input", message: parsed.error.message } };
    const candidate = seen.get(candidateKey(parsed.data.providerId, parsed.data.providerItemId));
    if (candidate === undefined) return { ok: false, error: { code: "not_from_search" } };
    if (candidate.advisoryPolicy.outcome === "block")
      return { ok: false, error: { code: "policy_blocked" } };
    if (proposals.filter((p) => p.status === "pending").length >= MAX_PENDING)
      return { ok: false, error: { code: "too_many_pending" } };
    const proposal: AcquisitionProposal = {
      proposalId: options.newId(),
      candidate,
      rationale: parsed.data.rationale,
      intendedUse: usePolicyProfileSchema.parse(options.intendedUse()),
      status: "pending",
    };
    proposals = [...proposals, proposal];
    changed();
    return {
      ok: true,
      value: { proposalId: proposal.proposalId, status: "awaiting-user-approval" },
    };
  };

  return {
    execute: async (name, input, signal) => {
      switch (name) {
        case "search_stock_media":
          return search(input, signal);
        case "propose_stock_acquisition":
          return propose(input);
        default:
          return { ok: false, error: { code: "unknown_tool" } };
      }
    },
    proposals: () => proposals,
    approveAcquisitionProposal: async (proposalId, projectId) => {
      const proposal = proposals.find((p) => p.proposalId === proposalId && p.status === "pending");
      if (proposal === undefined)
        return {
          ok: false,
          error: { code: "invalid_input", message: "No pending proposal with that id" },
        };
      update(proposalId, "approved");
      try {
        const acquired = await options.backend.acquireRights({
          providerId: proposal.candidate.providerId,
          providerItemId: proposal.candidate.providerItemId,
          intendedUse: proposal.intendedUse,
          projectId,
        });
        return { ok: true, value: acquired };
      } catch (error) {
        update(proposalId, "failed");
        return {
          ok: false,
          error: {
            code: "backend_failed",
            message: error instanceof Error ? error.message : "acquire failed",
          },
        };
      }
    },
    rejectAcquisitionProposal: (proposalId) => {
      if (!proposals.some((p) => p.proposalId === proposalId && p.status === "pending"))
        return false;
      update(proposalId, "rejected");
      return true;
    },
  };
}
