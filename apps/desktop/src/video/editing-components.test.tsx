// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandProvider, useCommandHandler } from "../commands/CommandProvider";
import { ClipTrimRanges } from "./ClipTrimRanges";
import { TrimInspector } from "./TrimInspector";

function HistoryHandlers({ canUndo, canRedo }: { canUndo: boolean; canRedo: boolean }) {
  useCommandHandler("history.undo", { canExecute: canUndo, execute: () => undefined });
  useCommandHandler("history.redo", { canExecute: canRedo, execute: () => undefined });
  return null;
}

afterEach(cleanup);

describe("timeline and trim inspector", () => {
  it("preserves native quick-trim ranges and callbacks", () => {
    const onTrimInChange = vi.fn();
    const onTrimOutChange = vi.fn();
    render(
      <ClipTrimRanges
        durationFrames={100}
        trimIn={10}
        trimOut={90}
        disabled={false}
        onTrimInChange={onTrimInChange}
        onTrimOutChange={onTrimOutChange}
      />,
    );
    expect(screen.getByRole("slider", { name: "Trim in" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Trim out" })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Trim in" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("slider", { name: "Trim out" }), { target: { value: "80" } });
    expect(onTrimInChange).toHaveBeenCalledWith(20);
    expect(onTrimOutChange).toHaveBeenCalledWith(80);
  });

  it("blocks invalid, unchanged, and pending trim submissions", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <CommandProvider>
        <HistoryHandlers canUndo={false} canRedo={false} />
        <TrimInspector
          inFrame={10}
          outFrame={10}
          durationFrames={100}
          valid={false}
          changed={true}
          operation={{ phase: "idle" }}
          onInFrameChange={vi.fn()}
          onOutFrameChange={vi.fn()}
          onApply={onApply}
        />
      </CommandProvider>,
    );
    expect((screen.getByRole("button", { name: "Apply trim" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <CommandProvider>
        <HistoryHandlers canUndo={false} canRedo={false} />
        <TrimInspector
          inFrame={10}
          outFrame={90}
          durationFrames={100}
          valid={true}
          changed={false}
          operation={{ phase: "saving", operation: "trim" }}
          onInFrameChange={vi.fn()}
          onOutFrameChange={vi.fn()}
          onApply={onApply}
        />
      </CommandProvider>,
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
      <CommandProvider>
        <HistoryHandlers canUndo={true} canRedo={false} />
        <TrimInspector
          inFrame={5}
          outFrame={50}
          durationFrames={100}
          valid={true}
          changed={true}
          operation={{ phase: "idle" }}
          onInFrameChange={onInFrameChange}
          onOutFrameChange={onOutFrameChange}
          onApply={vi.fn()}
        />
      </CommandProvider>,
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
