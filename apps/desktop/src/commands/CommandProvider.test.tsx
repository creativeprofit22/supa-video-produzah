// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandId, ExactShortcutGesture } from "./command-registry";
import {
  CommandProvider,
  useCommand,
  useCommandHandler,
  useCommandPreferences,
} from "./CommandProvider";
import type { ShortcutPreferenceStorage } from "./shortcut-preferences";

afterEach(cleanup);

class MemoryStorage implements ShortcutPreferenceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const exact = (
  code: string,
  modifiers: Partial<Omit<ExactShortcutGesture, "code">> = {},
): ExactShortcutGesture => ({
  code,
  control: modifiers.control ?? false,
  meta: modifiers.meta ?? false,
  shift: modifiers.shift ?? false,
  alt: modifiers.alt ?? false,
});

function dispatchKey(
  target: EventTarget,
  init: KeyboardEventInit & { readonly code: string },
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
    key: init.key ?? init.code,
  });
  target.dispatchEvent(event);
  return event;
}

function Handler({
  id,
  canExecute = true,
  execute,
  scopeRef,
}: {
  readonly id: CommandId;
  readonly canExecute?: boolean;
  readonly execute: (source: "button" | "keyboard") => void;
  readonly scopeRef?: RefObject<HTMLElement | null>;
}) {
  useCommandHandler(id, {
    canExecute,
    execute,
    ...(scopeRef === undefined ? {} : { keyboardScopeRef: scopeRef }),
  });
  return null;
}

function CommandButton({ id }: { readonly id: CommandId }) {
  const command = useCommand(id);
  return (
    <button
      type="button"
      disabled={!command.canExecute}
      aria-keyshortcuts={command.ariaKeyShortcuts}
      onClick={command.execute}
    >
      {command.label}
    </button>
  );
}

function TestProvider({ children }: { readonly children: ReactNode }) {
  return <CommandProvider storage={new MemoryStorage()}>{children}</CommandProvider>;
}

describe("CommandProvider execution", () => {
  it("routes button and keyboard activation through one executor once", async () => {
    const execute = vi.fn();
    render(
      <TestProvider>
        <Handler id="history.undo" execute={execute} />
        <CommandButton id="history.undo" />
      </TestProvider>,
    );
    const button = await screen.findByRole("button", { name: "Undo last edit" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);
    expect(execute).toHaveBeenLastCalledWith("button");

    const event = dispatchKey(window, { code: "KeyZ", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenLastCalledWith("keyboard");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Z Meta+Z");
  });

  it("rechecks current capability without reinstalling the window listener", async () => {
    const execute = vi.fn();
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      return (
        <>
          <Handler id="history.undo" canExecute={enabled} execute={execute} />
          <CommandButton id="history.undo" />
          <button type="button" onClick={() => setEnabled((value) => !value)}>
            Toggle capability
          </button>
        </>
      );
    }
    render(
      <TestProvider>
        <Harness />
      </TestProvider>,
    );

    expect(dispatchKey(window, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Toggle capability" }));
    expect(dispatchKey(window, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute missing or disabled handlers", () => {
    const execute = vi.fn();
    render(
      <TestProvider>
        <Handler id="history.undo" canExecute={false} execute={execute} />
      </TestProvider>,
    );
    expect(dispatchKey(window, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatchKey(window, { code: "KeyO", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails loudly when two live handlers claim one command", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <TestProvider>
          <Handler id="history.undo" execute={() => undefined} />
          <Handler id="history.undo" execute={() => undefined} />
        </TestProvider>,
      ),
    ).toThrow("Duplicate runtime handler registered for command: history.undo");
    consoleError.mockRestore();
  });
});

describe("central keyboard suppression", () => {
  it("preserves editable, composing, prevented, unidentified, and modal events", () => {
    const execute = vi.fn();
    render(
      <TestProvider>
        <Handler id="history.undo" execute={execute} />
        <input aria-label="Text input" />
        <select aria-label="Select">
          <option>One</option>
        </select>
        <div contentEditable aria-label="Editor" />
        <div contentEditable="plaintext-only" aria-label="Plain text editor" />
        <div role="textbox" tabIndex={0} aria-label="Role editor" />
        <div role="searchbox" tabIndex={0} aria-label="Search editor" />
        <dialog open aria-label="Open modal" />
      </TestProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Text input" });
    expect(dispatchKey(input, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(
      dispatchKey(screen.getByLabelText("Plain text editor"), { code: "KeyZ", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(
      dispatchKey(screen.getByRole("searchbox", { name: "Search editor" }), {
        code: "KeyZ",
        ctrlKey: true,
      }).defaultPrevented,
    ).toBe(false);
    expect(
      dispatchKey(window, { code: "KeyZ", ctrlKey: true, isComposing: true }).defaultPrevented,
    ).toBe(false);
    const prevented = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
    });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(
      dispatchKey(window, { code: "KeyZ", key: "Unidentified", ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves native Space behavior after remapping an application command", () => {
    const execute = vi.fn();
    function Preferences() {
      const preferences = useCommandPreferences();
      return (
        <button
          type="button"
          onClick={() => {
            preferences.assignShortcut("playback.toggle", null);
            preferences.assignShortcut("history.undo", exact("Space"));
          }}
        >
          Remap undo to Space
        </button>
      );
    }
    render(
      <TestProvider>
        <Handler id="history.undo" execute={execute} />
        <Preferences />
        <button type="button">Native button</button>
        <a href="#target">Native link</a>
        <div role="button" tabIndex={0}>
          Role button
        </div>
        <details>
          <summary>Native summary</summary>
        </details>
        <div tabIndex={0} aria-label="Application surface" />
      </TestProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remap undo to Space" }));

    const nativeActivationTargets = [
      screen.getByRole("button", { name: "Native button" }),
      screen.getByRole("link", { name: "Native link" }),
      screen.getByRole("button", { name: "Role button" }),
      screen.getByText("Native summary"),
    ];
    for (const target of nativeActivationTargets) {
      target.focus();
      expect(document.activeElement).toBe(target);
      expect(dispatchKey(target, { code: "Space", key: " " }).defaultPrevented).toBe(false);
    }
    expect(execute).not.toHaveBeenCalled();

    const applicationSurface = screen.getByLabelText("Application surface");
    applicationSurface.focus();
    const event = dispatchKey(applicationSurface, { code: "Space", key: " " });
    expect(event.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not steal transport keys from interactive controls and applies repeat policy", () => {
    const toggle = vi.fn();
    const step = vi.fn();
    render(
      <TestProvider>
        <Handler id="playback.toggle" execute={toggle} />
        <Handler id="playback.stepForward" execute={step} />
        <button type="button">Native button</button>
        <a href="#target">Native link</a>
        <video aria-label="Native video" />
      </TestProvider>,
    );
    expect(dispatchKey(screen.getByRole("button"), { code: "Space" }).defaultPrevented).toBe(false);
    expect(dispatchKey(screen.getByRole("link"), { code: "ArrowRight" }).defaultPrevented).toBe(
      false,
    );
    expect(
      dispatchKey(screen.getByLabelText("Native video"), { code: "ArrowRight" }).defaultPrevented,
    ).toBe(false);
    expect(dispatchKey(window, { code: "Space", repeat: true }).defaultPrevented).toBe(false);
    expect(dispatchKey(window, { code: "ArrowRight", repeat: true }).defaultPrevented).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("preserves horizontal arrows on the focused timeline scroll region", () => {
    const stepBackward = vi.fn();
    const stepForward = vi.fn();
    const jumpBackward = vi.fn();
    const jumpForward = vi.fn();
    const shortcuts = [
      { code: "ArrowLeft", shiftKey: false, execute: stepBackward },
      { code: "ArrowRight", shiftKey: false, execute: stepForward },
      { code: "ArrowLeft", shiftKey: true, execute: jumpBackward },
      { code: "ArrowRight", shiftKey: true, execute: jumpForward },
    ] as const;
    render(
      <TestProvider>
        <Handler id="playback.stepBackward" execute={stepBackward} />
        <Handler id="playback.stepForward" execute={stepForward} />
        <Handler id="playback.jumpBackward" execute={jumpBackward} />
        <Handler id="playback.jumpForward" execute={jumpForward} />
        <div
          className="multitrack-scroll-region"
          role="region"
          tabIndex={0}
          aria-label="Timeline tracks; scroll horizontally"
        />
        <div tabIndex={0} aria-label="Application surface" />
      </TestProvider>,
    );

    const timelineRegion = screen.getByRole("region", {
      name: "Timeline tracks; scroll horizontally",
    });
    timelineRegion.focus();
    expect(document.activeElement).toBe(timelineRegion);
    for (const shortcut of shortcuts) {
      expect(
        dispatchKey(timelineRegion, {
          code: shortcut.code,
          shiftKey: shortcut.shiftKey,
        }).defaultPrevented,
      ).toBe(false);
    }
    for (const { execute } of shortcuts) expect(execute).not.toHaveBeenCalled();

    const applicationSurface = screen.getByLabelText("Application surface");
    applicationSurface.focus();
    expect(document.activeElement).toBe(applicationSurface);
    for (const shortcut of shortcuts) {
      expect(
        dispatchKey(applicationSurface, {
          code: shortcut.code,
          shiftKey: shortcut.shiftKey,
        }).defaultPrevented,
      ).toBe(true);
      expect(shortcut.execute).toHaveBeenCalledOnce();
      expect(shortcut.execute).toHaveBeenCalledWith("keyboard");
    }
  });

  it("requires timeline scope and allows only its neutral surface or clip body", () => {
    const split = vi.fn();
    function Timeline() {
      const scopeRef = useRef<HTMLElement | null>(null);
      return (
        <>
          <Handler id="timeline.splitSelectedClip" execute={split} scopeRef={scopeRef} />
          <section ref={scopeRef}>
            <div tabIndex={0} aria-label="Timeline surface" />
            <button type="button" className="multitrack-clip-body" aria-pressed="true">
              Selected clip
            </button>
            <button type="button" className="multitrack-clip-body" aria-pressed="false">
              Unselected clip
            </button>
            <button type="button">Timeline action</button>
          </section>
          <div tabIndex={0} aria-label="Outside" />
        </>
      );
    }
    render(
      <TestProvider>
        <Timeline />
      </TestProvider>,
    );
    expect(dispatchKey(screen.getByLabelText("Outside"), { code: "KeyS" }).defaultPrevented).toBe(
      false,
    );
    expect(
      dispatchKey(screen.getByRole("button", { name: "Timeline action" }), { code: "KeyS" })
        .defaultPrevented,
    ).toBe(false);
    expect(
      dispatchKey(screen.getByLabelText("Timeline surface"), { code: "KeyS" }).defaultPrevented,
    ).toBe(true);
    expect(
      dispatchKey(screen.getByRole("button", { name: "Selected clip" }), { code: "KeyS" })
        .defaultPrevented,
    ).toBe(true);
    expect(
      dispatchKey(screen.getByRole("button", { name: "Unselected clip" }), { code: "KeyS" })
        .defaultPrevented,
    ).toBe(false);
    expect(
      dispatchKey(screen.getByLabelText("Timeline surface"), { code: "KeyS", repeat: true })
        .defaultPrevented,
    ).toBe(false);
    expect(split).toHaveBeenCalledTimes(2);
  });
});

describe("runtime shortcut updates", () => {
  it("remaps and clears behavior and accessible exposure immediately", async () => {
    const execute = vi.fn();
    function Preferences() {
      const preferences = useCommandPreferences();
      return (
        <>
          <button
            type="button"
            onClick={() => preferences.assignShortcut("history.undo", exact("KeyK", { alt: true }))}
          >
            Remap
          </button>
          <button type="button" onClick={() => preferences.assignShortcut("history.undo", null)}>
            Clear
          </button>
        </>
      );
    }
    render(
      <TestProvider>
        <Handler id="history.undo" execute={execute} />
        <CommandButton id="history.undo" />
        <Preferences />
      </TestProvider>,
    );
    const commandButton = screen.getByRole("button", { name: "Undo last edit" });
    await waitFor(() => expect((commandButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Remap" }));
    expect(commandButton.getAttribute("aria-keyshortcuts")).toBe("Alt+K");
    expect(dispatchKey(window, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatchKey(window, { code: "KeyK", altKey: true }).defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(commandButton.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(dispatchKey(window, { code: "KeyK", altKey: true }).defaultPrevented).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a reset that would restore a colliding default", () => {
    const undo = vi.fn();
    const newProject = vi.fn();
    const resetResult = vi.fn();
    const storage = new MemoryStorage();
    function Preferences() {
      const preferences = useCommandPreferences();
      return (
        <>
          <button type="button" onClick={() => preferences.assignShortcut("history.undo", null)}>
            Clear undo
          </button>
          <button
            type="button"
            onClick={() =>
              preferences.assignShortcut("project.new", exact("KeyZ", { control: true }))
            }
          >
            Reassign undo default
          </button>
          <button
            type="button"
            onClick={() => resetResult(preferences.resetShortcut("history.undo"))}
          >
            Reset undo
          </button>
        </>
      );
    }
    render(
      <CommandProvider storage={storage}>
        <Handler id="history.undo" execute={undo} />
        <Handler id="project.new" execute={newProject} />
        <Preferences />
      </CommandProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Reassign undo default" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset undo" }));

    expect(resetResult).toHaveBeenCalledWith({
      updated: false,
      validation: {
        valid: false,
        commandId: "project.new",
        conflictingCommandId: "history.undo",
      },
    });
    expect(dispatchKey(window, { code: "KeyZ", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(newProject).toHaveBeenCalledOnce();
    expect(undo).not.toHaveBeenCalled();
  });
});
