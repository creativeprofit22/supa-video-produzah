/// <reference types="vite/client" />
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/App.css";
import { CommandProvider } from "../src/commands/CommandProvider";
import { ProgramMonitor, type ProgramMonitorLayer } from "../src/video/ProgramMonitor";

const params = new URLSearchParams(location.search);
const percent = Number(params.get("speed") ?? 100);
const raw = params.has("raw");
const parity = params.has("parity");
const fractional = parity && params.has("fractional");
const rate = fractional ? { numerator: 30000, denominator: 1001 } : { numerator: 30, denominator: 1 };
const speed = percent === 50 ? [1, 2] : percent === 150 ? [3, 2] : [percent / 100, 1];
const stem = `/browser-tests/speed-parity-${rate.numerator}-${rate.denominator}`;
const media = parity ? `${stem}.mp4` : "/browser-tests/speed-media.mp4";
const finalMedia = parity ? `${stem}-${speed[0]}-${speed[1]}.mp4` : media;
const duration = parity ? 60 : 18000 / percent;
const layers: ProgramMonitorLayer[] = [
  {
    clipId: "real-speed",
    path: media,
    canonicalTrackIndex: 0,
    timelineStartFrame: 0,
    sourceInFrame: 30,
    sourceOutFrame: parity ? 30 + 60 * percent / 100 : 210,
    timelineDurationFrames: duration,
    sourceRate: rate,
    speed: { numerator: percent, denominator: 100 },
    positionXPermille: 0,
    positionYPermille: 0,
    scaleXPermille: 1000,
    scaleYPermille: 1000,
    rotationMilliDegrees: 0,
    opacityPermille: 1000,
    hidden: false,
    muted: false,
    hasAudio: true,
  },
];
const identity = (path: string) => path;
function Fixture() {
  const [playhead, setPlayhead] = useState(0);
  return (
    <CommandProvider>
      <main style={{ maxWidth: 800 }}>
        <h1>
          Real media speed {percent}% {raw ? "raw audition" : "composition"}
        </h1>
        <output data-testid="program-frame">{playhead}</output>
        <button onClick={() => setPlayhead(30)}>Seek program 1s</button>
        {parity && <label>Parity frame<input data-testid="parity-seek" type="number" value={playhead} onChange={(event) => setPlayhead(Number(event.target.value))} /></label>}
        <button onClick={() => setPlayhead(duration - 15)}>Seek near end</button>
        <ProgramMonitor
          proxyPath={media}
          finalPreviewPath={finalMedia}
          hasAudio
          timelineAudioMuted={false}
          timelineVideoHidden={false}
          sourceLayers={raw ? [] : layers}
          convertCachePath={identity}
          rate={rate}
          trimIn={0}
          trimOut={parity ? duration : 300}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
        />
      </main>
    </CommandProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Fixture />);
