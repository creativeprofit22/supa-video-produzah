// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

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
const preparedAsset = {
  proxyPath: "C:\\Private\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Private\\Cache\\thumbnail.jpg",
  proxyProbe: { ...mediaProbe, width: 1_280, height: 720, fileSizeBytes: 5_000_000 },
} as const;

const renderJobId = "30000000-0000-4000-8000-000000000001";
const exportPath = "C:\\Exports\\clip-export.mp4";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function renderEventCallback(): EventCallback<unknown> {
  const callback = listenMock.mock.calls.at(-1)?.[1];
  if (callback === undefined) {
    throw new Error("Render event listener was not registered");
  }
  return callback;
}

function dispatchRenderEvent(payload: unknown): void {
  renderEventCallback()({ event: "video:render-event", id: 1, payload });
}

function configureReadyExport(startError?: unknown): void {
  let startAttempts = 0;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "video_ffmpeg_status") return readyStatus;
    if (command === "video_pick_source") return "C:\\Private\\clip.mp4";
    if (command === "video_probe_media") return mediaProbe;
    if (command === "video_prepare_asset") return preparedAsset;
    if (command === "video_pick_export_path") return exportPath;
    if (command === "video_cancel_render") return null;
    if (command === "video_start_render") {
      startAttempts += 1;
      if (startError !== undefined && startAttempts === 1) throw startError;
      const plan = (args as { plan: { planId: string; revisionId: string } }).plan;
      return { jobId: renderJobId, planId: plan.planId, revisionId: plan.revisionId };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

async function prepareAppForExport(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Choose video" }));
  await screen.findByText("Preview prepared");
}

afterEach(cleanup);

describe("App media readiness flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
  });

  it("shows loading, then enables source selection when both tools are ready", async () => {
    let resolveStatus!: (value: typeof readyStatus) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    render(<App />);
    expect(screen.getByRole("heading", { name: "Checking FFmpeg and FFprobe" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Choose video" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveStatus(readyStatus);
    await screen.findByRole("heading", { name: "Ready for video work" });
    expect(
      (screen.getByRole("button", { name: "Choose video" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("explains a missing tool and keeps source selection disabled", async () => {
    invokeMock.mockResolvedValueOnce({
      ffmpeg: { available: false, problem: "not_found" },
      ffprobe: { available: true, version: "ffprobe version 7.1" },
      ready: false,
    });

    render(<App />);

    await screen.findByRole("heading", { name: "FFmpeg setup required" });
    expect(screen.getByText(/Install it and add it to your system PATH/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Choose video" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("treats picker cancellation as an unchanged empty state", async () => {
    invokeMock.mockResolvedValueOnce(readyStatus).mockResolvedValueOnce(null);
    render(<App />);
    const chooseButton = await screen.findByRole("button", { name: "Choose video" });

    fireEvent.click(chooseButton);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("video_pick_source", undefined));
    expect(screen.getByRole("heading", { name: "No source selected" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("prepares only after project-backed identifiers and sequence rate exist", async () => {
    let resolveProbe!: (value: typeof mediaProbe) => void;
    let resolvePreparation!: (value: typeof preparedAsset) => void;
    invokeMock
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce("C:\\Private\\clip.mp4")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
      );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose video" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("video_probe_media", {
        path: "C:\\Private\\clip.mp4",
      }),
    );
    expect(invokeMock.mock.calls.some(([command]) => command === "video_prepare_asset")).toBe(
      false,
    );

    resolveProbe(mediaProbe);
    expect((await screen.findByRole("status")).textContent).toContain("Preparing preview");
    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "video_prepare_asset")).toBe(
        true,
      ),
    );

    const prepareCall = invokeMock.mock.calls.find(
      ([command]) => command === "video_prepare_asset",
    );
    expect(prepareCall).toBeDefined();
    expect(prepareCall?.[1]).toEqual({
      projectId: expect.stringMatching(uuidPattern),
      assetId: expect.stringMatching(uuidPattern),
      path: "C:\\Private\\clip.mp4",
      sequenceRate: mediaProbe.averageFrameRate,
    });

    resolvePreparation(preparedAsset);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Preview prepared"),
    );
    expect(screen.getByRole("heading", { name: "Selected video" })).toBeTruthy();
    expect(screen.getByText("1920 × 1080")).toBeTruthy();
    expect(screen.queryByText(/Private/)).toBeNull();
    expect(screen.queryByText(/proxy\.mp4/)).toBeNull();
  });

  it("safely renders preparation errors without backend details or paths", async () => {
    invokeMock
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce("C:\\Private\\clip.mp4")
      .mockResolvedValueOnce(mediaProbe)
      .mockRejectedValueOnce({
        code: "project_io",
        message: "Could not write C:\\Private\\Cache\\proxy.mp4",
        details: { rawOutput: "sensitive process output" },
      });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose video" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The preview cache could not be written");
    expect(alert.textContent).not.toContain("sensitive process output");
    expect(alert.textContent).not.toContain("Private");
    expect(alert.textContent).not.toContain("proxy.mp4");
    expect(screen.getByRole("heading", { name: "Selected video" })).toBeTruthy();
  });

  it("shows safe recovery copy for an invalid probe response", async () => {
    invokeMock
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce("C:\\Private\\clip.mp4")
      .mockResolvedValueOnce({ ...mediaProbe, width: 0, rawOutput: "sensitive process output" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose video" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The desktop service returned an unexpected response");
    expect(alert.textContent).not.toContain("sensitive process output");
    expect(alert.textContent).not.toContain("Private");
    expect(invokeMock.mock.calls.some(([command]) => command === "video_prepare_asset")).toBe(
      false,
    );
  });

  it("renders monotonic progress, rejects stale events, and shows the completion destination", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    configureReadyExport();
    render(<App />);
    await prepareAppForExport();

    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "video_start_render")).toBe(
        true,
      ),
    );
    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as { plan: { planId: string; revisionId: string } };
    const identity = {
      jobId: renderJobId,
      planId: startArgs.plan.planId,
      revisionId: startArgs.plan.revisionId,
    };

    dispatchRenderEvent({
      type: "progress",
      ...identity,
      completedMicroseconds: 3_000_000,
      durationMicroseconds: 4_000_000,
    });
    expect(await screen.findByText("75%")).toBeTruthy();

    dispatchRenderEvent({
      type: "progress",
      ...identity,
      jobId: "30000000-0000-4000-8000-000000000099",
      completedMicroseconds: 4_000_000,
      durationMicroseconds: 4_000_000,
    });
    dispatchRenderEvent({
      type: "progress",
      ...identity,
      completedMicroseconds: 1_000_000,
      durationMicroseconds: 4_000_000,
    });
    expect(screen.getByText("75%")).toBeTruthy();

    dispatchRenderEvent({
      type: "completed",
      ...identity,
      output: {
        outputPath: exportPath,
        previewPath: "C:\\Private\\Cache\\render-preview.mp4",
        probe: mediaProbe,
      },
    });
    expect(await screen.findByText("Export complete")).toBeTruthy();
    expect(screen.getByText(exportPath)).toBeTruthy();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("exposes cancellation and renders the cancelled event", async () => {
    configureReadyExport();
    render(<App />);
    await prepareAppForExport();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel export" });
    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as { plan: { planId: string; revisionId: string } };

    fireEvent.click(cancelButton);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("video_cancel_render", { jobId: renderJobId }),
    );
    dispatchRenderEvent({
      type: "cancelled",
      jobId: renderJobId,
      planId: startArgs.plan.planId,
      revisionId: startArgs.plan.revisionId,
    });
    expect(await screen.findByText("Export cancelled")).toBeTruthy();
  });

  it("redacts failed-event diagnostics and offers a safe retry", async () => {
    configureReadyExport();
    render(<App />);
    await prepareAppForExport();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as { plan: { planId: string; revisionId: string } };

    dispatchRenderEvent({
      type: "failed",
      jobId: renderJobId,
      planId: startArgs.plan.planId,
      revisionId: startArgs.plan.revisionId,
      error: {
        code: "process_failed",
        message: "Failed at C:\\Private\\clip.mp4",
        details: { rawOutput: "sensitive process output" },
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("FFmpeg could not finish this export");
    expect(alert.textContent).not.toContain("Private");
    expect(alert.textContent).not.toContain("sensitive process output");
    expect(screen.getByRole("button", { name: "Export MP4" })).toBeTruthy();
  });

  it("shows the saved destination when editor preview preparation fails", async () => {
    configureReadyExport();
    render(<App />);
    await prepareAppForExport();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as { plan: { planId: string; revisionId: string } };

    dispatchRenderEvent({
      type: "failed",
      jobId: renderJobId,
      planId: startArgs.plan.planId,
      revisionId: startArgs.plan.revisionId,
      error: {
        code: "project_io",
        message: "Preview failed at C:\\Private\\Cache\\preview.mp4",
        details: { outputExists: true, rawOutput: "sensitive process output" },
      },
    });

    expect(await screen.findByText("Export saved, preview unavailable")).toBeTruthy();
    expect(
      screen.getByText("The final MP4 was saved, but its editor preview could not be prepared."),
    ).toBeTruthy();
    expect(screen.getByText(exportPath)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export another" })).toBeTruthy();
    expect(screen.queryByText("Could not export the video")).toBeNull();
    expect(screen.queryByText(/Private/)).toBeNull();
    expect(screen.queryByText(/sensitive process output/)).toBeNull();
  });

  it("requires explicit confirmation before retrying an asynchronous collision", async () => {
    configureReadyExport();
    render(<App />);
    await prepareAppForExport();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const firstStart = invokeMock.mock.calls.find(([command]) => command === "video_start_render");
    const firstArgs = firstStart?.[1] as {
      plan: { planId: string; revisionId: string; outputPath: string };
      overwrite: boolean;
    };

    dispatchRenderEvent({
      type: "failed",
      jobId: renderJobId,
      planId: firstArgs.plan.planId,
      revisionId: firstArgs.plan.revisionId,
      error: {
        code: "output_exists",
        message: "C:\\Private\\existing.mp4 already exists",
        details: { rawOutput: "sensitive" },
      },
    });

    expect(await screen.findByText("Replace the existing file?")).toBeTruthy();
    expect(firstArgs.overwrite).toBe(false);
    expect(screen.queryByText(/Private/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace existing file" }));
    await waitFor(() => {
      const starts = invokeMock.mock.calls.filter(([command]) => command === "video_start_render");
      expect(starts).toHaveLength(2);
      const retryArgs = starts[1]?.[1] as { plan: typeof firstArgs.plan; overwrite: boolean };
      expect(retryArgs.overwrite).toBe(true);
      expect(retryArgs.plan).toEqual(firstArgs.plan);
    });
  });

  it("requires explicit confirmation before retrying a synchronous collision", async () => {
    configureReadyExport({
      code: "output_exists",
      message: "C:\\Private\\existing.mp4 already exists",
      details: { rawOutput: "sensitive" },
    });
    render(<App />);
    await prepareAppForExport();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));

    expect(await screen.findByText("Replace the existing file?")).toBeTruthy();
    const firstStart = invokeMock.mock.calls.find(([command]) => command === "video_start_render");
    expect((firstStart?.[1] as { overwrite: boolean }).overwrite).toBe(false);
    expect(screen.queryByText(/Private/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace existing file" }));
    await waitFor(() => {
      const starts = invokeMock.mock.calls.filter(([command]) => command === "video_start_render");
      expect(starts).toHaveLength(2);
      expect((starts[1]?.[1] as { overwrite: boolean }).overwrite).toBe(true);
      expect((starts[1]?.[1] as { plan: { outputPath: string } }).plan.outputPath).toBe(exportPath);
    });
  });
});
