/// <reference types="vite/client" />
import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/App.css";
import { CommandProvider } from "../src/commands/CommandProvider";
import { ProgramMonitor, type ProgramMonitorLayer } from "../src/video/ProgramMonitor";

// Real nodes only. Both analysers are parallel sinks with UNCONNECTED outputs.
// The production source -> gain -> destination connection is untouched.
const taps: {
  context: AudioContext;
  input?: AnalyserNode;
  output?: AnalyserNode;
  media?: HTMLMediaElement;
}[] = [];
const NativeContext = window.AudioContext;
class ObservedContext extends NativeContext {
  record = { context: this } as (typeof taps)[number];
  constructor(options?: AudioContextOptions) {
    super(options);
    taps.push(this.record);
  }
  override createMediaElementSource(media: HTMLMediaElement) {
    const source = super.createMediaElementSource(media);
    const input = this.createAnalyser();
    input.fftSize = 2048;
    source.connect(input);
    Object.assign(this.record, { input, media });
    return source;
  }
  override createGain() {
    const gain = super.createGain();
    const output = this.createAnalyser();
    output.fftSize = 2048;
    gain.connect(output);
    this.record.output = output;
    return gain;
  }
}
window.AudioContext = ObservedContext;
Object.assign(window, { audioTaps: taps, NativeAudioContext: NativeContext });
const params = new URLSearchParams(location.search);
const speed = Number(params.get("speed") ?? 1);
const rate = { numerator: 30, denominator: 1 };
const media = "/browser-tests/ProgramMonitorAudio.mp4";
const identity = (path: string) => path;
function Fixture() {
  const [playhead, setPlayhead] = useState(0);
  const [gain, setGain] = useState(-6000);
  const [fades, setFades] = useState(false);
  const [raw, setRaw] = useState(false);
  const layers = useMemo<ProgramMonitorLayer[]>(
    () =>
      raw
        ? []
        : [
            {
              clipId: "audio-proof",
              path: media,
              canonicalTrackIndex: 0,
              timelineStartFrame: 0,
              sourceInFrame: 30,
              sourceOutFrame: 30 + 150 * speed,
              timelineDurationFrames: 150,
              sourceRate: rate,
              speed: { numerator: speed, denominator: 1 },
              positionXPermille: 0,
              positionYPermille: 0,
              scaleXPermille: 1000,
              scaleYPermille: 1000,
              rotationMilliDegrees: 0,
              opacityPermille: 1000,
              hidden: false,
              muted: false,
              hasAudio: true,
              audioOnly: params.has("audioOnly"),
              gainMilliDecibels: gain,
              fades: { inFrames: fades ? 60 : 0, outFrames: fades ? 60 : 0 },
            },
          ],
    [gain, fades, raw],
  );
  return (
    <CommandProvider>
      <main style={{ maxWidth: 800 }}>
        <output data-testid="program-frame">{playhead}</output>
        <button onClick={() => setGain(-6000)}>Minus six</button>
        <button onClick={() => setGain(6000)}>Plus six</button>
        <button
          onClick={() => {
            setGain(0);
            setFades(false);
          }}
        >
          Reset effects
        </button>
        <button
          onClick={() => {
            setGain(0);
            setFades(true);
            setPlayhead(0);
          }}
        >
          Enable fades
        </button>
        <button onClick={() => setPlayhead(0)}>Rewind</button>
        <button onClick={() => setRaw(true)}>Raw audition</button>
        <ProgramMonitor
          proxyPath={media}
          finalPreviewPath={media}
          hasAudio
          timelineAudioMuted={false}
          timelineVideoHidden={false}
          sourceLayers={layers}
          convertCachePath={identity}
          rate={rate}
          trimIn={0}
          trimOut={360}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
        />
      </main>
    </CommandProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Fixture />);
