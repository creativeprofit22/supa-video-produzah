import { RotateCcw, Settings2, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import {
  COMMAND_REGISTRY,
  formatShortcut,
  getCommandDefinition,
  normalizeKeyboardEvent,
  type CommandId,
} from "./command-registry";
import { useCommandPreferences } from "./CommandProvider";

interface ShortcutSettingsProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}

function closeNativeDialog(dialog: HTMLDialogElement | null): void {
  if (dialog?.open !== true) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

export function ShortcutSettings({ open, onClose, returnFocusRef }: ShortcutSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const recorderRefs = useRef(new Map<CommandId, HTMLButtonElement>());
  const [recordingId, setRecordingId] = useState<CommandId | null>(null);
  const [collision, setCollision] = useState<{ id: CommandId; message: string } | null>(null);
  const [status, setStatus] = useState("");
  const {
    shortcuts,
    overrides,
    preferenceError,
    assignShortcut,
    resetShortcut,
    resetAllShortcuts,
  } = useCommandPreferences();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      closeButtonRef.current?.focus();
    } else if (!open && dialog.open) {
      closeNativeDialog(dialog);
    }
  }, [open]);

  useEffect(() => {
    if (recordingId !== null) recorderRefs.current.get(recordingId)?.focus();
  }, [recordingId]);

  const close = () => {
    closeNativeDialog(dialogRef.current);
    setRecordingId(null);
    setCollision(null);
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };

  const beginRecording = (id: CommandId) => {
    setCollision(null);
    setRecordingId(id);
    setStatus(`Recording a new shortcut for ${getCommandDefinition(id).label}.`);
  };

  const recordShortcut = (id: CommandId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setRecordingId(null);
      setCollision(null);
      setStatus(`Shortcut change cancelled for ${getCommandDefinition(id).label}.`);
      return;
    }
    if (event.key === "Tab") return;
    if (event.repeat || event.nativeEvent.isComposing) return;
    const shortcut = normalizeKeyboardEvent(event.nativeEvent);
    if (shortcut === null) {
      event.preventDefault();
      event.stopPropagation();
      setCollision({
        id,
        message:
          "That key cannot be assigned. Press a letter, number, function, or navigation key.",
      });
      setStatus("Invalid shortcut. Choose another key combination.");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const result = assignShortcut(id, shortcut);
    if (!result.updated) {
      const command = getCommandDefinition(id);
      const conflictingCommand = getCommandDefinition(result.validation.conflictingCommandId);
      const message = `${command.label} conflicts with ${conflictingCommand.label}. The current shortcut was not changed.`;
      setCollision({ id, message });
      setStatus(message);
      return;
    }
    setRecordingId(null);
    setCollision(null);
    const shortcutLabel = formatShortcut(shortcut);
    setStatus(
      result.saved
        ? `${getCommandDefinition(id).label} changed to ${shortcutLabel}.`
        : (result.error ?? `${getCommandDefinition(id).label} changed for this session.`),
    );
  };

  const clearShortcut = (id: CommandId) => {
    const result = assignShortcut(id, null);
    if (!result.updated) return;
    setRecordingId(null);
    setCollision(null);
    setStatus(
      result.saved
        ? `${getCommandDefinition(id).label} shortcut cleared.`
        : (result.error ?? `${getCommandDefinition(id).label} cleared for this session.`),
    );
  };

  const resetOne = (id: CommandId) => {
    const result = resetShortcut(id);
    if (!result.updated) {
      const command = getCommandDefinition(id);
      const conflictingCommand = getCommandDefinition(result.validation.conflictingCommandId);
      const message = `${command.label} cannot be reset because its default conflicts with ${conflictingCommand.label}. The current shortcut was not changed.`;
      setCollision({ id, message });
      setStatus(message);
      return;
    }
    setRecordingId(null);
    setCollision(null);
    setStatus(
      result.saved
        ? `${getCommandDefinition(id).label} reset to its default shortcut.`
        : (result.error ?? `${getCommandDefinition(id).label} reset for this session.`),
    );
  };

  const resetAll = () => {
    const result = resetAllShortcuts();
    if (!result.updated) return;
    setRecordingId(null);
    setCollision(null);
    setStatus(
      result.saved
        ? "All keyboard shortcuts reset to defaults."
        : (result.error ?? "All shortcuts reset for this session."),
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="shortcut-dialog"
      aria-labelledby="shortcut-dialog-title"
      aria-describedby="shortcut-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="shortcut-dialog-heading">
        <div>
          <p className="state-kicker">Application preferences</p>
          <h2 id="shortcut-dialog-title">Keyboard shortcuts</h2>
        </div>
        <button
          ref={closeButtonRef}
          className="secondary-button compact-button shortcut-dialog-close"
          type="button"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
          Close
        </button>
      </div>
      <p id="shortcut-dialog-description" className="shortcut-dialog-description">
        Change, turn off, or restore application shortcuts. A shortcut can belong to only one
        command.
      </p>

      <ul className="shortcut-list">
        {COMMAND_REGISTRY.map((definition) => {
          const shortcut = shortcuts[definition.id];
          const shortcutLabel = formatShortcut(shortcut);
          const overridden = Object.prototype.hasOwnProperty.call(overrides, definition.id);
          const recording = recordingId === definition.id;
          const rowCollision = collision?.id === definition.id ? collision.message : null;
          return (
            <li className="shortcut-row" key={definition.id}>
              <div className="shortcut-summary">
                <strong>{definition.label}</strong>
                <span className="shortcut-value">
                  {shortcutLabel === null ? <span>Off</span> : <kbd>{shortcutLabel}</kbd>}
                  <small>
                    {shortcut === null ? "Disabled" : overridden ? "Custom" : "Default"}
                  </small>
                </span>
              </div>
              <div className="shortcut-actions">
                <button
                  ref={(element) => {
                    if (element === null) recorderRefs.current.delete(definition.id);
                    else recorderRefs.current.set(definition.id, element);
                  }}
                  className={`secondary-button compact-button${recording ? " is-recording" : ""}`}
                  type="button"
                  aria-label={`${recording ? "Record" : "Change"} shortcut for ${definition.label}`}
                  aria-describedby={
                    rowCollision === null ? undefined : `shortcut-error-${definition.id}`
                  }
                  onClick={() => beginRecording(definition.id)}
                  onKeyDown={
                    recording ? (event) => recordShortcut(definition.id, event) : undefined
                  }
                >
                  <Settings2 size={14} aria-hidden="true" />
                  {recording ? "Press shortcut…" : "Change"}
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  aria-label={`Clear shortcut for ${definition.label}`}
                  disabled={shortcut === null}
                  onClick={() => clearShortcut(definition.id)}
                >
                  Clear
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  aria-label={`Reset shortcut for ${definition.label}`}
                  disabled={!overridden}
                  onClick={() => resetOne(definition.id)}
                >
                  Reset
                </button>
              </div>
              {rowCollision === null ? null : (
                <p className="shortcut-error" id={`shortcut-error-${definition.id}`} role="alert">
                  {rowCollision}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="shortcut-dialog-footer">
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={Object.keys(overrides).length === 0}
          onClick={resetAll}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Reset all
        </button>
        <p className="shortcut-storage-status">
          Shortcuts are stored on this device, outside project files.
        </p>
      </div>
      {preferenceError === null ? null : (
        <p className="shortcut-persistence-error" role="status">
          {preferenceError}
        </p>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {status}
      </p>
    </dialog>
  );
}
