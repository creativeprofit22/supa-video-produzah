import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { DEFAULT_CLIP_TRANSFORM_GEOMETRY } from "@supa-video/contracts";
import { useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import {
  ClipInspector,
  type ClipOpacityDraft,
  type ClipTransformDraft,
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
  transform: { ...DEFAULT_CLIP_TRANSFORM_GEOMETRY, opacityPermille: 425 },
  opacityPermille: 425,
  locked: fixtureState === "locked",
};

const saveError =
  fixtureState === "error"
    ? new Error("The saved revision changed. Review the current clip and try again.")
    : null;

function Fixture() {
  const [opacityPermille, setOpacityPermille] = useState(selectedClip.opacityPermille);
  const [transform, setTransform] = useState(selectedClip.transform);
  const [saving, setSaving] = useState(fixtureState === "saving");

  const markSaving = () => {
    if (fixtureState !== "editable") return;
    setSaving(true);
    window.setTimeout(() => setSaving(false), 250);
  };
  const commitOpacity = (draft: ClipOpacityDraft) => {
    setOpacityPermille(draft.opacityPermille);
    markSaving();
  };
  const commitTransform = (draft: ClipTransformDraft) => {
    setTransform(draft.transform);
    markSaving();
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
          selection={{ ...selectedClip, transform }}
          transform={transform}
          opacityPermille={opacityPermille}
          disabled={saving}
          saving={saving}
          error={saveError}
          onDraftChange={(draft) => setOpacityPermille(draft.opacityPermille)}
          onCommit={commitOpacity}
          onTransformDraftChange={(draft) => setTransform(draft.transform)}
          onTransformCommit={commitTransform}
        />
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
