// @vitest-environment jsdom

import { VideoDomainError } from "@supa-video/contracts";
import type { MediaProbe, PreparedVideoAsset } from "@supa-video/contracts";
import { currentRevision } from "@supa-video/project";
import { compileSingleClipRenderPlan } from "@supa-video/render";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVideoProject } from "./use-video-project";
import {
  cancelVideoRender,
  listenVideoRenderEvents,
  pickVideoExportPath,
  prepareVideoAsset,
  startVideoRender,
  type VideoRenderNotification,
} from "./video-ipc";

vi.mock("./video-ipc", () => ({
  cancelVideoRender: vi.fn(),
  listenVideoRenderEvents: vi.fn(),
  pickVideoExportPath: vi.fn(),
  prepareVideoAsset: vi.fn(),
  startVideoRender: vi.fn(),
}));

const cancelVideoRenderMock = vi.mocked(cancelVideoRender);
const listenVideoRenderEventsMock = vi.mocked(listenVideoRenderEvents);
const pickVideoExportPathMock = vi.mocked(pickVideoExportPath);
const prepareVideoAssetMock = vi.mocked(prepareVideoAsset);
const startVideoRenderMock = vi.mocked(startVideoRender);
let renderEventHandler: ((event: VideoRenderNotification) => void) | undefined;
let unlistenMock = vi.fn();

const sourceProbe: MediaProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 25, denominator: 1 },
  realFrameRate: { numerator: 25, denominator: 1 },
  variableFrameRate: false,
  width: 720,
  height: 576,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
};

const renderJobId = "20000000-0000-4000-8000-000000000001";
const exportPath = "C:\\Exports\\clip-export.mp4";

const preparedAsset: PreparedVideoAsset = {
  proxyPath: "C:\\Private\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Private\\Cache\\thumbnail.jpg",
  proxyProbe: {
    ...sourceProbe,
    width: 540,
    height: 720,
    fileSizeBytes: 5_000_000,
  },
};

afterEach(cleanup);

describe("useVideoProject", () => {
  beforeEach(() => {
    cancelVideoRenderMock.mockReset();
    listenVideoRenderEventsMock.mockReset();
    pickVideoExportPathMock.mockReset();
    prepareVideoAssetMock.mockReset();
    startVideoRenderMock.mockReset();
    renderEventHandler = undefined;
    unlistenMock = vi.fn();
    listenVideoRenderEventsMock.mockImplementation(async (handler) => {
      renderEventHandler = handler;
      return unlistenMock;
    });
    pickVideoExportPathMock.mockResolvedValue(exportPath);
    startVideoRenderMock.mockImplementation(async (plan) => ({
      jobId: renderJobId,
      planId: plan.planId,
      revisionId: plan.revisionId,
    }));
    cancelVideoRenderMock.mockResolvedValue();
  });

  it("creates the sequence from display-correct prepared dimensions", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());

    await act(async () => {
      await result.current.prepareImportedSource(
        "C:\\Private\\rotated-anamorphic.mp4",
        sourceProbe,
      );
    });

    const revision = currentRevision(result.current.project);
    const projectState = revision.state;
    expect(projectState.sequence).toMatchObject({
      rate: sourceProbe.averageFrameRate,
      width: 540,
      height: 720,
      videoTracks: [
        {
          clips: [
            {
              assetId: projectState.asset?.id,
              timelineStart: { value: 0, rateNumerator: 25, rateDenominator: 1 },
              sourceIn: { value: 0, rateNumerator: 25, rateDenominator: 1 },
              sourceOut: { value: 100, rateNumerator: 25, rateDenominator: 1 },
            },
          ],
        },
      ],
    });
    expect(new Set(result.current.project.revisions.map(({ id }) => id)).size).toBe(
      result.current.project.revisions.length,
    );

    const renderPlan = compileSingleClipRenderPlan({
      planId: "10000000-0000-4000-8000-000000000001",
      revision,
      inputPath: "C:\\Private\\rotated-anamorphic.mp4",
      outputPath: "C:\\Private\\render.mp4",
    });
    expect(renderPlan).toMatchObject({
      revisionId: revision.id,
      expected: { durationFrames: 100, rate: sourceProbe.averageFrameRate },
    });

    expect(result.current.preparation).toMatchObject({ phase: "success", value: preparedAsset });
    expect(prepareVideoAssetMock).toHaveBeenCalledWith({
      projectId: result.current.project.id,
      assetId: projectState.asset?.id,
      path: "C:\\Private\\rotated-anamorphic.mp4",
      sequenceRate: sourceProbe.averageFrameRate,
    });
  });

  it("subscribes before start and renders only monotonic matching progress", async () => {
    const callOrder: string[] = [];
    listenVideoRenderEventsMock.mockImplementation(async (handler) => {
      callOrder.push("listen");
      renderEventHandler = handler;
      return unlistenMock;
    });
    startVideoRenderMock.mockImplementation(async (plan) => {
      callOrder.push("start");
      return { jobId: renderJobId, planId: plan.planId, revisionId: plan.revisionId };
    });
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });

    expect(callOrder).toEqual(["listen", "start"]);
    expect(result.current.render).toMatchObject({
      phase: "running",
      jobId: renderJobId,
      progress: 0,
    });
    const running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render and registered listener");
    }

    act(() => {
      renderEventHandler?.({
        type: "progress",
        jobId: renderJobId,
        planId: running.planId,
        revisionId: running.revisionId,
        completedMicroseconds: 3_000_000,
        durationMicroseconds: 4_000_000,
      });
      renderEventHandler?.({
        type: "progress",
        jobId: renderJobId,
        planId: running.planId,
        revisionId: running.revisionId,
        completedMicroseconds: 2_000_000,
        durationMicroseconds: 4_000_000,
      });
      renderEventHandler?.({
        type: "progress",
        jobId: "20000000-0000-4000-8000-000000000099",
        planId: running.planId,
        revisionId: running.revisionId,
        completedMicroseconds: 4_000_000,
        durationMicroseconds: 4_000_000,
      });
    });

    expect(result.current.render).toMatchObject({ phase: "running", progress: 75 });
  });

  it("exposes cancellation and settles from the matching cancelled event", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });
    const running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render and registered listener");
    }

    await act(async () => {
      await result.current.cancelRender();
    });
    expect(cancelVideoRenderMock).toHaveBeenCalledWith(renderJobId);
    expect(result.current.render).toMatchObject({ phase: "running", cancellationPending: true });

    act(() => {
      renderEventHandler?.({
        type: "cancelled",
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
      });
    });
    expect(result.current.render).toMatchObject({ phase: "cancelled", jobId: renderJobId });
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("settles completion and redacted failure data from matching events", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });
    const running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render and registered listener");
    }
    const firstHandler = renderEventHandler;

    act(() => {
      firstHandler({
        type: "completed",
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
        output: {
          outputPath: exportPath,
          previewPath: "C:\\Private\\Cache\\render-preview.mp4",
          probe: sourceProbe,
        },
      });
    });
    expect(result.current.render).toMatchObject({
      phase: "completed",
      output: { outputPath: exportPath },
    });

    unlistenMock = vi.fn();
    await act(async () => {
      await result.current.exportVideo();
    });
    const secondRunning = result.current.render;
    if (secondRunning.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected the second render to start");
    }
    const backendError = new VideoDomainError("process_failed", "private backend path", {
      rawOutput: "sensitive",
    });
    act(() => {
      renderEventHandler?.({
        type: "failed",
        jobId: secondRunning.jobId,
        planId: secondRunning.planId,
        revisionId: secondRunning.revisionId,
        error: backendError,
      });
    });
    expect(result.current.render).toMatchObject({
      phase: "failed",
      error: backendError,
      canOverwrite: false,
    });
  });

  it("preserves a saved export as completed when preview preparation fails", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });
    const running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render and registered listener");
    }
    const previewError = new VideoDomainError("project_io", "private preview preparation failure", {
      outputExists: true,
      rawOutput: "sensitive",
    });

    act(() => {
      renderEventHandler?.({
        type: "failed",
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
        error: previewError,
      });
    });

    expect(result.current.render).toMatchObject({
      phase: "completed_with_warning",
      outputPath: exportPath,
      error: previewError,
    });
    expect(result.current.render).not.toHaveProperty("canOverwrite");
  });

  it("retries the same validated plan after an asynchronous overwrite collision", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });
    const running = result.current.render;
    const firstPlan = startVideoRenderMock.mock.calls[0]?.[0];
    if (
      running.phase !== "running" ||
      renderEventHandler === undefined ||
      firstPlan === undefined
    ) {
      throw new Error("Expected a running render, plan, and registered listener");
    }

    act(() => {
      renderEventHandler?.({
        type: "failed",
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
        error: new VideoDomainError("output_exists", "private destination"),
      });
    });

    expect(result.current.render).toMatchObject({ phase: "failed", canOverwrite: true });
    await act(async () => {
      await result.current.confirmOverwrite();
    });
    expect(startVideoRenderMock).toHaveBeenNthCalledWith(2, firstPlan, true);
  });

  it("retries the same validated plan only after synchronous overwrite confirmation", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    startVideoRenderMock
      .mockRejectedValueOnce(new VideoDomainError("output_exists", "private destination"))
      .mockImplementationOnce(async (plan) => ({
        jobId: renderJobId,
        planId: plan.planId,
        revisionId: plan.revisionId,
      }));
    const { result } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });

    expect(result.current.render).toMatchObject({ phase: "failed", canOverwrite: true });
    const firstPlan = startVideoRenderMock.mock.calls[0]?.[0];
    expect(firstPlan).toBeDefined();
    expect(startVideoRenderMock).toHaveBeenNthCalledWith(1, firstPlan, false);

    await act(async () => {
      await result.current.confirmOverwrite();
    });
    expect(startVideoRenderMock).toHaveBeenNthCalledWith(2, firstPlan, true);
    expect(startVideoRenderMock.mock.calls[1]?.[0].outputPath).toBe(exportPath);
  });

  it("cleans the active listener and cancels the job on unmount", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result, unmount } = renderHook(() => useVideoProject());
    await act(async () => {
      await result.current.prepareImportedSource("C:\\Private\\clip.mp4", sourceProbe);
      await result.current.exportVideo();
    });

    unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(cancelVideoRenderMock).toHaveBeenCalledWith(renderJobId);
  });
});
