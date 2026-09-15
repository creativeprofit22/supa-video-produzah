import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { DEFAULT_CLIP_TRANSFORM_GEOMETRY, type ClipSpeed } from "@supa-video/contracts";
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

const speedMode = new URLSearchParams(window.location.search).has("speed");
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
  // Browser interaction harness, not the canonical project/history service.
  const [speed, setSpeed] = useState<ClipSpeed>({ numerator: 1, denominator: 1 });
  const [revision, setRevision] = useState(0);
  const [commits, setCommits] = useState(0);
  const [history, setHistory] = useState<ClipSpeed[]>([]);
  const [clipId, setClipId] = useState(selectedClip.clipId);

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
          selection={{
            ...selectedClip,
            clipId,
            transform,
            ...(speedMode
              ? {
                  speedTiming: {
                    speed,
                    sourceIn: { value: 0, rateNumerator: 30, rateDenominator: 1 },
                    sourceOut: { value: 300, rateNumerator: 30, rateDenominator: 1 },
                    sequenceRate: { numerator: 30, denominator: 1 },
                  },
                }
              : {}),
          }}
          revisionKey={String(revision)}
          speedSaving={speedMode && saving}
          speedError={speedMode ? saveError : null}
          onSpeedCommit={
            speedMode
              ? (edit) => {
                  setCommits((value) => value + 1);
                  setSaving(true);
                  window.setTimeout(() => {
                    if (fixtureState !== "error") {
                      setHistory((values) => [...values, speed]);
                      setSpeed(edit.speed);
                      setRevision((value) => value + 1);
                    }
                    setSaving(false);
                  }, 250);
                }
              : () => undefined
          }
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
        {speedMode ? (
          <aside aria-label="Browser fixture history">
            <p data-testid="speed-revision">Revision: {revision}</p>
            <p data-testid="speed-commits">Commits: {commits}</p>
            <button
              disabled={saving || history.length === 0}
              onClick={() => {
                setSpeed(history[history.length - 1]!);
                setHistory((values) => values.slice(0, -1));
                setRevision((value) => value + 1);
              }}
            >
              Fixture undo
            </button>
            <button onClick={() => setClipId((value) => `${value}-next`)}>
              Fixture select next clip
            </button>
            <button onClick={() => setRevision((value) => value + 1)}>
              Fixture external revision
            </button>
          </aside>
        ) : null}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
