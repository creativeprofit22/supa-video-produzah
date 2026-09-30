// @vitest-environment jsdom

import type { CommandGroupRequest } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FirstCutApplyOutcome } from "../use-video-project";
import { ProducePanel } from "./ProducePanel";
import {
  explainer,
  podcast,
  podcastARoll,
  podcastArtifact,
  projectionFor,
  receiptsBackend,
  splitPodcast,
} from "./produce-panel-fixtures";

afterEach(cleanup);

function explainerScript(): string {
  if (explainer.source.workflow !== "explainer") throw new Error("explainer fixture");
  return explainer.source.script;
}

function renderExplainer(
  onApply: (request: CommandGroupRequest) => Promise<FirstCutApplyOutcome> = vi.fn(
    async (): Promise<FirstCutApplyOutcome> => ({ ok: true }),
  ),
) {
  const backend = receiptsBackend(explainer.receipts);
  const view = render(
    <ProducePanel
      projection={projectionFor(explainer)}
      aRoll={null}
      artifact={null}
      intendedUse={explainer.intendedUse}
      disabled={false}
      onApply={onApply}
      backend={backend}
      now={() => explainer.nowMs}
    />,
  );
  return { backend, onApply, view };
}

async function planExplainer(): Promise<HTMLElement> {
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "es" } });
  fireEvent.change(screen.getByRole("textbox", { name: /Script/ }), {
    target: { value: explainerScript() },
  });
  fireEvent.click(screen.getByRole("button", { name: "Plan first cut" }));
  return screen.findByRole("list", { name: "First cut beats" });
}

describe("ProducePanel", () => {
  it("plans a reviewable explainer cut with explanations and never offers unknown-license media", async () => {
    const { backend } = renderExplainer();
    const beats = await planExplainer();
    expect(backend.calls).toEqual([explainer.projectId]);
    const rows = within(beats)
      .getAllByRole("listitem")
      .filter((row) => row.classList.contains("first-cut-beat"));
    expect(rows).toHaveLength(9);
    expect(screen.getByText(/of 9 beats covered/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Why beat 3 uses this shot" })).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("kayak rapids.mp4")).toBeTruthy();
    expect(
      within(rows[7] as HTMLElement).getByText(/No rights-safe media shows: ciudad/),
    ).toBeTruthy();
    // Unknown-license stock appears only in the skipped-media audit, never as a choice.
    for (const select of screen.getAllByRole("combobox", { name: /Shot for beat/ })) {
      const options = within(select)
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");
      expect(options.some((label) => label.startsWith("snow river.webm"))).toBe(false);
    }
    expect(
      screen.getAllByText(/snow river\.webm: license-unknown|snow river\.webm: use-blocked/).length,
    ).toBeGreaterThan(0);
  });

  it("warns before applying that the first cut leaves the project unexportable, without blocking apply", async () => {
    renderExplainer();
    await planExplainer();
    const notice = await screen.findByText(/After applying, this project can’t be exported yet/);
    expect(notice.closest("[role='status']")).not.toBeNull();
    expect(notice.textContent).toContain("exactly one direct-asset clip");
    expect(notice.textContent).toContain("undo in one step");
    expect(
      (screen.getByRole("button", { name: "Apply first cut" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  // The panel has no user tags, so the "nieve" beat stays unresolved here (the golden fixture tags it).
  it("applies one command group that reflects reviewer overrides", async () => {
    const requests: CommandGroupRequest[] = [];
    const onApply = vi.fn(async (request: CommandGroupRequest): Promise<FirstCutApplyOutcome> => {
      requests.push(request);
      return { ok: true };
    });
    renderExplainer(onApply);
    await planExplainer();
    fireEvent.change(screen.getByRole("combobox", { name: "Shot for beat 2" }), {
      target: { value: "unresolved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply first cut" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [request] = requests;
    expect(request?.baseRevision).toBe(explainer.projectRevision);
    expect(request?.commands.map((command) => command.type)).toEqual([
      "InsertTrack",
      "InsertTrack",
      "AddMarker",
      "AddMarker",
      "AddMarker",
      "AddMarker",
    ]);
    expect(
      await screen.findByText(/First cut added on new tracks \(3 shots, 4 unresolved markers\)/),
    ).toBeTruthy();
  });

  it("shows the apply failure and keeps the proposal for review", async () => {
    renderExplainer(
      vi.fn(
        async () =>
          ({
            ok: false,
            message: "The project changed since this first cut was planned. Re-plan it.",
          }) as const,
      ),
    );
    await planExplainer();
    fireEvent.click(screen.getByRole("button", { name: "Apply first cut" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Re-plan it");
    expect(screen.getByRole("list", { name: "First cut beats" })).toBeTruthy();
  });

  it("blocks applying a plan made against an older revision", async () => {
    const onApply = vi.fn(async (): Promise<FirstCutApplyOutcome> => ({ ok: true }));
    const { view, backend } = renderExplainer(onApply);
    await planExplainer();
    const moved = projectionFor(explainer);
    view.rerender(
      <ProducePanel
        projection={{
          ...moved,
          revision: { ...moved.revision, number: moved.revision.number + 1 },
        }}
        aRoll={null}
        artifact={null}
        intendedUse={explainer.intendedUse}
        disabled={false}
        onApply={onApply}
        backend={backend}
        now={() => explainer.nowMs}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Re-plan it");
    expect(
      (screen.getByRole("button", { name: "Apply first cut" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("reports an empty script without calling the rights backend", async () => {
    const { backend } = renderExplainer();
    fireEvent.click(screen.getByRole("button", { name: "Plan first cut" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Write at least one sentence");
    expect(backend.calls).toEqual([]);
  });

  it("plans a podcast cut from the A-roll transcript", async () => {
    const backend = receiptsBackend(podcast.receipts);
    render(
      <ProducePanel
        projection={projectionFor(podcast)}
        aRoll={podcastARoll()}
        artifact={await podcastArtifact()}
        intendedUse={podcast.intendedUse}
        disabled={false}
        onApply={vi.fn(async () => ({ ok: true }) as const)}
        backend={backend}
        now={() => podcast.nowMs}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Podcast from the A-roll transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan first cut" }));
    await screen.findByRole("list", { name: "First cut beats" });
    expect(screen.getAllByText(/Covered by A-roll/)).toHaveLength(3);
    expect(screen.getByText("river drone.mp4")).toBeTruthy();
  });

  it("locks the language to the transcript's requested language in podcast mode", async () => {
    const artifact = await podcastArtifact();
    expect(artifact.configuration.requestedLanguage).toBe("de");
    render(
      <ProducePanel
        projection={projectionFor(podcast)}
        aRoll={podcastARoll()}
        artifact={artifact}
        intendedUse={podcast.intendedUse}
        disabled={false}
        onApply={vi.fn(async () => ({ ok: true }) as const)}
        backend={receiptsBackend(podcast.receipts)}
        now={() => podcast.nowMs}
      />,
    );
    const select = (): HTMLSelectElement =>
      screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
    expect(select().disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Podcast from the A-roll transcript" }));
    expect(select().disabled).toBe(true);
    expect(select().value).toBe("de");
    fireEvent.click(screen.getByRole("button", { name: "Plan first cut" }));
    await screen.findByRole("list", { name: "First cut beats" });
    expect(screen.getAllByText(/Covered by A-roll/)).toHaveLength(3);
    expect(screen.getByText("river drone.mp4")).toBeTruthy();
  });

  it("plans a podcast cut across every fragment of a split A-roll", async () => {
    const { projection, aRoll } = splitPodcast(210);
    render(
      <ProducePanel
        projection={projection}
        aRoll={aRoll}
        artifact={await podcastArtifact()}
        intendedUse={podcast.intendedUse}
        disabled={false}
        onApply={vi.fn(async () => ({ ok: true }) as const)}
        backend={receiptsBackend(podcast.receipts)}
        now={() => podcast.nowMs}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Podcast from the A-roll transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan first cut" }));
    const beats = await screen.findByRole("list", { name: "First cut beats" });
    const rows = within(beats)
      .getAllByRole("listitem")
      .filter((row) => row.classList.contains("first-cut-beat"));
    // The second fragment (after 7.0 s) is planned too, through the end of the A-roll.
    const last = rows.at(-1) as HTMLElement;
    expect(within(last).getByText(/18\.2 s/)).toBeTruthy();
    expect(within(last).getByText("Danke fürs Zuhören und bis bald.")).toBeTruthy();
    expect(screen.getByText("Willkommen zurück zu unserer Sendung.")).toBeTruthy();
    expect(screen.getAllByText(/Covered by A-roll/)).toHaveLength(3);
  });
});
