import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import {
  ClipInspector,
  type ClipOpacityDraft,
  type SelectedVideoClip,
} from "../src/video/ClipInspector";

type FixtureState = "editable" | "locked" | "saving" | "error";

const requestedState = new URLSearchParams(window.location.search).get("state");
const fixtureState: FixtureState =
  requestedState === "locked" || requestedState === "saving" || requestedState === "error"
    ? requestedState
    : "editable";

const selectedClip: SelectedVideoClip = {
  sequenceId: "sequence-browser-fixture",
  trackId: "track-browser-fixture",
  clipId: "clip-browser-fixture",
  clipLabel: `Launch interview — ${"extended localized clip name ".repeat(3)}`,
  trackLabel: "Primary picture and compositing track",
  opacityPermille: 425,
  locked: fixtureState === "locked",
};

const saveError =
  fixtureState === "error"
    ? new Error("The saved revision changed. Review the current clip and try again.")
    : null;

function Fixture() {
  const [opacityPermille, setOpacityPermille] = useState(selectedClip.opacityPermille);
  const [saving, setSaving] = useState(fixtureState === "saving");

  const commitOpacity = (draft: ClipOpacityDraft) => {
    setOpacityPermille(draft.opacityPermille);
    if (fixtureState !== "editable") return;
    setSaving(true);
    window.setTimeout(() => setSaving(false), 250);
  };

  return (
    <main
      className="shared-rail"
      style={{
        display: "grid",
        minHeight: "100vh",
        placeItems: "center",
        paddingBlock: 24,
      }}
    >
      <div style={{ width: "min(100%, 420px)" }}>
        <ClipInspector
          selection={selectedClip}
          opacityPermille={opacityPermille}
          disabled={saving}
          saving={saving}
          error={saveError}
          onDraftChange={(draft) => setOpacityPermille(draft.opacityPermille)}
          onCommit={commitOpacity}
        />
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
