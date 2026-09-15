// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRationalTime } from "@supa-video/contracts";
import { ClipSourceRangeInspector } from "./ClipSourceRangeInspector";
import { sourceRangeError, type SelectedMediaClip } from "./clip-source-range";
const rate = { numerator: 30, denominator: 1 };
const selection: SelectedMediaClip = {
  sequenceId: "s",
  trackId: "t",
  clipId: "c",
  label: "asset",
  locked: false,
  sourceIn: createRationalTime(10, rate),
  sourceOut: createRationalTime(60, rate),
  timelineStartFrame: 25,
  totalAssetFrames: 100,
  sequenceRate: rate,
};
afterEach(cleanup);
describe("selected source range", () => {
  it("rejects bounds, fractions, nonpositive ranges, inexact speed mapping and fades without clamping", () => {
    for (const [start, end] of [
      ["-1", "60"],
      ["0.5", "60"],
      ["60", "60"],
      ["0", "101"],
      ["", "60"],
    ])
      expect(sourceRangeError(selection, start!, end!)).not.toBeNull();
    expect(
      sourceRangeError({ ...selection, speed: { numerator: 2, denominator: 1 } }, "10", "59"),
    ).not.toBeNull();
    expect(
      sourceRangeError({ ...selection, fades: { inFrames: 20, outFrames: 20 } }, "30", "60"),
    ).toContain("fades");
    expect(sourceRangeError(selection, "0", "100")).toBeNull();
  });
  it("keeps drafts command-free, resets to canonical, applies once and preserves start", () => {
    const onCommit = vi.fn();
    render(
      <ClipSourceRangeInspector
        selection={selection}
        unsupported={false}
        revisionKey="1"
        disabled={false}
        saving={false}
        error={null}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText("Source in (30/1 fps)");
    fireEvent.change(input, { target: { value: "20" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Reset draft"));
    expect((input as HTMLInputElement).value).toBe("10");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByText("Apply source range"));
    fireEvent.click(screen.getByText("Apply source range"));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      clipId: "c",
      sourceInFrame: 20,
      sourceOutFrame: 60,
      timelineStartFrame: 25,
    });
  });
  it("discards drafts on revision and selection changes and disables saving/locked edits", () => {
    const props = {
      selection,
      unsupported: false,
      revisionKey: "1",
      disabled: false,
      saving: false,
      error: null,
      onCommit: vi.fn(),
    };
    const view = render(<ClipSourceRangeInspector {...props} />);
    fireEvent.change(screen.getByLabelText("Source in (30/1 fps)"), { target: { value: "20" } });
    view.rerender(<ClipSourceRangeInspector {...props} revisionKey="2" />);
    expect((screen.getByLabelText("Source in (30/1 fps)") as HTMLInputElement).value).toBe("10");
    view.rerender(
      <ClipSourceRangeInspector
        {...props}
        selection={{ ...selection, clipId: "other", locked: true }}
      />,
    );
    expect(screen.getByText("Track is locked.")).toBeTruthy();
    expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
    view.rerender(<ClipSourceRangeInspector {...props} saving />);
    expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
    expect(props.onCommit).not.toHaveBeenCalled();
  });
  it("makes nested context explicitly unsupported", () => {
    render(
      <ClipSourceRangeInspector
        selection={null}
        unsupported
        revisionKey="1"
        disabled={false}
        saving={false}
        error={null}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/not supported for nested/)).toBeTruthy();
  });
});
