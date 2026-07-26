// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const readyStatus = {
  ffmpeg: { available: true, version: "ffmpeg version 7.1" },
  ffprobe: { available: true, version: "ffprobe version 7.1" },
  ready: true,
} as const;
const probe = {
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
const prepared = {
  proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Neutral\\Cache\\thumbnail.jpg",
  proxyProbe: { ...probe, width: 540, height: 720, fileSizeBytes: 5_000_000 },
} as const;
const projectPath = "C:\\Neutral\\Projects\\workflow.svpvideo";
const sourcePath = "C:\\Neutral\\Media\\clip.mp4";
const outputPath = "C:\\Neutral\\Exports\\clip.mp4";
const jobId = "40000000-0000-4000-8000-000000000001";

function latestRenderCallback(): EventCallback<unknown> {
  const callback = listenMock.mock.calls.at(-1)?.[1];
  if (callback === undefined) throw new Error("Expected render listener");
  return callback;
}

function dispatchRender(payload: unknown): void {
  latestRenderCallback()({ event: "video:render-event", id: 1, payload });
}

afterEach(cleanup);

describe("complete mocked Phase 1 workflow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates, imports, plays, trims, undoes, redoes, exports, previews, and reopens", async () => {
    let savedDocument: Record<string, unknown> | undefined;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_ffmpeg_status") return readyStatus;
      if (command === "video_pick_new_project_path") return projectPath;
      if (command === "video_pick_source") return sourcePath;
      if (command === "video_probe_media") return probe;
      if (command === "video_prepare_asset") return prepared;
      if (command === "video_pick_export_path") return outputPath;
      if (command === "video_cancel_render") return null;
      if (command === "video_save_project") {
        savedDocument = (args as { document: Record<string, unknown> }).document;
        return null;
      }
      if (command === "video_open_project") {
        if (savedDocument === undefined) throw new Error("No saved project");
        const revisions = savedDocument.revisions as Array<{
          id: string;
          state: { asset: { id: string } | null };
        }>;
        const currentRevisionId = savedDocument.currentRevisionId as string;
        const asset = revisions.find((revision) => revision.id === currentRevisionId)?.state.asset;
        return {
          path: projectPath,
          document: savedDocument,
          sources:
            asset === null || asset === undefined
              ? []
              : [{ assetId: asset.id, status: "resolved", resolvedPath: sourcePath }],
        };
      }
      if (command === "video_start_render") {
        const plan = (args as { plan: { planId: string; revisionId: string } }).plan;
        return { jobId, planId: plan.planId, revisionId: plan.revisionId };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    expect(savedDocument?.revisions).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    const video = (await screen.findByLabelText("Prepared source proxy")) as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(video.play).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText("Frame 1")).toBeTruthy());
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(screen.getByText("Frame 11")).toBeTruthy());

    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim out" }), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
    await waitFor(() => expect(screen.getByText("5–50")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByText("0–100")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(screen.getByText("5–50")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as {
      plan: { planId: string; revisionId: string };
    };
    const identity = {
      jobId,
      planId: startArgs.plan.planId,
      revisionId: startArgs.plan.revisionId,
    };
    dispatchRender({
      type: "progress",
      ...identity,
      completedMicroseconds: 900_000,
      durationMicroseconds: 1_800_000,
    });
    expect(await screen.findByText("50%")).toBeTruthy();
    dispatchRender({
      type: "completed",
      ...identity,
      output: {
        outputPath,
        previewPath: "C:\\Neutral\\Cache\\final-preview.mp4",
        probe: {
          ...probe,
          durationMicroseconds: 1_800_000,
          width: 540,
          height: 720,
          fileSizeBytes: 4_000_000,
        },
      },
    });
    expect(await screen.findByText("Export complete")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(screen.getByLabelText("Verified final video preview")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("spinbutton", { name: "Trim in" }) as HTMLInputElement).valueAsNumber,
      ).toBe(5),
    );
    expect(
      (screen.getByRole("spinbutton", { name: "Trim out" }) as HTMLInputElement).valueAsNumber,
    ).toBe(50);
    expect(await screen.findByRole("heading", { name: "Prepared proxy" })).toBeTruthy();
  });

  it("preserves the opener on picker cancellation and reports malformed open safely", async () => {
    invokeMock
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ privateDiagnostic: "C:\\Users\\private" });
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Start or continue" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current project was not changed");
    expect(alert.textContent).not.toContain("private");
  });
});
