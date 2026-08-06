import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import { CommandProvider, useCommand, useCommandHandler } from "../src/commands/CommandProvider";
import { ShortcutSettings } from "../src/commands/ShortcutSettings";

function CommandRegistryFixture() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [executionCount, setExecutionCount] = useState(0);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const timelineRef = useRef<HTMLElement>(null);

  useCommandHandler("app.openShortcutSettings", {
    canExecute: !settingsOpen,
    execute: (source) => {
      returnFocusRef.current =
        source === "button"
          ? settingsButtonRef.current
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      setSettingsOpen(true);
    },
  });
  useCommandHandler("timeline.splitSelectedClip", {
    canExecute: true,
    execute: () => setExecutionCount((count) => count + 1),
    keyboardScopeRef: timelineRef,
  });

  const settingsCommand = useCommand("app.openShortcutSettings");
  const splitCommand = useCommand("timeline.splitSelectedClip");

  return (
    <main className="command-registry-fixture shared-rail">
      <header className="command-registry-fixture-heading">
        <div>
          <p className="state-kicker">Phase 4 fixture</p>
          <h1>Application command registry</h1>
        </div>
        <button
          ref={settingsButtonRef}
          className="secondary-button"
          type="button"
          disabled={!settingsCommand.canExecute}
          aria-keyshortcuts={settingsCommand.ariaKeyShortcuts}
          onClick={settingsCommand.execute}
        >
          Keyboard shortcuts
        </button>
      </header>

      <section
        ref={timelineRef}
        className="panel command-registry-command"
        aria-labelledby="fixture-command"
      >
        <div>
          <p className="eyebrow">Timeline command</p>
          <h2 id="fixture-command">Split selected clip</h2>
          <p>Use this focus target to prove remapped timeline dispatch and persistence.</p>
        </div>
        <button
          type="button"
          className="multitrack-clip-body secondary-button"
          aria-pressed="true"
          aria-keyshortcuts={splitCommand.ariaKeyShortcuts}
          onClick={splitCommand.execute}
        >
          Selected clip target
          {splitCommand.shortcutLabel !== null ? (
            <kbd className="command-shortcut-hint" aria-hidden="true">
              {splitCommand.shortcutLabel}
            </kbd>
          ) : null}
        </button>
        <output aria-live="polite">Executed {executionCount} times</output>
      </section>

      <ShortcutSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        returnFocusRef={returnFocusRef}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CommandProvider>
      <CommandRegistryFixture />
    </CommandProvider>
  </React.StrictMode>,
);
