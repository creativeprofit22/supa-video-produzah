import { VideoDomainError } from "@supa-video/contracts";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getVideoToolStatus,
  pickVideoSource,
  probeVideoSource,
  VideoIpcResponseError,
} from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const readyStatus = {
  ffmpeg: { available: true, version: "ffmpeg version 7.1" },
  ffprobe: { available: true, version: "ffprobe version 7.1" },
  ready: true,
} as const;

const mediaProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 30_000, denominator: 1_001 },
  realFrameRate: { numerator: 30_000, denominator: 1_001 },
  variableFrameRate: false,
  width: 1_920,
  height: 1_080,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
} as const;

describe("video IPC adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("validates a ready tool status from the exact command", async () => {
    invokeMock.mockResolvedValueOnce(readyStatus);

    await expect(getVideoToolStatus()).resolves.toEqual(readyStatus);
    expect(invokeMock).toHaveBeenCalledWith("video_ffmpeg_status", undefined);
  });

  it("validates missing-tool readiness", async () => {
    const missingStatus = {
      ffmpeg: { available: false, problem: "not_found" },
      ffprobe: { available: true, version: "ffprobe version 7.1" },
      ready: false,
    };
    invokeMock.mockResolvedValueOnce(missingStatus);

    await expect(getVideoToolStatus()).resolves.toEqual(missingStatus);
  });

  it("keeps picker cancellation as an empty result", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(pickVideoSource()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("video_pick_source", undefined);
  });

  it("validates a media probe and passes only the selected path", async () => {
    invokeMock.mockResolvedValueOnce(mediaProbe);

    await expect(probeVideoSource("C:\\Media\\clip.mp4")).resolves.toEqual(mediaProbe);
    expect(invokeMock).toHaveBeenCalledWith("video_probe_media", {
      path: "C:\\Media\\clip.mp4",
    });
  });

  it("rejects an invalid probe response without exposing it", async () => {
    invokeMock.mockResolvedValueOnce({ ...mediaProbe, width: 0, rawOutput: "private" });

    await expect(probeVideoSource("C:\\Media\\clip.mp4")).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
  });

  it.each([
    "tool_unavailable",
    "process_failed",
    "process_timeout",
    "process_cancelled",
    "process_output_limit",
    "invalid_media",
    "invalid_path",
    "path_not_granted",
  ] as const)("normalizes the %s backend error", async (code) => {
    invokeMock.mockRejectedValueOnce({
      code,
      message: "Backend diagnostic",
      details: { operation: "probe_media", rawOutput: "private" },
    });

    const error = await probeVideoSource("C:\\Media\\clip.mp4").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VideoDomainError);
    expect(error).toMatchObject({ code });
  });
});
