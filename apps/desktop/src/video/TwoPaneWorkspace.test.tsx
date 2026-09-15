// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwoPaneWorkspace } from "./TwoPaneWorkspace";
import {
  DEFAULT_WORKSPACE_SPLIT,
  WORKSPACE_PREFERENCES_KEY,
  loadWorkspaceSplit,
  saveWorkspaceSplit,
} from "./workspace-preferences";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(rtl = false) {
  const result = render(
    <div dir={rtl ? "rtl" : "ltr"}>
      <TwoPaneWorkspace label="Workspace pane width">
        <input aria-label="Child state" defaultValue="retained" />
        <aside>Controls</aside>
      </TwoPaneWorkspace>
    </div>,
  );
  const separator = screen.getByRole("separator");
  separator.style.direction = rtl ? "rtl" : "ltr";
  Object.assign(separator, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => true,
  });
  vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
    width: 1016,
  } as DOMRect);
  return { ...result, separator };
}
describe("local workspace layout", () => {
  it("coalesces keyboard drafts, clamps bounds, saves on completion once, and preserves child identity", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { separator } = setup();
    const child = screen.getByLabelText("Child state");
    fireEvent.keyDown(separator, { key: "End" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(write).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(separator, { key: "ArrowRight" });
    fireEvent.blur(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(WORKSPACE_PREFERENCES_KEY);
    expect(screen.getByLabelText("Child state")).toBe(child);
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.blur(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe("25");
  });
  it("reverses physical arrows in RTL and restores persisted width", () => {
    const { separator, unmount } = setup(true);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyUp(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("67.5");
    unmount();
    expect(setup().separator.getAttribute("aria-valuenow")).toBe("67.5");
  });
  it.each([false, true])("captures pointer; clamps and commits only on up (RTL %s)", (rtl) => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { separator } = setup(rtl);
    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(separator, { clientX: 1500 });
    expect(write).not.toHaveBeenCalled();
    fireEvent.pointerUp(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe(rtl ? "25" : "75");
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("cancels pointer drafts without saving, resets locally and handles storage failure", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { separator, unmount } = setup();
    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(separator, { clientX: 0 });
    fireEvent.pointerCancel(separator);
    expect(write).not.toHaveBeenCalled();
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_WORKSPACE_SPLIT));
    write.mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.getByRole("status").textContent).toContain("session only");
    act(() => unmount());
  });
  it.each([
    "{",
    "null",
    "[]",
    '{"version":2,"split":50}',
    '{"version":1,"split":24}',
    '{"version":1,"split":"50"}',
    '{"version":1,"split":1e999}',
  ])("ignores untrusted preferences %s", (value) => {
    expect(loadWorkspaceSplit({ getItem: () => value, setItem: vi.fn() })).toBe(
      DEFAULT_WORKSPACE_SPLIT,
    );
  });
  it("recovers from read/write denial and refuses invalid writes", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: vi.fn(() => {
        throw new Error("denied");
      }),
    };
    expect(loadWorkspaceSplit(storage)).toBe(DEFAULT_WORKSPACE_SPLIT);
    expect(saveWorkspaceSplit(storage, NaN)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(saveWorkspaceSplit(storage, 50)).toBe(false);
  });
});
