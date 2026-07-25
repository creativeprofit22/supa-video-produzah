import { VideoDomainError } from "@supa-video/contracts";
import type { RenderPlanV1 } from "@supa-video/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelVideoRender,
  getVideoToolStatus,
  listenVideoRenderEvents,
  pickVideoExportPath,
  pickVideoSource,
  prepareVideoAsset,
  probeVideoSource,
  startVideoRender,
  VideoIpcResponseError,
} from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

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

const prepareRequest = {
  projectId: "00000000-0000-4000-8000-000000000001",
  assetId: "00000000-0000-4000-8000-000000000002",
  path: "C:\\Media\\clip.mp4",
  sequenceRate: mediaProbe.averageFrameRate,
} as const;

const preparedAsset = {
  proxyPath: "C:\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Cache\\thumbnail.jpg",
  proxyProbe: { ...mediaProbe, width: 1_280, height: 720, fileSizeBytes: 5_000_000 },
} as const;

const renderIdentity = {
  jobId: "00000000-0000-4000-8000-000000000003",
  planId: "00000000-0000-4000-8000-000000000003",
  revisionId: prepareRequest.projectId,
} as const;

const renderPlan: RenderPlanV1 = {
  schemaVersion: 1,
  planId: renderIdentity.planId,
  revisionId: renderIdentity.revisionId,
  executable: "ffmpeg",
  inputPath: prepareRequest.path,
  outputPath: "C:\\Exports\\clip.mp4",
  expected: {
    durationFrames: 120,
    rate: mediaProbe.averageFrameRate,
    width: mediaProbe.width,
    height: mediaProbe.height,
    audio: true,
  },
  argv: ["-i", prepareRequest.path, "C:\\Exports\\clip.mp4"],
};

const verifiedOutput = {
  outputPath: renderPlan.outputPath,
  previewPath: "C:\\Cache\\render-preview.mp4",
  probe: mediaProbe,
} as const;

function renderEventCallback(): EventCallback<unknown> {
  const callback = listenMock.mock.calls[0]?.[1];
  if (callback === undefined) {
    throw new Error("Render event listener was not registered");
  }
  return callback;
}

function dispatchRenderEvent(payload: unknown): void {
  renderEventCallback()({ event: "video:render-event", id: 1, payload });
}

describe("video IPC adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
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

  it("validates a prepared asset and invokes the exact command arguments", async () => {
    invokeMock.mockResolvedValueOnce(preparedAsset);

    await expect(prepareVideoAsset(prepareRequest)).resolves.toEqual(preparedAsset);
    expect(invokeMock).toHaveBeenCalledWith("video_prepare_asset", prepareRequest);
  });

  it("rejects a malformed prepared asset response", async () => {
    invokeMock.mockResolvedValueOnce({
      ...preparedAsset,
      proxyProbe: { ...preparedAsset.proxyProbe, width: 0 },
      rawOutput: "private",
    });

    await expect(prepareVideoAsset(prepareRequest)).rejects.toBeInstanceOf(VideoIpcResponseError);
  });

  it.each(["project_io", "process_failed", "invalid_media"] as const)(
    "normalizes the %s preparation backend error",
    async (code) => {
      invokeMock.mockRejectedValueOnce({
        code,
        message: "Backend preparation diagnostic",
        details: { operation: "prepare_asset", rawOutput: "private" },
      });

      const error = await prepareVideoAsset(prepareRequest).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(VideoDomainError);
      expect(error).toMatchObject({ code });
    },
  );

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

  it("picks and grants the export path with the exact command arguments", async () => {
    invokeMock.mockResolvedValueOnce("C:\\Exports\\clip.mp4");

    await expect(pickVideoExportPath("clip.mp4")).resolves.toBe("C:\\Exports\\clip.mp4");
    expect(invokeMock).toHaveBeenCalledWith("video_pick_export_path", {
      defaultName: "clip.mp4",
    });
  });

  it("validates render start and cancellation responses with exact arguments", async () => {
    invokeMock.mockResolvedValueOnce(renderIdentity).mockResolvedValueOnce(null);

    await expect(startVideoRender(renderPlan, false)).resolves.toEqual(renderIdentity);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_start_render", {
      plan: renderPlan,
      overwrite: false,
    });

    await expect(cancelVideoRender(renderIdentity.jobId)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_cancel_render", {
      jobId: renderIdentity.jobId,
    });
  });

  it("rejects malformed render command responses", async () => {
    invokeMock
      .mockResolvedValueOnce({ ...renderIdentity, rawOutput: "private" })
      .mockResolvedValueOnce(undefined);

    await expect(startVideoRender(renderPlan, true)).rejects.toBeInstanceOf(VideoIpcResponseError);
    await expect(cancelVideoRender(renderIdentity.jobId)).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
  });

  it("validates and delivers every render event variant", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    const cleanup = await listenVideoRenderEvents(handler);
    expect(listenMock).toHaveBeenCalledWith("video:render-event", expect.any(Function));

    const events = [
      { type: "started", ...renderIdentity },
      {
        type: "progress",
        ...renderIdentity,
        completedMicroseconds: 2_000_000,
        durationMicroseconds: 4_000_000,
      },
      { type: "completed", ...renderIdentity, output: verifiedOutput },
      { type: "cancelled", ...renderIdentity },
    ] as const;
    for (const event of events) {
      dispatchRenderEvent(event);
    }
    dispatchRenderEvent({
      type: "failed",
      ...renderIdentity,
      error: {
        code: "process_failed",
        message: "The media tool process failed",
        details: { operation: "render", executable: "ffmpeg", exitCode: 1 },
      },
    });

    expect(handler).toHaveBeenCalledTimes(5);
    expect(handler.mock.calls.slice(0, 4).map(([event]) => event)).toEqual(events);
    expect(handler.mock.calls[4]?.[0]).toMatchObject({
      type: "failed",
      error: { code: "process_failed", message: "The media tool process failed" },
    });
    expect(handler.mock.calls[4]?.[0].error).toBeInstanceOf(VideoDomainError);

    await Promise.resolve();
    cleanup();
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed render event payloads before delivery", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();
    const cleanup = await listenVideoRenderEvents(handler);

    expect(() =>
      dispatchRenderEvent({
        type: "progress",
        ...renderIdentity,
        completedMicroseconds: "2000000",
        durationMicroseconds: 4_000_000,
      }),
    ).toThrow(VideoIpcResponseError);
    expect(handler).not.toHaveBeenCalled();

    await Promise.resolve();
    cleanup();
  });

  it("returns an idempotent cleanup after asynchronous registration", async () => {
    let resolveRegistration: ((unlisten: UnlistenFn) => void) | undefined;
    const registration = new Promise<UnlistenFn>((resolve) => {
      resolveRegistration = resolve;
    });
    listenMock.mockReturnValueOnce(registration);
    const unlisten = vi.fn();

    const cleanupPromise = listenVideoRenderEvents(vi.fn());
    expect(unlisten).not.toHaveBeenCalled();

    resolveRegistration?.(unlisten);
    await registration;
    const cleanup = await cleanupPromise;
    cleanup();
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
