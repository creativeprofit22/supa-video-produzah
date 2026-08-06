// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CommandProvider, useCommand, useCommandHandler } from "./CommandProvider";
import { ShortcutSettings } from "./ShortcutSettings";
import type { ShortcutPreferenceStorage } from "./shortcut-preferences";

afterEach(cleanup);

class MemoryStorage implements ShortcutPreferenceStorage {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("quota");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failWrites) throw new Error("blocked");
    this.values.delete(key);
  }
}

function ShortcutExposure() {
  useCommandHandler("timeline.splitSelectedClip", {
    canExecute: true,
    execute: () => undefined,
  });
  const command = useCommand("timeline.splitSelectedClip");
  return (
    <button type="button" aria-keyshortcuts={command.ariaKeyShortcuts} onClick={command.execute}>
      Split exposure
    </button>
  );
}

function Harness({
  storage = new MemoryStorage(),
}: {
  readonly storage?: ShortcutPreferenceStorage;
}) {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  return (
    <CommandProvider storage={storage}>
      <button ref={returnFocusRef} type="button" onClick={() => setOpen(true)}>
        Open shortcuts
      </button>
      <ShortcutExposure />
      <ShortcutSettings
        open={open}
        onClose={() => setOpen(false)}
        returnFocusRef={returnFocusRef}
      />
    </CommandProvider>
  );
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label, { selector: "strong" }).closest("li")!;
}

describe("ShortcutSettings", () => {
  it("opens a named native dialog, focuses Close, and restores its trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open shortcuts" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("captures a valid chord and updates visible and ARIA shortcuts immediately", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));
    const row = rowFor("Split selected clip at playhead");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Change shortcut for Split selected clip at playhead",
      }),
    );
    const recorder = within(row).getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    });
    expect(document.activeElement).toBe(recorder);
    fireEvent.keyDown(recorder, { code: "KeyK", key: "k", ctrlKey: true, altKey: true });

    expect(within(row).getByText("Ctrl+Alt+K", { selector: "kbd" })).toBeTruthy();
    expect(within(row).getByText("Custom")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Split exposure" }).getAttribute("aria-keyshortcuts"),
    ).toBe("Control+Alt+K");
    expect(screen.getByText("Split selected clip at playhead changed to Ctrl+Alt+K.")).toBeTruthy();
  });

  it("rejects collisions without stealing the existing binding and keeps recording", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));
    const row = rowFor("Split selected clip at playhead");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Change shortcut for Split selected clip at playhead",
      }),
    );
    const recorder = within(row).getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    });
    fireEvent.keyDown(recorder, { code: "KeyZ", key: "z", ctrlKey: true });

    expect(within(row).getByText("S", { selector: "kbd" })).toBeTruthy();
    expect(
      within(row).getByText(
        "Split selected clip at playhead conflicts with Undo last edit. The current shortcut was not changed.",
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(recorder);
  });

  it("uses Escape to cancel recording and never captures Tab", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));
    const row = rowFor("Split selected clip at playhead");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Change shortcut for Split selected clip at playhead",
      }),
    );
    let recorder = within(row).getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    });
    fireEvent.keyDown(recorder, { code: "Tab", key: "Tab" });
    expect(
      within(row).getByRole("button", {
        name: "Record shortcut for Split selected clip at playhead",
      }),
    ).toBeTruthy();
    recorder = within(row).getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    });
    fireEvent.keyDown(recorder, { code: "Escape", key: "Escape" });
    expect(
      within(row).getByRole("button", {
        name: "Change shortcut for Split selected clip at playhead",
      }),
    ).toBeTruthy();
    expect(within(row).getByText("S", { selector: "kbd" })).toBeTruthy();
  });

  it("clears, resets one command, and resets all overrides", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));
    const splitRow = rowFor("Split selected clip at playhead");
    fireEvent.click(
      within(splitRow).getByRole("button", {
        name: "Clear shortcut for Split selected clip at playhead",
      }),
    );
    expect(within(splitRow).getByText("Off")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Split exposure" }).hasAttribute("aria-keyshortcuts"),
    ).toBe(false);

    fireEvent.click(
      within(splitRow).getByRole("button", {
        name: "Reset shortcut for Split selected clip at playhead",
      }),
    );
    expect(within(splitRow).getByText("S", { selector: "kbd" })).toBeTruthy();

    const deleteRow = rowFor("Ripple delete selected clip");
    fireEvent.click(
      within(deleteRow).getByRole("button", {
        name: "Clear shortcut for Ripple delete selected clip",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(within(deleteRow).getByText("Shift+Delete", { selector: "kbd" })).toBeTruthy();
    expect(screen.getByText("All keyboard shortcuts reset to defaults.")).toBeTruthy();
  });

  it("keeps session changes active and announces storage failures", () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    render(<Harness storage={storage} />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));
    const row = rowFor("Split selected clip at playhead");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Clear shortcut for Split selected clip at playhead",
      }),
    );
    expect(within(row).getByText("Off")).toBeTruthy();
    expect(
      screen.getAllByText("Shortcut changes are active for this session but could not be saved.")
        .length,
    ).toBeGreaterThan(0);
  });

  it("closes through the native cancel path", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open shortcuts" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});
