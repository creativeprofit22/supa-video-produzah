import type {
  LoudnessReport,
  SequenceLoudnessTarget,
  TrackAudioRole,
  VideoSequenceV2,
} from "@supa-video/contracts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import { AudioPanel } from "../src/video/AudioPanel";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const rate = { numerator: 30, denominator: 1 } as const;

const initial: VideoSequenceV2 = {
  id: id(2),
  name: "Main",
  rate,
  width: 1920,
  height: 1080,
  audioSampleRate: 48_000,
  markers: [],
  tracks: [
    { id: id(10), name: "Interview camera", kind: "video", clips: [] },
    { id: id(11), name: "Soundtrack", kind: "audio", clips: [] },
    { id: id(12), name: "Captions", kind: "caption", captions: [] },
  ],
};

const failedReport: LoudnessReport = {
  schemaVersion: 1,
  targetIntegratedLufs: -16,
  truePeakCeilingDbtp: -1,
  toleranceLu: 1,
  normalizationMode: "dynamic",
  normalizationReason: "loudness_range_above_target",
  measuredInputLufs: -31.4,
  outputIntegratedLufs: -17.6,
  outputTruePeakDbtp: -0.4,
  outputLoudnessRangeLu: 16.7,
  sourceClippedSamples: 42,
  ducking: true,
  dialogueCleanup: true,
  passed: false,
  findings: [
    "integrated_loudness_out_of_tolerance",
    "true_peak_above_ceiling",
    "dynamic_normalization_used",
    "source_mix_clipped",
  ],
};

function Fixture() {
  const [sequence, setSequence] = useState(initial);
  const [log, setLog] = useState("");
  return (
    <main style={{ padding: 12, maxWidth: 480 }}>
      <AudioPanel
        sequence={sequence}
        disabled={false}
        lastReport={failedReport}
        onSetRole={async (trackId: string, role: TrackAudioRole | null) => {
          setSequence((current) => ({
            ...current,
            tracks: current.tracks.map((track) => {
              if (track.id !== trackId || track.kind === "caption") return track;
              if (role !== null) return { ...track, audioRole: role };
              const next = { ...track };
              delete next.audioRole;
              return next;
            }),
          }));
          setLog(`role:${role ?? "none"}`);
          return true;
        }}
        onSetTarget={async (target: SequenceLoudnessTarget | null) => {
          if (target === null) {
            setSequence((current) => {
              const next = { ...current };
              delete next.loudnessTarget;
              return next;
            });
            setLog("target:none");
            return true;
          }
          setSequence((current) => ({ ...current, loudnessTarget: target }));
          setLog(
            `target:${target.integratedLufs}:${target.ducking ? "duck" : "-"}:${target.dialogueCleanup ? "clean" : "-"}`,
          );
          return true;
        }}
      />
      <output data-testid="fixture-log" style={{ overflowWrap: "anywhere" }}>
        {log}
      </output>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
ReactDOM.createRoot(root).render(<Fixture />);
