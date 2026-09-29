import {
  agentProposalsSwitchSchema,
  commandResultSchema,
  proposalListingSchema,
  storedProposalSchema,
} from "@supa-video/contracts";
import type { CommandResult, ProposalListing, StoredProposal } from "@supa-video/contracts";
import type { TranscriptEditProposal } from "@supa-video/project";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { normalizeVideoCommandError, VideoIpcResponseError } from "./video-ipc";

/**
 * Outcome of a native proposal edit run under the editor's edit lock.
 * `error` is null when the edit was skipped without a failure (for example the
 * projection changed underneath it), so there is nothing to report.
 */
export type ProposalEditOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: Error | null };

async function invokeProposalCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw normalizeVideoCommandError(error);
  }
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new VideoIpcResponseError();
  return result.data;
}

/** The `agentProposals` feature switch. Off unless the native side enables it. */
export async function getAgentProposalsEnabled(): Promise<boolean> {
  try {
    const response = await invokeProposalCommand("video_agent_proposals_status");
    return parsed(agentProposalsSwitchSchema.safeParse(response)).enabled;
  } catch {
    // Fail closed: an older native build or any error keeps the feature off.
    return false;
  }
}

export async function listProposals(projectId: string): Promise<ProposalListing> {
  const response = await invokeProposalCommand("video_list_proposals", { projectId });
  return parsed(proposalListingSchema.safeParse(response));
}

export async function submitProposal(
  projectId: string,
  proposal: TranscriptEditProposal,
): Promise<StoredProposal> {
  const response = await invokeProposalCommand("video_submit_proposal", { projectId, proposal });
  return parsed(storedProposalSchema.safeParse(response));
}

export async function applyProposal(
  projectId: string,
  proposalId: string,
  approved: TranscriptEditProposal,
): Promise<CommandResult> {
  const response = await invokeProposalCommand("video_apply_proposal", {
    projectId,
    proposalId,
    approved,
  });
  return parsed(commandResultSchema.safeParse(response));
}

export async function rejectProposal(
  projectId: string,
  proposalId: string,
): Promise<StoredProposal> {
  const response = await invokeProposalCommand("video_reject_proposal", { projectId, proposalId });
  return parsed(storedProposalSchema.safeParse(response));
}

export async function markProposalStale(
  projectId: string,
  proposalId: string,
  reason: string,
): Promise<StoredProposal> {
  const response = await invokeProposalCommand("video_mark_proposal_stale", {
    projectId,
    proposalId,
    reason,
  });
  return parsed(storedProposalSchema.safeParse(response));
}

export async function restoreBeforeProposal(
  projectId: string,
  proposalId: string,
  operationId: string,
): Promise<readonly CommandResult[]> {
  const response = await invokeProposalCommand("video_restore_before_proposal", {
    projectId,
    proposalId,
    operationId,
  });
  return parsed(z.array(commandResultSchema).max(10_000).safeParse(response));
}

export interface ProposalBackend {
  readonly getAgentProposalsEnabled: typeof getAgentProposalsEnabled;
  readonly listProposals: typeof listProposals;
  readonly submitProposal: typeof submitProposal;
  readonly applyProposal: typeof applyProposal;
  readonly rejectProposal: typeof rejectProposal;
  readonly markProposalStale: typeof markProposalStale;
  readonly restoreBeforeProposal: typeof restoreBeforeProposal;
}

export const tauriProposalBackend: ProposalBackend = {
  getAgentProposalsEnabled,
  listProposals,
  submitProposal,
  applyProposal,
  rejectProposal,
  markProposalStale,
  restoreBeforeProposal,
};
