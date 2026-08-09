// @vitest-environment jsdom

import { DEFAULT_CLIP_TRANSFORM_GEOMETRY } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClipInspector,
  type ClipOpacityDraft,
  type ClipTransformDraft,
  type SelectedVideoClip,
} from "./ClipInspector";

const selection: SelectedVideoClip = {
  sequenceId: "sequence-1",
  trackId: "track-1",
  clipId: "clip-1",
  clipLabel: "camera.mp4",
  trackLabel: "Main video",
  transform: { ...DEFAULT_CLIP_TRANSFORM_GEOMETRY, opacityPermille: 425 },
  opacityPermille: 425,
  locked: false,
};

function renderInspector(
  overrides: Partial<{
    selection: SelectedVideoClip | null;
    transform: SelectedVideoClip["transform"] | null;
    opacityPermille: number | null;
    disabled: boolean;
    saving: boolean;
    error: Error | null;
    onDraftChange: (draft: ClipOpacityDraft) => void;
    onCommit: (draft: ClipOpacityDraft) => void;
    onTransformDraftChange: (draft: ClipTransformDraft) => void;
    onTransformCommit: (draft: ClipTransformDraft) => void;
  }> = {},
) {
  const props = {
    selection,
    transform: selection.transform,
    opacityPermille: 425,
    disabled: false,
    saving: false,
    error: null,
    onDraftChange: vi.fn(),
    onCommit: vi.fn(),
    onTransformDraftChange: vi.fn(),
    onTransformCommit: vi.fn(),
    ...overrides,
  };
  render(<ClipInspector {...props} />);
  return props;
}

afterEach(cleanup);

describe("ClipInspector", () => {
  it("shows a focused empty state without an editable control", () => {
    renderInspector({ selection: null, transform: null, opacityPermille: null });

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
        transform={selection.transform}
        opacityPermille={425}
        disabled={false}
        saving={false}
        error={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onTransformDraftChange={vi.fn()}
        onTransformCommit={vi.fn()}
      />,
    );

    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Unlock this track to change clip appearance.")).not.toBeNull();

    rerender(
      <ClipInspector
        selection={selection}
        transform={selection.transform}
        opacityPermille={425}
        disabled
        saving
        error={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onTransformDraftChange={vi.fn()}
        onTransformCommit={vi.fn()}
      />,
    );
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Saving clip appearance").textContent).toBe("Saving clip appearance");
  });

  it("shows the controller error as an alert while allowing retry", () => {
    renderInspector({ error: new Error("The project revision changed.") });

    expect(screen.getByRole("alert").textContent).toContain("Could not save clip appearance");
    expect(screen.getByRole("alert").textContent).toContain("The project revision changed.");
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it("drafts and commits an exact full transform while preserving opacity", () => {
    const props = renderInspector();
    const positionX = screen.getByRole("spinbutton", { name: "X position" });

    fireEvent.change(positionX, { target: { value: "12.5" } });
    expect(props.onTransformDraftChange).toHaveBeenLastCalledWith({
      sequenceId: "sequence-1",
      trackId: "track-1",
      clipId: "clip-1",
      transform: {
        ...DEFAULT_CLIP_TRANSFORM_GEOMETRY,
        positionXPermille: 125,
        opacityPermille: 425,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply transform" }));
    expect(props.onTransformCommit).toHaveBeenCalledTimes(1);
    expect(props.onTransformCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ positionXPermille: 125, opacityPermille: 425 }),
      }),
    );
  });

  it("rejects an invalid geometry draft before commit", () => {
    const props = renderInspector();
    const scaleX = screen.getByRole("spinbutton", { name: "X scale" });

    fireEvent.change(scaleX, { target: { value: "0" } });

    expect(screen.getByRole("alert").textContent).toContain(
      "X scale must be between 0.1 and 100000%.",
    );
    expect((scaleX as HTMLInputElement).value).toBe("0");
    expect(screen.getByRole("button", { name: "Apply transform" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(props.onTransformCommit).not.toHaveBeenCalled();
  });

  it("exposes bounded nonuniform scale and rotation controls", () => {
    renderInspector();

    expect(screen.getByRole("spinbutton", { name: "X scale" })).toHaveProperty("min", "0.1");
    expect((screen.getByRole("spinbutton", { name: "Y scale" }) as HTMLInputElement).value).toBe(
      "100",
    );
    expect(screen.getByRole("spinbutton", { name: "Rotation" })).toHaveProperty("max", "360000");
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
