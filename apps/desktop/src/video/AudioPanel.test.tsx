// @vitest-environment jsdom

import type { VideoSequenceV2 } from "@supa-video/contracts";
import type { MusicBeatRuntimeStatus } from "@supa-video/media";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MusicBeatDetectionStatus } from "../use-music-beats";
import { AudioPanel, type AudioPanelMusicBeats } from "./AudioPanel";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const warning =
  "Ducking is on, but no unmuted track is marked Dialogue. Export will fail until you mark one as Dialogue or turn ducking off.";

function sequenceWith(
  track: { readonly audioRole: "dialogue" | "music"; readonly muted?: boolean },
  ducking: boolean,
): VideoSequenceV2 {
  return {
    id: id(1),
    name: "Main",
    rate: { numerator: 30, denominator: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [],
    loudnessTarget: {
      integratedLufs: -16,
      truePeakCeilingDbtp: -1,
      ducking,
      dialogueCleanup: false,
    },
    tracks: [{ id: id(2), name: "Interview camera", kind: "video", clips: [], ...track }],
  };
}

function renderPanel(sequence: VideoSequenceV2) {
  return render(
    <AudioPanel
      sequence={sequence}
      disabled={false}
      lastReport={null}
      onSetRole={vi.fn(async () => true)}
      onSetTarget={vi.fn(async () => true)}
    />,
  );
}

afterEach(cleanup);

describe("AudioPanel", () => {
  it.each([
    ["the only dialogue track became music", { audioRole: "music" } as const],
    ["the dialogue track is muted", { audioRole: "dialogue", muted: true } as const],
  ])("keeps warning while ducking is on and %s", (_case, track) => {
    renderPanel(sequenceWith(track, true));

    expect(screen.getByText(warning)).toBeTruthy();
    const ducking = screen.getByRole("checkbox", { name: "Lower music while dialogue plays" });
    expect(ducking.getAttribute("aria-describedby")).toBe(screen.getByText(warning).id);
  });

  it.each([
    ["ducking is off", { audioRole: "music" } as const, false],
    ["an unmuted dialogue track exists", { audioRole: "dialogue" } as const, true],
  ])("shows no warning when %s", (_case, track, ducking) => {
    renderPanel(sequenceWith(track, ducking));

    expect(screen.queryByText(warning)).toBeNull();
  });

  it("sends null when the user picks Not normalized or No role", () => {
    const onSetRole = vi.fn(async () => true);
    const onSetTarget = vi.fn(async () => true);
    render(
      <AudioPanel
        sequence={sequenceWith({ audioRole: "dialogue" }, false)}
        disabled={false}
        lastReport={null}
        onSetRole={onSetRole}
        onSetTarget={onSetTarget}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Target" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Interview camera" }), {
      target: { value: "" },
    });

    expect(onSetTarget).toHaveBeenCalledWith(null);
    expect(onSetRole).toHaveBeenCalledWith(id(2), null);
  });

  describe("music beats", () => {
    const musicAsset = id(50);
    const musicSequence = (): VideoSequenceV2 => ({
      ...sequenceWith({ audioRole: "dialogue" }, false),
      tracks: [
        {
          id: id(3),
          name: "Score",
          kind: "audio",
          audioRole: "music",
          clips: [
            {
              id: id(4),
              source: { kind: "asset", assetId: musicAsset },
              timelineStart: { value: 0, rateNumerator: 30, rateDenominator: 1 },
              sourceIn: { value: 0, rateNumerator: 30, rateDenominator: 1 },
              sourceOut: { value: 60, rateNumerator: 30, rateDenominator: 1 },
              transform: {
                positionXPermille: 0,
                positionYPermille: 0,
                scaleXPermille: 1_000,
                scaleYPermille: 1_000,
                rotationMilliDegrees: 0,
                opacityPermille: 1_000,
              },
              gainMilliDecibels: 0,
            },
          ],
        },
      ],
    });
    const runtime = (
      availability: MusicBeatRuntimeStatus["runtime"] = { state: "notConfigured" },
      accelerator: MusicBeatRuntimeStatus["accelerator"] = null,
    ): MusicBeatRuntimeStatus => ({
      runtimeFolder: availability.state === "notConfigured" ? null : "D:\\supa-music-beats",
      runtime: availability,
      accelerator,
      manifestSha256: "a".repeat(64),
      beatThisVersion: "rs-1.1.0",
      checkpointSha256: "b".repeat(64),
    });
    const panel = (
      detection: ReadonlyMap<string, MusicBeatDetectionStatus>,
      analyses: AudioPanelMusicBeats["analyses"] = new Map(),
      runtimeStatus: MusicBeatRuntimeStatus | null = runtime(),
    ) => {
      const musicBeats = {
        analyses,
        detection,
        assetNames: new Map([[musicAsset, "score.wav"]]),
        onDetect: vi.fn(async () => true),
        onCancel: vi.fn(async () => undefined),
        runtimeStatus,
        runtimeError: null,
        onChooseRuntimeFolder: vi.fn(async () => undefined),
        onRefreshRuntimeStatus: vi.fn(async () => undefined),
      };
      render(
        <AudioPanel
          sequence={musicSequence()}
          disabled={false}
          lastReport={null}
          onSetRole={vi.fn(async () => true)}
          onSetTarget={vi.fn(async () => true)}
          musicBeats={musicBeats}
        />,
      );
      return musicBeats;
    };

    it("starts detection for an asset on a music track", () => {
      const musicBeats = panel(new Map());
      expect(screen.getByText(/No music beats yet/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Detect music beats in score.wav" }));
      expect(musicBeats.onDetect).toHaveBeenCalledWith(musicAsset);
    });

    it("offers cancel while detection runs", () => {
      const musicBeats = panel(new Map([[musicAsset, { phase: "running", jobId: id(60) }]]));
      expect(screen.getByText(/Detecting music beats/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(musicBeats.onCancel).toHaveBeenCalledWith(musicAsset);
    });

    it("shows the detector and tempo of a finished analysis", () => {
      panel(
        new Map([[musicAsset, { phase: "ready", detector: "tempo_fallback" }]]),
        new Map([
          [
            musicAsset,
            {
              schemaVersion: 1,
              detector: {
                kind: "tempo_fallback",
                version: "tempo-fallback-v1",
                checkpointSha256: null,
              },
              durationUs: 2_000_000,
              tempoBpm: 120,
              beatsUs: [0, 500_000, 1_000_000, 1_500_000],
              downbeatsUs: [0],
              onsetsUs: [],
            },
          ],
        ]),
      );
      expect(screen.getByText(/4 music beats at 120 BPM \(in-app tempo fallback\)/)).toBeTruthy();
    });

    it("says Beat This! will run on the GPU when its runtime is ready with a GPU pack", () => {
      panel(new Map(), new Map(), runtime({ state: "ready" }, { kind: "cuda" }));
      expect(screen.getByText("Beat This! ready on the GPU")).toBeTruthy();
      expect(screen.queryByText(/runs on the CPU/)).toBeNull();
      expect(screen.queryByText("In-app tempo fallback")).toBeNull();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    });

    it.each([
      ["noGpuPack", /No GPU pack in the folder/],
      ["gpuPackMismatch", /GPU pack does not match the pinned files/],
      ["cudaInitFailed", /GPU could not be started/],
    ] as const)("says why Beat This! runs on the CPU (%s)", (reason, message) => {
      panel(new Map(), new Map(), runtime({ state: "ready" }, { kind: "cpu", reason }));
      expect(screen.getByText("Beat This! ready on the CPU")).toBeTruthy();
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    });

    it("says the tempo fallback will run when no runtime folder is chosen", () => {
      panel(new Map(), new Map(), runtime({ state: "notConfigured" }));
      expect(screen.getByText("In-app tempo fallback")).toBeTruthy();
      expect(screen.getByText(/No Beat This! folder chosen yet/)).toBeTruthy();
    });

    it.each([
      ["folderMissing", /could not be found/],
      ["linkedPath", /link or shortcut/],
      ["modelMissing", /missing a Beat This! model file/],
      ["modelMismatch", /model file does not match the pinned version/],
      ["detectorMissing", /does not include the beat detector/],
      ["probeFailed", /could not load the models/],
    ] as const)("explains an unavailable runtime (%s)", (reason, message) => {
      const musicBeats = panel(
        new Map(),
        new Map(),
        runtime({ state: "unavailable", problem: { reason } }),
      );
      expect(screen.getByText("In-app tempo fallback")).toBeTruthy();
      expect(screen.getByText(message)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      expect(musicBeats.onRefreshRuntimeStatus).toHaveBeenCalledOnce();
    });

    it("shows that the runtime is being checked before its status loads", () => {
      panel(new Map(), new Map(), null);
      expect(screen.getByText("Checking the Beat This! runtime…")).toBeTruthy();
    });

    it("opens the folder picker from the choose-folder button", () => {
      const musicBeats = panel(new Map());
      fireEvent.click(screen.getByRole("button", { name: "Choose Beat This! folder…" }));
      expect(musicBeats.onChooseRuntimeFolder).toHaveBeenCalledOnce();
    });
  });
});
