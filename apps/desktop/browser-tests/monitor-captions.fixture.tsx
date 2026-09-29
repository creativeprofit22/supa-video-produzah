/// <reference types="vite/client" />
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/App.css";
import { CommandProvider } from "../src/commands/CommandProvider";
import { ProgramMonitor, type ProgramMonitorLayer } from "../src/video/ProgramMonitor";

// Program monitor with a live caption overlay, framed as 16:9, 1:1 or 9:16.
const params = new URLSearchParams(location.search);
const frames = {
  "16x9": { width: 1920, height: 1080 },
  "1x1": { width: 1080, height: 1080 },
  "9x16": { width: 1080, height: 1920 },
} as const;
const aspect = params.get("aspect");
const frame = aspect === "1x1" || aspect === "9x16" ? frames[aspect] : frames["16x9"];
const rate = { numerator: 30, denominator: 1 };
const media = "/browser-tests/ProgramMonitorAudio.mp4";
const layers: readonly ProgramMonitorLayer[] = [
  {
    clipId: "caption-proof",
    path: media,
    canonicalTrackIndex: 0,
    timelineStartFrame: 0,
    sourceInFrame: 0,
    sourceOutFrame: 150,
    timelineDurationFrames: 150,
    sourceRate: rate,
    positionXPermille: 0,
    positionYPermille: 0,
    scaleXPermille: 1000,
    scaleYPermille: 1000,
    rotationMilliDegrees: 0,
    opacityPermille: 1000,
    hidden: false,
    muted: true,
    hasAudio: false,
  },
];
const captions = [
  { captionId: "cue-1", text: "Speaker one: the launch window opens at dawn," },
  { captionId: "cue-2", text: "so every checklist item must close before then." },
];
const identity = (path: string): string => path;

function Fixture() {
  const [playhead, setPlayhead] = useState(30);
  return (
    <CommandProvider>
      <main>
        <ProgramMonitor
          proxyPath={media}
          finalPreviewPath={media}
          hasAudio={false}
          timelineAudioMuted
          timelineVideoHidden={false}
          sourceLayers={layers}
          activeCaptions={captions}
          convertCachePath={identity}
          frame={frame}
          rate={rate}
          trimIn={0}
          trimOut={150}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
        />
      </main>
    </CommandProvider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("fixture root is missing");
ReactDOM.createRoot(root).render(<Fixture />);
