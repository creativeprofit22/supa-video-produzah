import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/App.css";
import { CommandProvider } from "../src/commands/CommandProvider";
import { ProgramMonitor, type ProgramMonitorLayer } from "../src/video/ProgramMonitor";
const mode = new URLSearchParams(location.search).get("mode") ?? "normal";
const gap = mode === "gap";
const rate = { numerator: 30, denominator: 1 };
const layers: ProgramMonitorLayer[] = ["red", "blue"].map((color, index) => ({
  clipId: color,
  path: `/browser-tests/completion-layer-${color}.mp4`,
  canonicalTrackIndex: index,
  timelineStartFrame: gap ? index * 30 : 0,
  sourceInFrame: 30,
  sourceOutFrame: gap ? 45 : index === 0 ? 120 : 60,
  timelineDurationFrames: gap ? 15 : 60,
  sourceRate: rate,
  speed: gap
    ? { numerator: 1, denominator: 1 }
    : index === 0
      ? { numerator: 3, denominator: 2 }
      : { numerator: 1, denominator: 2 },
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1000,
  scaleYPermille: 1000,
  rotationMilliDegrees: 0,
  opacityPermille: 1000,
  hidden: index === 0 && ["hidden", "both"].includes(mode),
  muted: index === 0 && ["muted", "both"].includes(mode),
  hasAudio: true,
}));
const identity = (path: string) => path;
function Fixture() {
  const [playhead, setPlayhead] = useState(0);
  const [raw, setRaw] = useState(false);
  return (
    <CommandProvider>
      <main style={{ maxWidth: 800 }}>
        <h1>Real-media multilayer {mode}</h1>
        <label>
          Seek frame
          <input
            aria-label="Seek frame"
            type="number"
            value={playhead}
            onChange={(event) => setPlayhead(Number(event.target.value))}
          />
        </label>
        <output data-testid="program-frame">{playhead}</output>
        <button onClick={() => setRaw((value) => !value)}>Toggle raw audition</button>
        <ProgramMonitor
          proxyPath={layers[0]!.path}
          finalPreviewPath={gap ? null : `/browser-tests/completion-layer-${mode}.mp4`}
          sourceLayers={raw ? [] : layers}
          hasAudio
          timelineAudioMuted={false}
          timelineVideoHidden={false}
          convertCachePath={identity}
          rate={rate}
          trimIn={0}
          trimOut={gap ? 45 : 60}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
        />
      </main>
    </CommandProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Fixture />);
