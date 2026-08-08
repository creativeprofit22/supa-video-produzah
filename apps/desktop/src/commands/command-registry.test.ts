import { describe, expect, it } from "vitest";

import {
  COMMAND_IDS,
  COMMAND_REGISTRY,
  applyShortcutOverrides,
  createDefaultShortcutMap,
  formatShortcut,
  isShortcutGesture,
  matchesShortcut,
  normalizeKeyboardEvent,
  toAriaKeyShortcuts,
  validateShortcutAssignment,
  validateShortcutMap,
  type ExactShortcutGesture,
  type KeyboardEventLike,
} from "./command-registry";

const keyboardEvent = (
  code: string,
  modifiers: Partial<Omit<KeyboardEventLike, "code">> = {},
): KeyboardEventLike => ({
  code,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
  altKey: modifiers.altKey ?? false,
  isComposing: modifiers.isComposing ?? false,
});

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

describe("command registry", () => {
  it("has one definition per unique ID, non-empty labels, and collision-free defaults", () => {
    expect(COMMAND_REGISTRY.map(({ id }) => id)).toEqual(COMMAND_IDS);
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length);
    expect(COMMAND_REGISTRY.every(({ label }) => label.trim().length > 0)).toBe(true);
    expect(COMMAND_REGISTRY.find(({ id }) => id === "view.toggleProjectInspector")?.label).toBe(
      "Toggle project diagnostics",
    );
    expect(validateShortcutMap(createDefaultShortcutMap())).toEqual({ valid: true });
  });

  it("allows repeat only for the four frame step and jump commands", () => {
    expect(COMMAND_REGISTRY.filter(({ allowRepeat }) => allowRepeat).map(({ id }) => id)).toEqual([
      "playback.stepBackward",
      "playback.stepForward",
      "playback.jumpBackward",
      "playback.jumpForward",
    ]);
  });

  it("keeps frame movement distinct from transport and rejects colliding remaps", () => {
    const defaults = createDefaultShortcutMap();
    expect(defaults["timeline.moveSelectedClipBackward"]).toEqual(
      exact("ArrowLeft", { alt: true }),
    );
    expect(defaults["timeline.moveSelectedClipForward"]).toEqual(
      exact("ArrowRight", { alt: true }),
    );
    expect(matchesShortcut(keyboardEvent("ArrowRight"), defaults["playback.stepForward"]!)).toBe(
      true,
    );
    expect(
      matchesShortcut(
        keyboardEvent("ArrowRight", { altKey: true }),
        defaults["timeline.moveSelectedClipForward"]!,
      ),
    ).toBe(true);
    expect(
      validateShortcutAssignment("timeline.moveSelectedClipForward", exact("ArrowRight"), defaults),
    ).toEqual({
      valid: false,
      commandId: "timeline.moveSelectedClipForward",
      conflictingCommandId: "playback.stepForward",
    });
  });
});

describe("shortcut matching and normalization", () => {
  const defaults = createDefaultShortcutMap();

  it("matches Primary defaults with either Control or Meta, but not extra modifiers", () => {
    const undo = defaults["history.undo"]!;
    expect(matchesShortcut(keyboardEvent("KeyZ", { ctrlKey: true }), undo)).toBe(true);
    expect(matchesShortcut(keyboardEvent("KeyZ", { metaKey: true }), undo)).toBe(true);
    expect(matchesShortcut(keyboardEvent("KeyZ", { ctrlKey: true, metaKey: true }), undo)).toBe(
      false,
    );
    expect(matchesShortcut(keyboardEvent("KeyZ", { ctrlKey: true, shiftKey: true }), undo)).toBe(
      false,
    );
  });

  it("matches exact custom modifiers without overmatching", () => {
    const custom = exact("KeyK", { control: true, alt: true });
    expect(matchesShortcut(keyboardEvent("KeyK", { ctrlKey: true, altKey: true }), custom)).toBe(
      true,
    );
    expect(
      matchesShortcut(
        keyboardEvent("KeyK", { ctrlKey: true, altKey: true, shiftKey: true }),
        custom,
      ),
    ).toBe(false);
    expect(matchesShortcut(keyboardEvent("KeyK", { metaKey: true, altKey: true }), custom)).toBe(
      false,
    );
  });

  it("normalizes physical codes and rejects composing or unsupported events", () => {
    expect(normalizeKeyboardEvent(keyboardEvent("KeyK", { ctrlKey: true }))).toEqual(
      exact("KeyK", { control: true }),
    );
    expect(normalizeKeyboardEvent(keyboardEvent("Tab"))).toBeNull();
    expect(normalizeKeyboardEvent(keyboardEvent("KeyK", { isComposing: true }))).toBeNull();
  });

  it("strictly validates serializable gestures", () => {
    expect(isShortcutGesture(exact("F24", { meta: true }))).toBe(true);
    expect(isShortcutGesture({ ...exact("KeyK"), extra: false })).toBe(false);
    expect(
      isShortcutGesture({ code: "Tab", control: false, meta: false, shift: false, alt: false }),
    ).toBe(false);
    expect(isShortcutGesture({ code: "KeyK", primary: true, shift: false, alt: false })).toBe(true);
  });
});

describe("shortcut formatting", () => {
  it("formats semantic and exact modifiers, punctuation, navigation, and deletion", () => {
    expect(formatShortcut({ code: "KeyZ", primary: true, shift: true, alt: false })).toBe(
      "Ctrl/Cmd+Shift+Z",
    );
    expect(formatShortcut(exact("Comma", { control: true }))).toBe("Ctrl+,");
    expect(formatShortcut(exact("ArrowLeft", { shift: true }))).toBe("Shift+←");
    expect(formatShortcut(exact("Space"))).toBe("Space");
    expect(formatShortcut(exact("Delete", { shift: true }))).toBe("Shift+Delete");
    expect(formatShortcut(null)).toBeNull();
  });

  it("expands Primary into both WAI-ARIA sequences", () => {
    expect(toAriaKeyShortcuts({ code: "KeyD", primary: true, shift: false, alt: true })).toBe(
      "Control+Alt+D Meta+Alt+D",
    );
    expect(toAriaKeyShortcuts(exact("Comma", { meta: true }))).toBe("Meta+,");
    expect(toAriaKeyShortcuts(null)).toBeUndefined();
  });
});

describe("shortcut collision validation", () => {
  it("detects overlap between Primary and concrete Control or Meta gestures", () => {
    const defaults = createDefaultShortcutMap();
    expect(
      validateShortcutAssignment(
        "timeline.splitSelectedClip",
        exact("KeyZ", { control: true }),
        defaults,
      ),
    ).toEqual({
      valid: false,
      commandId: "timeline.splitSelectedClip",
      conflictingCommandId: "history.undo",
    });
    expect(
      validateShortcutAssignment(
        "timeline.splitSelectedClip",
        exact("KeyZ", { meta: true }),
        defaults,
      ),
    ).toEqual({
      valid: false,
      commandId: "timeline.splitSelectedClip",
      conflictingCommandId: "history.undo",
    });
  });

  it("does not collide on distinct exact modifier combinations and accepts disabled bindings", () => {
    const defaults = createDefaultShortcutMap();
    expect(
      validateShortcutAssignment(
        "timeline.splitSelectedClip",
        exact("KeyZ", { control: true, meta: true }),
        defaults,
      ),
    ).toEqual({ valid: true });
    expect(validateShortcutAssignment("timeline.splitSelectedClip", null, defaults)).toEqual({
      valid: true,
    });
  });

  it("applies sparse overrides while null explicitly disables a command", () => {
    const effective = applyShortcutOverrides({
      "timeline.splitSelectedClip": exact("KeyK"),
      "playback.toggle": null,
    });
    expect(effective["timeline.splitSelectedClip"]).toEqual(exact("KeyK"));
    expect(effective["playback.toggle"]).toBeNull();
    expect(effective["history.undo"]).toEqual(createDefaultShortcutMap()["history.undo"]);
  });
});
