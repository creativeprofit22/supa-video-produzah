import { VideoDomainError } from "@supa-video/contracts";
import type { RenderPlanV1, VideoProjectFileV1 } from "@supa-video/contracts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelVideoRender,
  getVideoToolStatus,
  listenVideoRenderEvents,
  openVideoProject,
  pickNewVideoProjectPath,
  pickVideoExportPath,
  pickVideoSource,
  prepareVideoAsset,
  probeVideoSource,
  regrantVideoProjectSource,
  saveVideoProject,
  startVideoRender,
  tauriVideoBackend,
  VideoIpcResponseError,
} from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const convertFileSrcMock = vi.mocked(convertFileSrc);
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

const projectDocument: VideoProjectFileV1 = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000010",
  name: "IPC fixture",
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:00.000Z",
  currentRevisionId: "00000000-0000-4000-8000-000000000011",
  revisions: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      parentRevisionId: null,
      sequenceNumber: 0,
      committedAt: "2026-07-25T12:00:00.000Z",
      commandSummary: "Created project",
      state: { asset: null, sequence: null },
    },
  ],
};

const openedProject = {
  path: "C:\\Projects\\fixture.svpvideo",
  document: projectDocument,
  sources: [],
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
    convertFileSrcMock.mockClear();
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

  it("picks a new project destination with the exact default-name argument", async () => {
    invokeMock.mockResolvedValueOnce("C:\\Projects\\New project.svpvideo");

    await expect(pickNewVideoProjectPath("New project.svpvideo")).resolves.toBe(
      "C:\\Projects\\New project.svpvideo",
    );
    expect(invokeMock).toHaveBeenCalledWith("video_pick_new_project_path", {
      defaultName: "New project.svpvideo",
    });
  });

  it("keeps new/open picker cancellation as no data", async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(pickNewVideoProjectPath("Untitled.svpvideo")).resolves.toBeNull();
    await expect(openVideoProject()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_open_project", undefined);
  });

  it("validates open and save payloads with exact command arguments", async () => {
    invokeMock.mockResolvedValueOnce(openedProject).mockResolvedValueOnce(null);

    await expect(openVideoProject()).resolves.toEqual(openedProject);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_open_project", undefined);

    await expect(saveVideoProject(openedProject.path, projectDocument)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_save_project", {
      path: openedProject.path,
      document: projectDocument,
    });
  });

  it("validates exact source regrant arguments and resolved-or-cancelled responses", async () => {
    const request = {
      projectPath: openedProject.path,
      assetId: "00000000-0000-4000-8000-000000000002",
    } as const;
    const resolved = {
      assetId: request.assetId,
      status: "resolved",
      resolvedPath: prepareRequest.path,
    } as const;
    invokeMock.mockResolvedValueOnce(resolved).mockResolvedValueOnce(null);

    await expect(regrantVideoProjectSource(request)).resolves.toEqual(resolved);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_regrant_project_source", request);
    await expect(regrantVideoProjectSource(request)).resolves.toBeNull();
  });

  it("rejects unresolved or malformed source regrant responses", async () => {
    const request = {
      projectPath: openedProject.path,
      assetId: "00000000-0000-4000-8000-000000000002",
    } as const;
    invokeMock.mockResolvedValueOnce({
      assetId: request.assetId,
      status: "relink_required",
      resolvedPath: null,
    });

    await expect(regrantVideoProjectSource(request)).rejects.toBeInstanceOf(VideoIpcResponseError);
  });
  it("rejects malformed native project data without leaking its payload", async () => {
    invokeMock
      .mockResolvedValueOnce({
        ...openedProject,
        privateDiagnostic: "C:\\Users\\private\\clip.mp4",
      })
      .mockResolvedValueOnce("relative/project.svpvideo");

    const openError = await openVideoProject().catch((reason: unknown) => reason);
    expect(openError).toBeInstanceOf(VideoIpcResponseError);
    expect(String(openError)).not.toContain("private");
    await expect(pickNewVideoProjectPath("Untitled.svpvideo")).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
  });

  it("normalizes project backend errors and validates empty save responses", async () => {
    invokeMock
      .mockRejectedValueOnce({
        code: "project_io",
        message: "The project could not be opened",
        details: { operation: "open_project", rawOutput: "private" },
      })
      .mockResolvedValueOnce(undefined);

    await expect(openVideoProject()).rejects.toMatchObject({ code: "project_io" });
    await expect(saveVideoProject(openedProject.path, projectDocument)).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );
  });

  it("exposes every native operation and cache URL conversion through the default backend", () => {
    expect(tauriVideoBackend).toMatchObject({
      getVideoToolStatus,
      pickNewVideoProjectPath,
      openVideoProject,
      regrantVideoProjectSource,
      saveVideoProject,
      pickVideoSource,
      probeVideoSource,
      prepareVideoAsset,
      pickVideoExportPath,
      startVideoRender,
      cancelVideoRender,
      listenVideoRenderEvents,
      convertFileSrc,
    });
    expect(tauriVideoBackend.convertFileSrc("C:\\Cache\\proxy.mp4")).toBe(
      "asset:C:\\Cache\\proxy.mp4",
    );
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
