// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SingleClipTimeline } from "./SingleClipTimeline";
import { TrimInspector } from "./TrimInspector";

afterEach(cleanup);

describe("timeline and trim inspector", () => {
  it("uses the cache thumbnail, native range alternatives, and pointer seeking", () => {
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    const onTrimInChange = vi.fn();
    const onTrimOutChange = vi.fn();
    const onSeek = vi.fn();
    const { container } = render(
      <SingleClipTimeline
        thumbnailPath="/cache/thumb.jpg"
        convertCachePath={convertCachePath}
        durationFrames={100}
        trimIn={10}
        trimOut={90}
        playhead={50}
        disabled={false}
        onTrimInChange={onTrimInChange}
        onTrimOutChange={onTrimOutChange}
        onSeek={onSeek}
      />,
    );
    expect(convertCachePath).toHaveBeenCalledWith("/cache/thumb.jpg");
    expect(screen.getByRole("slider", { name: "Trim in" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Trim out" })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Trim in" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("slider", { name: "Trim out" }), { target: { value: "80" } });
    expect(onTrimInChange).toHaveBeenCalledWith(20);
    expect(onTrimOutChange).toHaveBeenCalledWith(80);

    const track = container.querySelector(".timeline-track");
    if (!(track instanceof HTMLElement)) throw new Error("Expected timeline track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      right: 200,
      top: 0,
      bottom: 82,
      width: 200,
      height: 82,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(track, { clientX: 100 });
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it("blocks invalid, unchanged, and pending trim submissions", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <TrimInspector
        inFrame={10}
        outFrame={10}
        durationFrames={100}
        valid={false}
        changed={true}
        canUndo={false}
        canRedo={false}
        operation={{ phase: "idle" }}
        onInFrameChange={vi.fn()}
        onOutFrameChange={vi.fn()}
        onApply={onApply}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Apply trim" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <TrimInspector
        inFrame={10}
        outFrame={90}
        durationFrames={100}
        valid={true}
        changed={false}
        canUndo={true}
        canRedo={true}
        operation={{ phase: "saving", operation: "trim" }}
        onInFrameChange={vi.fn()}
        onOutFrameChange={vi.fn()}
        onApply={onApply}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Saving trim" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("provides exact numeric controls as the complete non-drag alternative", () => {
    const onInFrameChange = vi.fn();
    const onOutFrameChange = vi.fn();
    render(
      <TrimInspector
        inFrame={5}
        outFrame={50}
        durationFrames={100}
        valid={true}
        changed={true}
        canUndo={true}
        canRedo={false}
        operation={{ phase: "idle" }}
        onInFrameChange={onInFrameChange}
        onOutFrameChange={onOutFrameChange}
        onApply={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim out" }), {
      target: { value: "48" },
    });
    expect(onInFrameChange).toHaveBeenCalledWith(7);
    expect(onOutFrameChange).toHaveBeenCalledWith(48);
    expect((screen.getByRole("button", { name: "Apply trim" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
