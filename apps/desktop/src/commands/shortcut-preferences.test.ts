import { describe, expect, it } from "vitest";

import { createDefaultShortcutMap, type ExactShortcutGesture } from "./command-registry";
import {
  SHORTCUT_PREFERENCES_KEY,
  loadShortcutPreferences,
  resetShortcutOverride,
  saveShortcutPreferences,
  setShortcutOverride,
  type ShortcutPreferenceStorage,
} from "./shortcut-preferences";

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

class MemoryStorage implements ShortcutPreferenceStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("quota");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("blocked");
    this.values.delete(key);
  }
}

function storeRecord(storage: MemoryStorage, value: unknown): void {
  storage.values.set(SHORTCUT_PREFERENCES_KEY, JSON.stringify(value));
}

describe("shortcut preference loading", () => {
  it("uses defaults when no record exists", () => {
    const loaded = loadShortcutPreferences(new MemoryStorage());
    expect(loaded.overrides).toEqual({});
    expect(loaded.shortcuts).toEqual(createDefaultShortcutMap());
    expect(loaded.error).toBeNull();
  });

  it("restores valid sparse overrides and explicit disabled values", () => {
    const storage = new MemoryStorage();
    storeRecord(storage, {
      version: 1,
      overrides: {
        "timeline.splitSelectedClip": exact("KeyK", { control: true }),
        "playback.toggle": null,
      },
    });
    const loaded = loadShortcutPreferences(storage);
    expect(loaded.overrides).toEqual({
      "timeline.splitSelectedClip": exact("KeyK", { control: true }),
      "playback.toggle": null,
    });
    expect(loaded.shortcuts["timeline.splitSelectedClip"]).toEqual(
      exact("KeyK", { control: true }),
    );
    expect(loaded.shortcuts["playback.toggle"]).toBeNull();
    expect(loaded.shortcuts["history.undo"]).toEqual(createDefaultShortcutMap()["history.undo"]);
    expect(loaded.error).toBeNull();
  });

  it("ignores unknown command IDs without weakening known-entry validation", () => {
    const storage = new MemoryStorage();
    storeRecord(storage, {
      version: 1,
      overrides: {
        "future.command": { anything: true },
        "timeline.splitSelectedClip": exact("KeyK"),
      },
    });
    expect(loadShortcutPreferences(storage).overrides).toEqual({
      "timeline.splitSelectedClip": exact("KeyK"),
    });
  });

  it.each([
    ["legacy unversioned", { overrides: {} }],
    ["unsupported version", { version: 2, overrides: {} }],
    ["missing overrides", { version: 1 }],
    ["malformed known entry", { version: 1, overrides: { "history.undo": { code: "KeyK" } } }],
    [
      "semantic persisted modifier",
      {
        version: 1,
        overrides: {
          "history.undo": { code: "KeyK", primary: true, shift: false, alt: false },
        },
      },
    ],
  ])("atomically rejects %s data", (_name, record) => {
    const storage = new MemoryStorage();
    storeRecord(storage, record);
    const loaded = loadShortcutPreferences(storage);
    expect(loaded.overrides).toEqual({});
    expect(loaded.shortcuts).toEqual(createDefaultShortcutMap());
    expect(loaded.error).toContain("ignored");
  });

  it("atomically rejects bindings that collide with semantic defaults", () => {
    const storage = new MemoryStorage();
    storeRecord(storage, {
      version: 1,
      overrides: {
        "timeline.splitSelectedClip": exact("KeyZ", { control: true }),
      },
    });
    const loaded = loadShortcutPreferences(storage);
    expect(loaded.overrides).toEqual({});
    expect(loaded.shortcuts).toEqual(createDefaultShortcutMap());
    expect(loaded.error).toContain("collide");
  });

  it("recovers atomically from malformed JSON and storage read errors", () => {
    const malformed = new MemoryStorage();
    malformed.values.set(SHORTCUT_PREFERENCES_KEY, "{");
    expect(loadShortcutPreferences(malformed).error).toContain("valid JSON");

    const blocked = new MemoryStorage();
    blocked.failReads = true;
    const loaded = loadShortcutPreferences(blocked);
    expect(loaded.shortcuts).toEqual(createDefaultShortcutMap());
    expect(loaded.error).toContain("could not be read");
  });
});

describe("shortcut preference writes", () => {
  it("writes versioned sparse overrides and removes the record after the last reset", () => {
    const storage = new MemoryStorage();
    let overrides = setShortcutOverride({}, "timeline.splitSelectedClip", exact("KeyK"));
    expect(saveShortcutPreferences(storage, overrides)).toEqual({ saved: true, error: null });
    expect(JSON.parse(storage.values.get(SHORTCUT_PREFERENCES_KEY)!)).toEqual({
      version: 1,
      overrides: { "timeline.splitSelectedClip": exact("KeyK") },
    });

    overrides = resetShortcutOverride(overrides, "timeline.splitSelectedClip");
    expect(saveShortcutPreferences(storage, overrides)).toEqual({ saved: true, error: null });
    expect(storage.values.has(SHORTCUT_PREFERENCES_KEY)).toBe(false);
  });

  it("persists null as an explicit disabled shortcut", () => {
    const storage = new MemoryStorage();
    const overrides = setShortcutOverride({}, "playback.toggle", null);
    saveShortcutPreferences(storage, overrides);
    expect(JSON.parse(storage.values.get(SHORTCUT_PREFERENCES_KEY)!)).toEqual({
      version: 1,
      overrides: { "playback.toggle": null },
    });
  });

  it("keeps write failures nonfatal and observable", () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(
      saveShortcutPreferences(
        storage,
        setShortcutOverride({}, "timeline.splitSelectedClip", exact("KeyK")),
      ),
    ).toEqual({
      saved: false,
      error: "Shortcut changes are active for this session but could not be saved.",
    });
  });
});
