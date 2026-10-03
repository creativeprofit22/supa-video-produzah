import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMusicBeatDetectionResult,
  getMusicBeatRuntimeStatus,
  loadMusicBeatAnalysis,
  startMusicBeatDetection,
} from "./music-beat-ipc";
import { VideoIpcResponseError } from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

const analysis = {
  schemaVersion: 1,
  detector: { kind: "tempo_fallback", version: "tempo-fallback-v1", checkpointSha256: null },
  durationUs: 2_000_000,
  tempoBpm: 120,
  beatsUs: [0, 500_000, 1_000_000, 1_500_000],
  downbeatsUs: [0],
  onsetsUs: [0, 500_000],
};

describe("music beat IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("validates the request before invoking and the response after", async () => {
    invokeMock.mockResolvedValueOnce({ jobId: id(9), state: "queued" });
    const started = await startMusicBeatDetection({
      projectId: id(1),
      assetId: id(2),
      sourcePath: "C:\\music.wav",
    });
    expect(started.jobId).toBe(id(9));
    expect(invokeMock).toHaveBeenCalledWith("video_start_music_beat_detection", {
      request: { projectId: id(1), assetId: id(2), sourcePath: "C:\\music.wav" },
    });
    await expect(
      startMusicBeatDetection({ projectId: "nope", assetId: id(2), sourcePath: "x" }),
    ).rejects.toThrow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("loads a schema-valid analysis by key", async () => {
    invokeMock.mockResolvedValueOnce(analysis);
    await expect(loadMusicBeatAnalysis("b".repeat(64))).resolves.toEqual(analysis);
    expect(invokeMock).toHaveBeenCalledWith("video_load_music_beat_analysis", {
      request: { analysisKey: "b".repeat(64) },
    });
  });

  it("rejects an analysis with unsorted music beats", async () => {
    invokeMock.mockResolvedValueOnce({ ...analysis, beatsUs: [500_000, 0] });
    await expect(loadMusicBeatAnalysis("b".repeat(64))).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
  });

  it("rejects malformed results and status", async () => {
    invokeMock.mockResolvedValueOnce({ analysisKey: "x", detector: "beat_this" });
    await expect(getMusicBeatDetectionResult(id(3))).rejects.toBeInstanceOf(VideoIpcResponseError);
    invokeMock.mockResolvedValueOnce({ runtime: { state: "ready" } });
    await expect(getMusicBeatRuntimeStatus()).rejects.toBeInstanceOf(VideoIpcResponseError);
  });
});
