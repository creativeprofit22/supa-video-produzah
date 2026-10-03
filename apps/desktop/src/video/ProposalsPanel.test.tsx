// @vitest-environment jsdom

import {
  VideoDomainError,
  type CommandResult,
  type ProjectProjection,
} from "@supa-video/contracts";
import { defaultProposalPolicy, isGraphicsProposal } from "@supa-video/project";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProposalBackend } from "../proposal-ipc";
import { ProposalsPanel, type ProposalTimelineRange } from "./ProposalsPanel";
import { artifact, fakeBackend, id, projection, target } from "./proposals-panel-fixtures";

afterEach(cleanup);

async function renderPanel(backend: ProposalBackend, autoDetectedLanguage = false) {
  const runEdit = vi.fn(async (run: (projectId: string) => Promise<readonly CommandResult[]>) => {
    // Mirrors the hook's runProposalEdit: it catches native failures and reports them.
    try {
      await run(projection.projectId);
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : null } as const;
    }
  });
  const onPreviewRanges = vi.fn<(ranges: readonly ProposalTimelineRange[]) => void>();
  const loaded = await artifact();
  const transcript = autoDetectedLanguage
    ? { ...loaded, configuration: { ...loaded.configuration, requestedLanguage: null } }
    : loaded;
  const panel = (current: ProjectProjection) => (
    <ProposalsPanel
      projection={current}
      target={target}
      artifact={transcript}
      disabled={false}
      runEdit={runEdit}
      onPreviewRanges={onPreviewRanges}
      backend={backend}
      now={() => 1_000}
      newOperationId={() => id(900)}
    />
  );
  const { rerender } = render(panel(projection));
  return {
    runEdit,
    onPreviewRanges,
    rerender: (current: ProjectProjection) => rerender(panel(current)),
  };
}

describe("ProposalsPanel", () => {
  it("renders nothing while the feature switch is off", async () => {
    const backend = fakeBackend(false);
    await renderPanel(backend);
    await waitFor(() => expect(backend.getAgentProposalsEnabled.calls.length).toBe(1));
    expect(screen.queryByRole("region", { name: "Suggested edits" })).toBeNull();
    expect(backend.listProposals.calls).toEqual([]);
  });

  it("disables filler words and explains why when the transcript language is unknown", async () => {
    await renderPanel(fakeBackend(), true);
    const button = await screen.findByRole("button", { name: "Find filler words" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Filler words need a known transcript language.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Find long pauses" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("finds filler words, shows each cut with its producer, and marks them on the timeline", async () => {
    const backend = fakeBackend();
    const { onPreviewRanges } = await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));

    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(within(group).getByText(/: "um"$/)).toBeTruthy();
    expect(within(group).getByText(/: "uh"$/)).toBeTruthy();
    // Each cut explains itself, and the checkbox points at that explanation.
    const reason = within(group).getByText('Filler word "um" (en)');
    expect(within(group).getByText('Filler word "uh" (en)')).toBeTruthy();
    expect(boxes[0]?.getAttribute("aria-describedby")).toBe(reason.id);
    expect(backend.submitProposal.calls).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("2 suggested cuts");
    await waitFor(() =>
      expect(onPreviewRanges).toHaveBeenLastCalledWith([
        { trackId: target.trackId, startFrame: 5, endFrame: 9, accepted: true },
        { trackId: target.trackId, startFrame: 15, endFrame: 19, accepted: true },
      ]),
    );
  });

  it("applies only the ticked cuts as a re-derived proposal", async () => {
    const backend = fakeBackend();
    const { runEdit, onPreviewRanges } = await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));
    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );
    const [first] = within(group).getAllByRole("checkbox");
    fireEvent.click(first as HTMLElement);
    await waitFor(() =>
      expect(onPreviewRanges).toHaveBeenLastCalledWith([
        expect.objectContaining({ startFrame: 5, accepted: false }),
        expect.objectContaining({ startFrame: 15, accepted: true }),
      ]),
    );

    fireEvent.click(within(group).getByRole("button", { name: "Apply 1 of 2" }));
    await waitFor(() => expect(backend.applyProposal.calls).toHaveLength(1));
    expect(runEdit).toHaveBeenCalledTimes(1);
    const [, proposalId, approved] = backend.applyProposal.calls[0] ?? [];
    const original = backend.submitProposal.calls[0]?.[1];
    expect(proposalId).toBe(original?.proposalId);
    if (approved === undefined || isGraphicsProposal(approved))
      throw new Error("expected a transcript proposal");
    expect(approved.selectedWords.map(({ text }) => text)).toEqual(["uh"]);
    expect(approved?.producer.id).toBe("filler-words");
    expect(await screen.findByText(/Proposal applied/)).toBeTruthy();

    // Once applied it moves to Recent with a restore action.
    const restore = await screen.findByRole("button", { name: "Restore to before" });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(backend.restoreBeforeProposal.calls).toEqual([
        [projection.projectId, original?.proposalId, id(900)],
      ]),
    );
  });

  it("disables apply when nothing is ticked, and rejects the whole proposal", async () => {
    const backend = fakeBackend();
    await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));
    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );
    for (const box of within(group).getAllByRole("checkbox")) fireEvent.click(box);
    expect(
      (within(group).getByRole("button", { name: "Apply 0 of 2" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "Reject all" }));
    await waitFor(() => expect(backend.rejectProposal.calls).toHaveLength(1));
    expect(await screen.findByText("Filler words: Rejected")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  });

  it("keeps counting repairs across failed applies and stops at the repair limit", async () => {
    const backend = fakeBackend(true, { applyFails: true });
    const { rerender } = await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));
    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );
    rerender({
      ...projection,
      revision: { ...projection.revision, number: 2, id: id(103), parentId: id(101) },
    });

    const apply = within(group).getByRole("button", { name: "Apply 2 of 2" }) as HTMLButtonElement;
    for (let attempt = 1; attempt <= defaultProposalPolicy.maxRepairs; attempt += 1) {
      await waitFor(() => expect(apply.disabled).toBe(false));
      fireEvent.click(apply);
      await waitFor(() => expect(backend.applyProposal.calls).toHaveLength(attempt));
    }
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);

    expect(await within(group).findByText(/The project changed too much/)).toBeTruthy();
    expect(apply.disabled).toBe(true);
    expect(backend.applyProposal.calls).toHaveLength(defaultProposalPolicy.maxRepairs);
    expect(backend.markProposalStale.calls).toHaveLength(1);
    expect(backend.markProposalStale.calls[0]?.[1]).toBe(backend.applyProposal.calls[0]?.[1]);
    // The native listing now carries the stale status, so it is no longer pending.
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Filler words: 2 cuts" })).toBeNull(),
    );
  });

  it("moves the timeline bands when the clip moved since the proposal was made", async () => {
    const backend = fakeBackend();
    const { onPreviewRanges, rerender } = await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));
    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );
    fireEvent.click(within(group).getAllByRole("checkbox")[0] as HTMLElement);
    await waitFor(() =>
      expect(onPreviewRanges).toHaveBeenLastCalledWith([
        expect.objectContaining({ startFrame: 5, endFrame: 9, accepted: false }),
        expect.objectContaining({ startFrame: 15, endFrame: 19, accepted: true }),
      ]),
    );

    const shift = 7;
    const [sequence] = projection.state.sequences;
    const [track] = sequence?.tracks ?? [];
    if (sequence === undefined || track === undefined || track.kind !== "video")
      throw new Error("fixture lacks a video track");
    const [clip] = track.clips;
    if (clip === undefined) throw new Error("fixture lacks a clip");
    rerender({
      ...projection,
      revision: { ...projection.revision, number: 2, id: id(103), parentId: id(101) },
      state: {
        ...projection.state,
        sequences: [
          {
            ...sequence,
            tracks: [
              {
                ...track,
                clips: [
                  {
                    ...clip,
                    timelineStart: {
                      ...clip.timelineStart,
                      value: clip.timelineStart.value + shift,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    await waitFor(() =>
      expect(onPreviewRanges).toHaveBeenLastCalledWith([
        { trackId: target.trackId, startFrame: 5 + shift, endFrame: 9 + shift, accepted: false },
        { trackId: target.trackId, startFrame: 15 + shift, endFrame: 19 + shift, accepted: true },
      ]),
    );
    expect(within(group).queryByText(/The project changed too much/)).toBeNull();
  });

  it("shows the mapped message when the native side refuses to apply", async () => {
    const backend = fakeBackend(true, {
      applyError: new VideoDomainError("invalid_command", "Native refused", {
        category: "proposal_base_revision",
      }),
    });
    await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find filler words" }));
    const group = await screen.findByRole(
      "group",
      { name: "Filler words: 2 cuts" },
      { timeout: 5_000 },
    );

    fireEvent.click(within(group).getByRole("button", { name: "Apply 2 of 2" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The project changed");
  });

  it("reports when a rule has nothing to suggest", async () => {
    const backend = fakeBackend();
    await renderPanel(backend);
    fireEvent.click(await screen.findByRole("button", { name: "Find long pauses" }));
    expect((await screen.findByRole("status")).textContent).toContain("Nothing to suggest");
    expect(backend.submitProposal.calls).toEqual([]);
  });
});
