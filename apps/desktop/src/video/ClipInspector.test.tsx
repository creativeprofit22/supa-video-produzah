// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClipInspector, type ClipOpacityDraft, type SelectedVideoClip } from "./ClipInspector";

const selection: SelectedVideoClip = {
  sequenceId: "sequence-1",
  trackId: "track-1",
  clipId: "clip-1",
  clipLabel: "camera.mp4",
  trackLabel: "Main video",
  opacityPermille: 425,
  locked: false,
};

function renderInspector(
  overrides: Partial<{
    selection: SelectedVideoClip | null;
    opacityPermille: number | null;
    disabled: boolean;
    saving: boolean;
    error: Error | null;
    onDraftChange: (draft: ClipOpacityDraft) => void;
    onCommit: (draft: ClipOpacityDraft) => void;
  }> = {},
) {
  const props = {
    selection,
    opacityPermille: 425,
    disabled: false,
    saving: false,
    error: null,
    onDraftChange: vi.fn(),
    onCommit: vi.fn(),
    ...overrides,
  };
  render(<ClipInspector {...props} />);
  return props;
}

afterEach(cleanup);

describe("ClipInspector", () => {
  it("shows a focused empty state without an editable control", () => {
    renderInspector({ selection: null, opacityPermille: null });

    expect(screen.getByRole("heading", { name: "Clip inspector" })).not.toBeNull();
    expect(screen.getByText("Select a video clip to edit its appearance.")).not.toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("exposes canonical bounds and percentage text instead of raw permille", () => {
    renderInspector();

    const slider = screen.getByRole("slider", { name: "Opacity" });
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("1000");
    expect(slider.getAttribute("step")).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("42.5%");
    expect(screen.getByText("42.5%", { selector: "output" }).getAttribute("for")).toBe(
      "clip-opacity",
    );
    expect(screen.queryByText("425", { exact: true })).toBeNull();
  });

  it("disables locked and saving controls with specific guidance and status", () => {
    const { rerender } = render(
      <ClipInspector
        selection={{ ...selection, locked: true }}
        opacityPermille={425}
        disabled={false}
        saving={false}
        error={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );

    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Unlock this track to change clip opacity.")).not.toBeNull();

    rerender(
      <ClipInspector
        selection={selection}
        opacityPermille={425}
        disabled
        saving
        error={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Saving opacity").textContent).toBe("Saving opacity");
  });

  it("shows the controller error as an alert while allowing retry", () => {
    renderInspector({ error: new Error("The project revision changed.") });

    expect(screen.getByRole("alert").textContent).toContain("Could not save opacity");
    expect(screen.getByRole("alert").textContent).toContain("The project revision changed.");
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it("drafts continuously but commits once on pointer release", () => {
    const props = renderInspector();
    const slider = screen.getByRole("slider", { name: "Opacity" });

    fireEvent.change(slider, { target: { value: "610" } });
    expect(props.onDraftChange).toHaveBeenLastCalledWith({
      sequenceId: "sequence-1",
      trackId: "track-1",
      clipId: "clip-1",
      opacityPermille: 610,
    });
    expect(props.onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    fireEvent.blur(slider);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith({
      sequenceId: "sequence-1",
      trackId: "track-1",
      clipId: "clip-1",
      opacityPermille: 610,
    });
  });

  it("commits keyboard drafts on Enter or blur without double committing", () => {
    const props = renderInspector();
    const slider = screen.getByRole("slider", { name: "Opacity" });

    fireEvent.change(slider, { target: { value: "500" } });
    fireEvent.keyDown(slider, { key: "Enter" });
    fireEvent.blur(slider);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({ opacityPermille: 500 }),
    );

    fireEvent.change(slider, { target: { value: "250" } });
    fireEvent.blur(slider);
    expect(props.onCommit).toHaveBeenCalledTimes(2);
    expect(props.onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({ opacityPermille: 250 }),
    );
  });
});
