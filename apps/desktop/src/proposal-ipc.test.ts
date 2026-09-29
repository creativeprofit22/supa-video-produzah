import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAgentProposalsEnabled,
  listProposals,
  markProposalStale,
  rejectProposal,
  restoreBeforeProposal,
} from "./proposal-ipc";
import { VideoIpcResponseError } from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

describe("proposal IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it.each([
    ["enabled", { enabled: true }, true],
    ["disabled", { enabled: false }, false],
    ["malformed", { enabled: "yes" }, false],
  ])("reads the feature switch: %s", async (_label, response, expected) => {
    invokeMock.mockResolvedValueOnce(response);
    await expect(getAgentProposalsEnabled()).resolves.toBe(expected);
    expect(invokeMock).toHaveBeenCalledWith("video_agent_proposals_status", undefined);
  });

  it("keeps the feature off when the native command is missing", async () => {
    invokeMock.mockRejectedValueOnce("unknown command");
    await expect(getAgentProposalsEnabled()).resolves.toBe(false);
  });

  it("validates listings and surfaces the disabled error as a domain error", async () => {
    invokeMock.mockResolvedValueOnce({ proposals: [], audit: [], storeDiscarded: false });
    await expect(listProposals(id(1))).resolves.toEqual({
      proposals: [],
      audit: [],
      storeDiscarded: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith("video_list_proposals", { projectId: id(1) });

    invokeMock.mockResolvedValueOnce({ proposals: "nope" });
    await expect(listProposals(id(1))).rejects.toBeInstanceOf(VideoIpcResponseError);

    invokeMock.mockRejectedValueOnce({
      code: "invalid_command",
      message: "Edit proposals are turned off",
      details: { category: "feature_disabled" },
    });
    await expect(rejectProposal(id(1), id(2))).rejects.toMatchObject({
      code: "invalid_command",
      details: { category: "feature_disabled" },
    });
  });

  it("marks a proposal stale natively and validates the returned record", async () => {
    invokeMock.mockResolvedValueOnce({ status: "nope" });
    await expect(markProposalStale(id(1), id(2), "Project changed")).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
    expect(invokeMock).toHaveBeenLastCalledWith("video_mark_proposal_stale", {
      projectId: id(1),
      proposalId: id(2),
      reason: "Project changed",
    });
  });

  it("passes restore arguments through", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await expect(restoreBeforeProposal(id(1), id(2), id(3))).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("video_restore_before_proposal", {
      projectId: id(1),
      proposalId: id(2),
      operationId: id(3),
    });
  });
});
