// @vitest-environment jsdom

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const convertFileSrcMock = vi.mocked(convertFileSrc);
const readyStatus = {
  ffmpeg: { available: true, version: "ffmpeg version 7.1" },
  ffprobe: { available: true, version: "ffprobe version 7.1" },
  ready: true,
} as const;
const mediaProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 25, denominator: 1 },
  realFrameRate: { numerator: 25, denominator: 1 },
  variableFrameRate: false,
  width: 720,
  height: 576,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
} as const;
const preparedAsset = {
  proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Neutral\\Cache\\thumbnail.jpg",
  proxyProbe: { ...mediaProbe, width: 540, height: 720, fileSizeBytes: 5_000_000 },
} as const;
const renderJobId = "30000000-0000-4000-8000-000000000001";
const projectPath = "C:\\Neutral\\Projects\\fixture.svpvideo";
const sourcePath = "C:\\Neutral\\Media\\clip.mp4";
const exportPath = "C:\\Neutral\\Exports\\clip-export.mp4";

function configureReadyApp(): void {
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "video_ffmpeg_status") return readyStatus;
    if (command === "video_pick_new_project_path") return projectPath;
    if (command === "video_save_project") return null;
    if (command === "video_pick_source") return sourcePath;
    if (command === "video_probe_media") return mediaProbe;
    if (command === "video_prepare_asset") return preparedAsset;
    if (command === "video_pick_export_path") return exportPath;
    if (command === "video_cancel_render") return null;
    if (command === "video_open_project") return null;
    if (command === "video_start_render") {
      const plan = (args as { plan: { planId: string; revisionId: string } }).plan;
      return { jobId: renderJobId, planId: plan.planId, revisionId: plan.revisionId };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

async function createProject(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "New project" }));
  await screen.findByRole("heading", { name: "Project media" });
}

async function prepareProject(): Promise<void> {
  await createProject();
  fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
  await screen.findByRole("heading", { name: "Prepared proxy" });
}

function renderEventCallback(): EventCallback<unknown> {
  const callback = listenMock.mock.calls.at(-1)?.[1];
  if (callback === undefined) throw new Error("Render listener was not registered");
  return callback;
}

function dispatchRenderEvent(payload: unknown): void {
  renderEventCallback()({ event: "video:render-event", id: 1, payload });
}

function renderIdentity() {
  const args = invokeMock.mock.calls.find(([command]) => command === "video_start_render")?.[1] as {
    plan: { planId: string; revisionId: string };
  };
  return { jobId: renderJobId, planId: args.plan.planId, revisionId: args.plan.revisionId };
}

afterEach(cleanup);

describe("App Phase 1 workspace", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    convertFileSrcMock.mockClear();
    listenMock.mockResolvedValue(vi.fn());
  });

  it("shows tool loading and keeps project creation available", async () => {
    let resolveStatus!: (value: typeof readyStatus) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "Checking FFmpeg and FFprobe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
    resolveStatus(readyStatus);
    expect(await screen.findByRole("heading", { name: "Ready for video work" })).toBeTruthy();
  });

  it("shows missing tools without blocking saved project access", async () => {
    invokeMock.mockResolvedValueOnce({
      ffmpeg: { available: false, problem: "not_found" },
      ffprobe: { available: true, version: "ffprobe version 7.1" },
      ready: false,
    });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "FFmpeg setup required" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "New project" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("saves an empty project before showing the active workspace", async () => {
    configureReadyApp();
    render(<App />);
    await createProject();
    const saveCall = invokeMock.mock.calls.find(([command]) => command === "video_save_project");
    expect(saveCall?.[1]).toMatchObject({
      path: projectPath,
      document: { revisions: [expect.any(Object)] },
    });
    expect(screen.getByRole("heading", { name: "fixture" })).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("prepares cache-only media and never renders original source paths", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    expect(convertFileSrcMock).toHaveBeenCalledWith(preparedAsset.proxyPath);
    expect(convertFileSrcMock).toHaveBeenCalledWith(preparedAsset.thumbnailPath);
    expect(convertFileSrcMock).not.toHaveBeenCalledWith(sourcePath);
    expect(document.body.textContent).not.toContain(sourcePath);
    expect(document.body.textContent).not.toContain(preparedAsset.proxyPath);
    expect(screen.getByText("Source resolved")).toBeTruthy();
  });

  it("keeps draft trim ephemeral and saves one revision on Apply trim", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    const savesBeforeDraft = invokeMock.mock.calls.filter(
      ([command]) => command === "video_save_project",
    ).length;
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim out" }), {
      target: { value: "50" },
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_save_project"),
    ).toHaveLength(savesBeforeDraft);
    fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_save_project"),
      ).toHaveLength(savesBeforeDraft + 1),
    );
    expect(screen.getByText("5–50")).toBeTruthy();
  });

  it("renders monotonic export progress and verified output evidence", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const identity = renderIdentity();
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
      completedMicroseconds: 1_000_000,
      durationMicroseconds: 4_000_000,
    });
    expect(screen.getByText("75%")).toBeTruthy();
    dispatchRenderEvent({
      type: "completed",
      ...identity,
      output: {
        outputPath: exportPath,
        previewPath: "C:\\Neutral\\Cache\\preview.mp4",
        probe: mediaProbe,
      },
    });
    expect(await screen.findByText("Export complete")).toBeTruthy();
    expect(screen.getByText(exportPath)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Final" })).toBeTruthy();
  });

  it("requires explicit overwrite confirmation in a native dialog", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const identity = renderIdentity();
    dispatchRenderEvent({
      type: "failed",
      ...identity,
      error: { code: "output_exists", message: "private path", details: {} },
    });
    const dialog = await screen.findByRole("dialog", { name: "Replace the existing file?" });
    expect(dialog.hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Replace existing file" }));
    await waitFor(() => {
      const starts = invokeMock.mock.calls.filter(([command]) => command === "video_start_render");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.[1]).toMatchObject({ overwrite: true });
    });
    expect(document.body.textContent).not.toContain("private path");
  });
});
