import {
  COMMAND_REGISTRY,
  applyShortcutOverrides,
  isCommandId,
  isShortcutGesture,
  validateShortcutMap,
  type CommandId,
  type ExactShortcutGesture,
  type ShortcutMap,
  type ShortcutOverrides,
} from "./command-registry";

export const SHORTCUT_PREFERENCES_KEY = "supa-video.shortcut-preferences";
export const SHORTCUT_PREFERENCES_VERSION = 1 as const;

export type ShortcutPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface LoadedShortcutPreferences {
  readonly overrides: ShortcutOverrides;
  readonly shortcuts: ShortcutMap;
  readonly error: string | null;
}

export interface ShortcutPreferenceWriteResult {
  readonly saved: boolean;
  readonly error: string | null;
}

const EMPTY_OVERRIDES: ShortcutOverrides = Object.freeze({});

function defaults(error: string | null = null): LoadedShortcutPreferences {
  return {
    overrides: EMPTY_OVERRIDES,
    shortcuts: applyShortcutOverrides(EMPTY_OVERRIDES),
    error,
  };
}

function invalidRecord(reason: string): LoadedShortcutPreferences {
  return defaults(`Shortcut preferences were ignored: ${reason}. Defaults are active.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedGesture(value: unknown): value is ExactShortcutGesture {
  return isShortcutGesture(value) && !("primary" in value);
}

function parseOverrides(value: unknown): ShortcutOverrides | null {
  if (!isRecord(value)) return null;
  const parsed: Partial<Record<CommandId, ExactShortcutGesture | null>> = {};
  for (const [id, shortcut] of Object.entries(value)) {
    if (!isCommandId(id)) continue;
    if (shortcut !== null && !isPersistedGesture(shortcut)) return null;
    parsed[id] = shortcut;
  }
  return Object.freeze(parsed);
}

export function loadShortcutPreferences(
  storage: ShortcutPreferenceStorage,
): LoadedShortcutPreferences {
  let serialized: string | null;
  try {
    serialized = storage.getItem(SHORTCUT_PREFERENCES_KEY);
  } catch {
    return defaults(
      "Shortcut preferences could not be read. Defaults are active for this session.",
    );
  }
  if (serialized === null) return defaults();

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return invalidRecord("the saved data is not valid JSON");
  }
  if (!isRecord(value) || value.version !== SHORTCUT_PREFERENCES_VERSION) {
    return invalidRecord("the saved version is unsupported");
  }
  const overrides = parseOverrides(value.overrides);
  if (overrides === null) return invalidRecord("a known command binding is malformed");

  const shortcuts = applyShortcutOverrides(overrides);
  const validation = validateShortcutMap(shortcuts);
  if (!validation.valid) return invalidRecord("saved bindings collide");
  return { overrides, shortcuts, error: null };
}

function orderedOverrides(overrides: ShortcutOverrides): ShortcutOverrides {
  const ordered: Partial<Record<CommandId, ExactShortcutGesture | null>> = {};
  for (const { id } of COMMAND_REGISTRY) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      const value = overrides[id];
      if (value === null || (value !== undefined && !("primary" in value))) ordered[id] = value;
    }
  }
  return ordered;
}

export function saveShortcutPreferences(
  storage: ShortcutPreferenceStorage,
  overrides: ShortcutOverrides,
): ShortcutPreferenceWriteResult {
  try {
    const persistable = orderedOverrides(overrides);
    if (Object.keys(persistable).length === 0) {
      storage.removeItem(SHORTCUT_PREFERENCES_KEY);
    } else {
      storage.setItem(
        SHORTCUT_PREFERENCES_KEY,
        JSON.stringify({ version: SHORTCUT_PREFERENCES_VERSION, overrides: persistable }),
      );
    }
    return { saved: true, error: null };
  } catch {
    return {
      saved: false,
      error: "Shortcut changes are active for this session but could not be saved.",
    };
  }
}

export function setShortcutOverride(
  overrides: ShortcutOverrides,
  id: CommandId,
  shortcut: ExactShortcutGesture | null,
): ShortcutOverrides {
  return Object.freeze({ ...overrides, [id]: shortcut });
}

export function resetShortcutOverride(
  overrides: ShortcutOverrides,
  id: CommandId,
): ShortcutOverrides {
  const next: Partial<Record<CommandId, ExactShortcutGesture | null>> = {};
  for (const definition of COMMAND_REGISTRY) {
    if (definition.id !== id && Object.prototype.hasOwnProperty.call(overrides, definition.id)) {
      const value = overrides[definition.id];
      if (value === null || (value !== undefined && !("primary" in value))) {
        next[definition.id] = value;
      }
    }
  }
  return Object.freeze(next);
}
