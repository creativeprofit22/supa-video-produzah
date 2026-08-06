import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import {
  COMMAND_REGISTRY,
  applyShortcutOverrides,
  formatShortcut,
  getCommandDefinition,
  matchesShortcut,
  normalizeKeyboardEvent,
  toAriaKeyShortcuts,
  validateShortcutAssignment,
  validateShortcutMap,
  type CommandId,
  type ExactShortcutGesture,
  type ShortcutGesture,
  type ShortcutMap,
  type ShortcutOverrides,
  type ShortcutValidationResult,
} from "./command-registry";
import {
  loadShortcutPreferences,
  resetShortcutOverride,
  saveShortcutPreferences,
  setShortcutOverride,
  type ShortcutPreferenceStorage,
} from "./shortcut-preferences";

export type CommandExecutionSource = "button" | "keyboard";

export interface CommandHandlerOptions {
  readonly canExecute: boolean;
  readonly execute: (source: CommandExecutionSource) => void | Promise<void>;
  readonly keyboardScopeRef?: RefObject<HTMLElement | null>;
}

interface RuntimeHandlerRegistration {
  readonly token: symbol;
  readonly current: { current: CommandHandlerOptions };
}

export interface CommandState {
  readonly id: CommandId;
  readonly label: string;
  readonly shortcut: ShortcutGesture | null;
  readonly shortcutLabel: string | null;
  readonly ariaKeyShortcuts: string | undefined;
  readonly canExecute: boolean;
  readonly execute: () => boolean;
}

export type ShortcutUpdateResult =
  | {
      readonly updated: false;
      readonly validation: Exclude<ShortcutValidationResult, { readonly valid: true }>;
    }
  | {
      readonly updated: true;
      readonly saved: boolean;
      readonly error: string | null;
    };

export interface CommandPreferencesState {
  readonly shortcuts: ShortcutMap;
  readonly overrides: ShortcutOverrides;
  readonly preferenceError: string | null;
  readonly assignShortcut: (
    id: CommandId,
    shortcut: ExactShortcutGesture | null,
  ) => ShortcutUpdateResult;
  readonly resetShortcut: (id: CommandId) => ShortcutUpdateResult;
  readonly resetAllShortcuts: () => ShortcutUpdateResult;
}

interface CommandContextValue extends CommandPreferencesState {
  readonly handlers: React.MutableRefObject<Map<CommandId, RuntimeHandlerRegistration>>;
  readonly executeCommand: (id: CommandId, source: CommandExecutionSource) => boolean;
  readonly notifyHandlersChanged: () => void;
}

const CommandContext = createContext<CommandContextValue | null>(null);

const unavailableStorage: ShortcutPreferenceStorage = {
  getItem() {
    throw new Error("Storage is unavailable");
  },
  setItem() {
    throw new Error("Storage is unavailable");
  },
  removeItem() {
    throw new Error("Storage is unavailable");
  },
};

function browserStorage(): ShortcutPreferenceStorage {
  try {
    return window.localStorage;
  } catch {
    return unavailableStorage;
  }
}

function eventTargetElement(event: KeyboardEvent): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

function eventPathElements(event: KeyboardEvent): HTMLElement[] {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = path.filter((target): target is HTMLElement => target instanceof HTMLElement);
  const target = eventTargetElement(event);
  return elements.length > 0 ? elements : target === null ? [] : [target];
}

function editableTargetOwnsEvent(event: KeyboardEvent): boolean {
  return eventPathElements(event).some((element) => {
    const role = element.getAttribute("role");
    const contentEditable = element.getAttribute("contenteditable");
    return (
      element.matches("input, textarea, select") ||
      element.isContentEditable ||
      (contentEditable !== null && contentEditable !== "false") ||
      role === "textbox" ||
      role === "searchbox"
    );
  });
}

function nativeActivationTargetOwnsApplicationSpace(event: KeyboardEvent): boolean {
  if (event.code !== "Space") return false;
  return eventPathElements(event).some((element) => {
    const role = element.getAttribute("role");
    return element.matches("button, a[href], summary") || role === "button" || role === "link";
  });
}

function interactiveTargetOwnsTransport(event: KeyboardEvent): boolean {
  const target = eventTargetElement(event);
  if (target === null) return false;
  if (target.closest("button, a, video, input, textarea, select") !== null) return true;
  return (
    (event.code === "ArrowLeft" || event.code === "ArrowRight") &&
    target.closest(".multitrack-scroll-region") !== null
  );
}

function interactiveTargetOwnsTimeline(target: HTMLElement | null): boolean {
  const interactive = target?.closest("button, a, input, textarea, select, form") ?? null;
  if (interactive === null) return false;
  return (
    !interactive.classList.contains("multitrack-clip-body") ||
    interactive.getAttribute("aria-pressed") !== "true"
  );
}

function hasOpenDialog(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

function commandAcceptsKeyboardEvent(
  id: CommandId,
  registration: RuntimeHandlerRegistration,
  event: KeyboardEvent,
): boolean {
  const definition = getCommandDefinition(id);
  if (event.repeat && !definition.allowRepeat) return false;
  const target = eventTargetElement(event);
  if (editableTargetOwnsEvent(event)) return false;
  if (definition.keyboardContext === "application") {
    return !nativeActivationTargetOwnsApplicationSpace(event);
  }
  if (definition.keyboardContext === "transport") {
    return !interactiveTargetOwnsTransport(event);
  }
  if (definition.keyboardContext === "timeline") {
    const scope = registration.current.current.keyboardScopeRef?.current;
    return (
      scope !== null &&
      scope !== undefined &&
      target !== null &&
      scope.contains(target) &&
      !interactiveTargetOwnsTimeline(target)
    );
  }
  return true;
}

export interface CommandProviderProps {
  readonly children: ReactNode;
  readonly storage?: ShortcutPreferenceStorage;
}

export function CommandProvider({ children, storage: suppliedStorage }: CommandProviderProps) {
  const storageRef = useRef<ShortcutPreferenceStorage>(suppliedStorage ?? browserStorage());
  const initialPreferencesRef = useRef<ReturnType<typeof loadShortcutPreferences> | null>(null);
  if (initialPreferencesRef.current === null) {
    initialPreferencesRef.current = loadShortcutPreferences(storageRef.current);
  }
  const initialPreferences = initialPreferencesRef.current;
  const [overrides, setOverrides] = useState<ShortcutOverrides>(initialPreferences.overrides);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(initialPreferences.shortcuts);
  const [preferenceError, setPreferenceError] = useState<string | null>(initialPreferences.error);
  const preferencesRef = useRef({ overrides, shortcuts });
  preferencesRef.current = { overrides, shortcuts };
  const handlers = useRef(new Map<CommandId, RuntimeHandlerRegistration>());
  const [registryRevision, setRegistryRevision] = useState(0);
  const notifyHandlersChanged = useCallback(() => {
    setRegistryRevision((revision) => revision + 1);
  }, []);

  const executeCommand = useCallback((id: CommandId, source: CommandExecutionSource): boolean => {
    const registration = handlers.current.get(id);
    if (registration === undefined || !registration.current.current.canExecute) return false;
    void registration.current.current.execute(source);
    return true;
  }, []);

  const commitOverrides = useCallback((nextOverrides: ShortcutOverrides): ShortcutUpdateResult => {
    const nextShortcuts = applyShortcutOverrides(nextOverrides);
    preferencesRef.current = { overrides: nextOverrides, shortcuts: nextShortcuts };
    setOverrides(nextOverrides);
    setShortcuts(nextShortcuts);
    const result = saveShortcutPreferences(storageRef.current, nextOverrides);
    setPreferenceError(result.error);
    return { updated: true, ...result };
  }, []);

  const assignShortcut = useCallback(
    (id: CommandId, shortcut: ExactShortcutGesture | null): ShortcutUpdateResult => {
      const validation = validateShortcutAssignment(id, shortcut, preferencesRef.current.shortcuts);
      if (!validation.valid) return { updated: false, validation };
      return commitOverrides(setShortcutOverride(preferencesRef.current.overrides, id, shortcut));
    },
    [commitOverrides],
  );

  const resetShortcut = useCallback(
    (id: CommandId): ShortcutUpdateResult => {
      const nextOverrides = resetShortcutOverride(preferencesRef.current.overrides, id);
      const validation = validateShortcutMap(applyShortcutOverrides(nextOverrides));
      if (!validation.valid) return { updated: false, validation };
      return commitOverrides(nextOverrides);
    },
    [commitOverrides],
  );

  const resetAllShortcuts = useCallback(
    (): ShortcutUpdateResult => commitOverrides(Object.freeze({})),
    [commitOverrides],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key === "Unidentified" ||
        hasOpenDialog() ||
        normalizeKeyboardEvent(event) === null
      ) {
        return;
      }
      for (const definition of COMMAND_REGISTRY) {
        const shortcut = preferencesRef.current.shortcuts[definition.id];
        if (shortcut === null || !matchesShortcut(event, shortcut)) continue;
        const registration = handlers.current.get(definition.id);
        if (
          registration === undefined ||
          !registration.current.current.canExecute ||
          !commandAcceptsKeyboardEvent(definition.id, registration, event)
        ) {
          return;
        }
        if (executeCommand(definition.id, "keyboard")) event.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [executeCommand]);

  const value = useMemo<CommandContextValue>(
    () => ({
      handlers,
      executeCommand,
      notifyHandlersChanged,
      shortcuts,
      overrides,
      preferenceError,
      assignShortcut,
      resetShortcut,
      resetAllShortcuts,
    }),
    [
      assignShortcut,
      executeCommand,
      notifyHandlersChanged,
      overrides,
      preferenceError,
      registryRevision,
      resetAllShortcuts,
      resetShortcut,
      shortcuts,
    ],
  );

  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>;
}

function useCommandContext(): CommandContextValue {
  const context = useContext(CommandContext);
  if (context === null) throw new Error("Command hooks require a CommandProvider");
  return context;
}

export function useCommandHandler(id: CommandId, options: CommandHandlerOptions): void {
  const { handlers, notifyHandlersChanged } = useCommandContext();
  const tokenRef = useRef(Symbol(id));
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useLayoutEffect(() => {
    const existing = handlers.current.get(id);
    if (existing !== undefined && existing.token !== tokenRef.current) {
      throw new Error(`Duplicate runtime handler registered for command: ${id}`);
    }
    handlers.current.set(id, { token: tokenRef.current, current: optionsRef });
    notifyHandlersChanged();
    return () => {
      if (handlers.current.get(id)?.token === tokenRef.current) {
        handlers.current.delete(id);
        notifyHandlersChanged();
      }
    };
  }, [handlers, id, notifyHandlersChanged]);

  useLayoutEffect(() => {
    if (handlers.current.get(id)?.token === tokenRef.current) notifyHandlersChanged();
  }, [handlers, id, notifyHandlersChanged, options.canExecute, options.keyboardScopeRef]);
}

export function useCommand(id: CommandId): CommandState {
  const { handlers, shortcuts, executeCommand } = useCommandContext();
  const definition = getCommandDefinition(id);
  const shortcut = shortcuts[id];
  const canExecute = handlers.current.get(id)?.current.current.canExecute ?? false;
  return {
    id,
    label: definition.label,
    shortcut,
    shortcutLabel: formatShortcut(shortcut),
    ariaKeyShortcuts: canExecute ? toAriaKeyShortcuts(shortcut) : undefined,
    canExecute,
    execute: () => executeCommand(id, "button"),
  };
}

export function useCommandPreferences(): CommandPreferencesState {
  const {
    shortcuts,
    overrides,
    preferenceError,
    assignShortcut,
    resetShortcut,
    resetAllShortcuts,
  } = useCommandContext();
  return {
    shortcuts,
    overrides,
    preferenceError,
    assignShortcut,
    resetShortcut,
    resetAllShortcuts,
  };
}
