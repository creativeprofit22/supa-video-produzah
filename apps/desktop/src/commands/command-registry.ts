export const COMMAND_IDS = [
  "app.openShortcutSettings",
  "project.new",
  "project.open",
  "history.undo",
  "history.redo",
  "view.toggleProjectInspector",
  "playback.toggle",
  "playback.stepBackward",
  "playback.stepForward",
  "playback.jumpBackward",
  "playback.jumpForward",
  "timeline.moveSelectedClipBackward",
  "timeline.moveSelectedClipForward",
  "timeline.splitSelectedClip",
  "timeline.rippleDeleteSelectedClip",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
export type KeyboardContext = "application" | "transport" | "timeline";

interface ShortcutBase {
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface PrimaryShortcutGesture extends ShortcutBase {
  readonly primary: true;
}

export interface ExactShortcutGesture extends ShortcutBase {
  readonly control: boolean;
  readonly meta: boolean;
}

export type ShortcutGesture = PrimaryShortcutGesture | ExactShortcutGesture;
export type ShortcutMap = Readonly<Record<CommandId, ShortcutGesture | null>>;
export type ShortcutOverrides = Readonly<Partial<Record<CommandId, ShortcutGesture | null>>>;

export interface CommandDefinition {
  readonly id: CommandId;
  readonly label: string;
  readonly defaultShortcut: ShortcutGesture | null;
  readonly keyboardContext: KeyboardContext;
  readonly allowRepeat: boolean;
}

const primary = (
  code: string,
  modifiers: Readonly<{ shift?: boolean; alt?: boolean }> = {},
): PrimaryShortcutGesture =>
  Object.freeze({
    code,
    primary: true,
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
  });

const exact = (
  code: string,
  modifiers: Readonly<{
    control?: boolean;
    meta?: boolean;
    shift?: boolean;
    alt?: boolean;
  }> = {},
): ExactShortcutGesture =>
  Object.freeze({
    code,
    control: modifiers.control ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
  });

export const COMMAND_REGISTRY: readonly CommandDefinition[] = Object.freeze([
  {
    id: "app.openShortcutSettings",
    label: "Keyboard shortcuts",
    defaultShortcut: primary("Comma"),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "project.new",
    label: "New project",
    defaultShortcut: primary("KeyN"),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "project.open",
    label: "Open project",
    defaultShortcut: primary("KeyO"),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "history.undo",
    label: "Undo last edit",
    defaultShortcut: primary("KeyZ"),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "history.redo",
    label: "Redo last edit",
    defaultShortcut: primary("KeyZ", { shift: true }),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "view.toggleProjectInspector",
    label: "Toggle project inspector",
    defaultShortcut: primary("KeyD", { alt: true }),
    keyboardContext: "application",
    allowRepeat: false,
  },
  {
    id: "playback.toggle",
    label: "Play or pause",
    defaultShortcut: exact("Space"),
    keyboardContext: "transport",
    allowRepeat: false,
  },
  {
    id: "playback.stepBackward",
    label: "Step backward one frame",
    defaultShortcut: exact("ArrowLeft"),
    keyboardContext: "transport",
    allowRepeat: true,
  },
  {
    id: "playback.stepForward",
    label: "Step forward one frame",
    defaultShortcut: exact("ArrowRight"),
    keyboardContext: "transport",
    allowRepeat: true,
  },
  {
    id: "playback.jumpBackward",
    label: "Step backward five frames",
    defaultShortcut: exact("ArrowLeft", { shift: true }),
    keyboardContext: "transport",
    allowRepeat: true,
  },
  {
    id: "playback.jumpForward",
    label: "Step forward five frames",
    defaultShortcut: exact("ArrowRight", { shift: true }),
    keyboardContext: "transport",
    allowRepeat: true,
  },
  {
    id: "timeline.moveSelectedClipBackward",
    label: "Move selected clip backward one frame",
    defaultShortcut: exact("ArrowLeft", { alt: true }),
    keyboardContext: "timeline",
    allowRepeat: false,
  },
  {
    id: "timeline.moveSelectedClipForward",
    label: "Move selected clip forward one frame",
    defaultShortcut: exact("ArrowRight", { alt: true }),
    keyboardContext: "timeline",
    allowRepeat: false,
  },
  {
    id: "timeline.splitSelectedClip",
    label: "Split selected clip at playhead",
    defaultShortcut: exact("KeyS"),
    keyboardContext: "timeline",
    allowRepeat: false,
  },
  {
    id: "timeline.rippleDeleteSelectedClip",
    label: "Ripple delete selected clip",
    defaultShortcut: exact("Delete", { shift: true }),
    keyboardContext: "timeline",
    allowRepeat: false,
  },
] satisfies readonly CommandDefinition[]);

const COMMAND_DEFINITION_BY_ID = new Map(
  COMMAND_REGISTRY.map((definition) => [definition.id, definition] as const),
);

export function getCommandDefinition(id: CommandId): CommandDefinition {
  const definition = COMMAND_DEFINITION_BY_ID.get(id);
  if (definition === undefined) throw new Error(`Unknown command: ${id}`);
  return definition;
}

export function isCommandId(value: string): value is CommandId {
  return COMMAND_DEFINITION_BY_ID.has(value as CommandId);
}

const NAMED_SUPPORTED_CODES = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backquote",
  "Backslash",
  "Backspace",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Delete",
  "End",
  "Equal",
  "Home",
  "Insert",
  "Minus",
  "PageDown",
  "PageUp",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "Space",
]);

export function isSupportedShortcutCode(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code) ||
    NAMED_SUPPORTED_CODES.has(code)
  );
}

export function isShortcutGesture(value: unknown): value is ShortcutGesture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.code !== "string" ||
    !isSupportedShortcutCode(candidate.code) ||
    typeof candidate.shift !== "boolean" ||
    typeof candidate.alt !== "boolean"
  ) {
    return false;
  }
  if (candidate.primary === true) {
    return (
      Object.keys(candidate).length === 4 && !("control" in candidate) && !("meta" in candidate)
    );
  }
  return (
    !("primary" in candidate) &&
    typeof candidate.control === "boolean" &&
    typeof candidate.meta === "boolean" &&
    Object.keys(candidate).length === 5
  );
}

export interface KeyboardEventLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

export function normalizeKeyboardEvent(event: KeyboardEventLike): ExactShortcutGesture | null {
  if (event.isComposing === true || !isSupportedShortcutCode(event.code)) return null;
  return exact(event.code, {
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  });
}

export function matchesShortcut(event: KeyboardEventLike, shortcut: ShortcutGesture): boolean {
  if (event.isComposing === true || event.code !== shortcut.code) return false;
  if (event.shiftKey !== shortcut.shift || event.altKey !== shortcut.alt) return false;
  if ("primary" in shortcut) {
    return event.ctrlKey !== event.metaKey && (event.ctrlKey || event.metaKey);
  }
  return event.ctrlKey === shortcut.control && event.metaKey === shortcut.meta;
}

const DISPLAY_CODE: Readonly<Record<string, string>> = Object.freeze({
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backquote: "`",
  Backslash: "\\",
  Backspace: "Backspace",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Equal: "=",
  Home: "Home",
  Insert: "Insert",
  Minus: "-",
  PageDown: "Page Down",
  PageUp: "Page Up",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
});

const ARIA_CODE: Readonly<Record<string, string>> = Object.freeze({
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
});

function displayCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return DISPLAY_CODE[code] ?? code;
}

function ariaCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return ARIA_CODE[code] ?? code;
}

export function formatShortcut(shortcut: ShortcutGesture | null): string | null {
  if (shortcut === null) return null;
  const parts: string[] = [];
  if ("primary" in shortcut) parts.push("Ctrl/Cmd");
  else {
    if (shortcut.control) parts.push("Ctrl");
    if (shortcut.meta) parts.push("Cmd");
  }
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(displayCode(shortcut.code));
  return parts.join("+");
}

function ariaSequence(
  shortcut: ShortcutGesture,
  primaryModifier: "Control" | "Meta" | null,
): string {
  const parts: string[] = [];
  if (primaryModifier !== null) parts.push(primaryModifier);
  else if (!("primary" in shortcut)) {
    if (shortcut.control) parts.push("Control");
    if (shortcut.meta) parts.push("Meta");
  }
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(ariaCode(shortcut.code));
  return parts.join("+");
}

export function toAriaKeyShortcuts(shortcut: ShortcutGesture | null): string | undefined {
  if (shortcut === null) return undefined;
  return "primary" in shortcut
    ? `${ariaSequence(shortcut, "Control")} ${ariaSequence(shortcut, "Meta")}`
    : ariaSequence(shortcut, null);
}

function expandCanonicalShortcut(shortcut: ShortcutGesture): readonly string[] {
  const canonical = (control: boolean, meta: boolean) =>
    `${shortcut.code}|${control ? 1 : 0}|${meta ? 1 : 0}|${shortcut.alt ? 1 : 0}|${
      shortcut.shift ? 1 : 0
    }`;
  return "primary" in shortcut
    ? [canonical(true, false), canonical(false, true)]
    : [canonical(shortcut.control, shortcut.meta)];
}

export interface ShortcutCollision {
  readonly commandId: CommandId;
  readonly conflictingCommandId: CommandId;
}

export type ShortcutValidationResult =
  { readonly valid: true } | ({ readonly valid: false } & ShortcutCollision);

export function validateShortcutAssignment(
  commandId: CommandId,
  shortcut: ShortcutGesture | null,
  effectiveShortcuts: ShortcutMap,
): ShortcutValidationResult {
  if (shortcut === null) return { valid: true };
  const proposed = new Set(expandCanonicalShortcut(shortcut));
  for (const definition of COMMAND_REGISTRY) {
    if (definition.id === commandId) continue;
    const current = effectiveShortcuts[definition.id];
    if (
      current !== null &&
      expandCanonicalShortcut(current).some((canonical) => proposed.has(canonical))
    ) {
      return {
        valid: false,
        commandId,
        conflictingCommandId: definition.id,
      };
    }
  }
  return { valid: true };
}

export function validateShortcutMap(shortcuts: ShortcutMap): ShortcutValidationResult {
  for (const definition of COMMAND_REGISTRY) {
    const result = validateShortcutAssignment(definition.id, shortcuts[definition.id], shortcuts);
    if (!result.valid) return result;
  }
  return { valid: true };
}

export function createDefaultShortcutMap(): ShortcutMap {
  return Object.freeze(
    Object.fromEntries(
      COMMAND_REGISTRY.map(({ id, defaultShortcut }) => [id, defaultShortcut]),
    ) as Record<CommandId, ShortcutGesture | null>,
  );
}

export function applyShortcutOverrides(overrides: ShortcutOverrides): ShortcutMap {
  const defaults = createDefaultShortcutMap();
  return Object.freeze(
    Object.fromEntries(
      COMMAND_REGISTRY.map(({ id }) => [
        id,
        Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id]! : defaults[id],
      ]),
    ) as Record<CommandId, ShortcutGesture | null>,
  );
}

function assertRegistryInvariants(): void {
  const ids = new Set<CommandId>();
  for (const definition of COMMAND_REGISTRY) {
    if (ids.has(definition.id)) throw new Error(`Duplicate command ID: ${definition.id}`);
    ids.add(definition.id);
    if (definition.label.trim() === "") throw new Error(`Command ${definition.id} has no label`);
    if (definition.defaultShortcut !== null && !isShortcutGesture(definition.defaultShortcut)) {
      throw new Error(`Command ${definition.id} has an invalid default shortcut`);
    }
  }
  const validation = validateShortcutMap(createDefaultShortcutMap());
  if (!validation.valid) {
    throw new Error(
      `Default shortcut collision: ${validation.commandId} and ${validation.conflictingCommandId}`,
    );
  }
}

assertRegistryInvariants();
