// @vitest-environment jsdom

import {
  createRationalTime,
  type CommandResult,
  type ProjectProjection,
} from "@supa-video/contracts";
import { isGraphicsProposal } from "@supa-video/project";
import type { FirstCutBeats } from "@supa-video/produce";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProposalBackend } from "../proposal-ipc";
import { ProposalsPanel } from "./ProposalsPanel";
import {
  artifact,
  fakeBackend,
  id,
  projection as baseProjection,
  rate,
  target,
} from "./proposals-panel-fixtures";

afterEach(cleanup);

// Stretch the fixture's only clip to 30 s so pacing leaves room for a title and an end card.
const [baseSequence] = baseProjection.state.sequences;
const [baseTrack] = baseSequence?.tracks ?? [];
if (baseSequence === undefined || baseTrack?.kind !== "video") throw new Error("fixture shape");
const projection: ProjectProjection = {
  ...baseProjection,
  state: {
    ...baseProjection.state,
    sequences: [
      {
        ...baseSequence,
        tracks: [
          {
            ...baseTrack,
            clips: baseTrack.clips.map((clip) => ({
              ...clip,
              sourceOut: createRationalTime(300, rate),
            })),
          },
        ],
      },
    ],
  },
};

const firstCut: FirstCutBeats = {
  startUs: 0,
  endUs: 30_000_000,
  beats: [{ beat: { order: 0, text: "Hi there again", startUs: 0 } }],
};

async function renderPanel(
  backend: ProposalBackend,
  cut: FirstCutBeats | null = firstCut,
  musicBeatsUs: readonly number[] = [],
) {
  const runEdit = vi.fn(async (run: (projectId: string) => Promise<readonly CommandResult[]>) => {
    try {
      await run(projection.projectId);
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : null } as const;
    }
  });
  let next = 900;
  const transcript = await artifact();
  const panel = (current: ProjectProjection) => (
    <ProposalsPanel
      projection={current}
      target={target}
      artifact={transcript}
      disabled={false}
      runEdit={runEdit}
      firstCut={cut}
      musicBeatsUs={musicBeatsUs}
      backend={backend}
      now={() => 1_000}
      newOperationId={() => id((next += 1))}
    />
  );
  render(panel(projection));
  return { runEdit };
}

async function suggest(recipe: string) {
  fireEvent.change(await screen.findByLabelText("Graphics style"), { target: { value: recipe } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest graphics" }));
}

describe("ProposalsPanel graphics", () => {
  it("hides graphics suggestions until a first cut is on the timeline", async () => {
    await renderPanel(fakeBackend(), null);
    await screen.findByRole("button", { name: "Find filler words" });
    expect(screen.queryByRole("button", { name: "Suggest graphics" })).toBeNull();
  });

  it("offers the three style recipes", async () => {
    await renderPanel(fakeBackend());
    const select = await screen.findByLabelText("Graphics style");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Punchy short-form", "Calm explainer", "Retro"]);
  });

  it("describes the selected style recipe", async () => {
    await renderPanel(fakeBackend());
    const select = await screen.findByLabelText("Graphics style");
    const calm = "Clean type, gentle entrances and generous spacing for tutorials.";
    expect(screen.getByText(calm)).toBeTruthy();
    expect(select.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(select.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(calm);

    fireEvent.change(select, { target: { value: "retro" } });

    const retro = "Serif type, warm colours and playful slide-ins.";
    expect(screen.getByText(retro)).toBeTruthy();
    expect(screen.queryByText(calm)).toBeNull();
    expect(
      document.getElementById(select.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(retro);
  });

  it("submits a graphics proposal for review without changing the project", async () => {
    const backend = fakeBackend();
    const { runEdit } = await renderPanel(backend);
    await suggest("punchy-short-form");

    const group = await screen.findByRole("group", {
      name: "Graphics (Punchy short-form): 2 graphics",
    });
    const submitted = backend.submitProposal.calls[0]?.[1];
    if (submitted === undefined || !isGraphicsProposal(submitted))
      throw new Error("expected a graphics proposal");
    expect(submitted.producer).toMatchObject({ id: "recipe-graphics", kind: "rule" });
    expect(submitted.projectRevision).toEqual(projection.revision);
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(group).getByText(/Title · Hi there again/)).toBeTruthy();
    expect(runEdit).not.toHaveBeenCalled();
    expect(backend.applyProposal.calls).toEqual([]);
  });

  it("applies only the ticked graphics", async () => {
    const backend = fakeBackend();
    const { runEdit } = await renderPanel(backend);
    await suggest("punchy-short-form");
    const group = await screen.findByRole("group", { name: /2 graphics/ });

    const [, endCard] = within(group).getAllByRole("checkbox");
    if (endCard === undefined) throw new Error("expected two items");
    fireEvent.click(endCard);
    fireEvent.click(within(group).getByRole("button", { name: "Apply 1 of 2" }));

    await waitFor(() => expect(backend.applyProposal.calls).toHaveLength(1));
    expect(runEdit).toHaveBeenCalledTimes(1);
    const [, proposalId, approved] = backend.applyProposal.calls[0] ?? [];
    const offered = backend.submitProposal.calls[0]?.[1];
    if (approved === undefined || offered === undefined) throw new Error("missing proposals");
    if (!isGraphicsProposal(approved) || !isGraphicsProposal(offered))
      throw new Error("expected graphics proposals");
    expect(proposalId).toBe(offered.proposalId);
    expect(approved.proposalId).not.toBe(offered.proposalId);
    expect(approved.items.map(({ itemId }) => itemId)).toEqual(["title"]);
    // The kept commands are exactly the offered ones: the track insert and the title clip.
    expect(approved.commandGroup.commands).toEqual(offered.commandGroup.commands.slice(0, 2));
    expect(await screen.findByText(/Proposal applied/)).toBeTruthy();
  });

  it("restores the project to before an applied graphics proposal", async () => {
    const backend = fakeBackend();
    const { runEdit } = await renderPanel(backend);
    await suggest("retro");
    const group = await screen.findByRole("group", { name: /Retro/ });
    fireEvent.click(within(group).getByRole("button", { name: /^Apply \d+ of \d+$/ }));
    await waitFor(() => expect(backend.applyProposal.calls).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: "Restore to before" }));

    await waitFor(() => expect(backend.restoreBeforeProposal.calls).toHaveLength(1));
    expect(runEdit).toHaveBeenCalledTimes(2);
  });

  it("snaps recipe graphics onto a nearby music beat", async () => {
    // Retro: title 0–2.5 s plus a 2.5 s gap, so the second beat at 6 s gets a lower third.
    const cut: FirstCutBeats = {
      ...firstCut,
      beats: [
        ...firstCut.beats,
        { beat: { order: 1, text: "Second point here", startUs: 6_000_000 } },
      ],
    };
    const musicBeatUs = 6_200_000;
    const backend = fakeBackend();
    await renderPanel(backend, cut, [musicBeatUs]);
    await suggest("retro");
    await screen.findByRole("group", { name: /Retro/ });

    const submitted = backend.submitProposal.calls[0]?.[1];
    if (submitted === undefined || !isGraphicsProposal(submitted))
      throw new Error("expected a graphics proposal");
    const lowerThird = submitted.description.items.find(({ id: itemId }) => itemId === "beat-2");
    expect(lowerThird?.atUs).toBe(musicBeatUs);
  });

  it("rejects a graphics proposal without touching the project", async () => {
    const backend = fakeBackend();
    const { runEdit } = await renderPanel(backend);
    await suggest("calm-explainer");
    const group = await screen.findByRole("group", { name: /Calm explainer/ });

    fireEvent.click(within(group).getByRole("button", { name: "Reject all" }));

    await waitFor(() => expect(backend.rejectProposal.calls).toHaveLength(1));
    expect(runEdit).not.toHaveBeenCalled();
    expect(backend.applyProposal.calls).toEqual([]);
  });
});
