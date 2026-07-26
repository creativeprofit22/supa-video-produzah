// @vitest-environment jsdom

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const windowApiMock = vi.hoisted(() => ({
  closeRequestHandler: undefined as
    ((event: { preventDefault: () => void }) => void | Promise<void>) | undefined,
  destroy: vi.fn<() => Promise<void>>(),
  onCloseRequested:
    vi.fn<
      (
        handler: (event: { preventDefault: () => void }) => void | Promise<void>,
      ) => Promise<() => void>
    >(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: windowApiMock.destroy,
    onCloseRequested: windowApiMock.onCloseRequested,
  }),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const convertFileSrcMock = vi.mocked(convertFileSrc);
const readyStatus = {
  ffmpeg: { available: true, version: "ffmpeg version 7.1" },
  ffprobe: { available: true, version: "ffprobe version 7.1" },
  ready: true,
} as const;

const problemExpectations = [
  [
    "not_found",
    (toolName: string) => `${toolName} was not found. Install ${toolName}, then check again.`,
  ],
  ["timed_out", (toolName: string) => `${toolName} check timed out. Check again.`],
  [
    "failed",
    (toolName: string) => `${toolName} could not run. Repair or reinstall it, then check again.`,
  ],
  [
    "invalid_version",
    (toolName: string) =>
      `${toolName} was not recognized. Replace it with a compatible ${toolName} binary, then check again.`,
  ],
] as const;

const toolProblemCases = (
  [
    ["ffmpeg", "FFmpeg"],
    ["ffprobe", "FFprobe"],
  ] as const
).flatMap(([slot, toolName]) =>
  problemExpectations.map(([problem, expectedLabel]) => ({
    slot,
    toolName,
    problem,
    expectedLabel: expectedLabel(toolName),
  })),
);
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

function changeTrimDraft(): void {
  fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
    target: { value: "5" },
  });
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
    windowApiMock.closeRequestHandler = undefined;
    windowApiMock.destroy.mockReset().mockResolvedValue(undefined);
    windowApiMock.onCloseRequested.mockReset().mockImplementation(async (handler) => {
      windowApiMock.closeRequestHandler = handler;
      return () => undefined;
    });
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

  it.each(toolProblemCases)(
    "shows $problem recovery for the $toolName slot",
    async ({ slot, problem, expectedLabel }) => {
      const unavailableTool = { available: false, problem };
      invokeMock.mockResolvedValueOnce(
        slot === "ffmpeg"
          ? { ffmpeg: unavailableTool, ffprobe: readyStatus.ffprobe, ready: false }
          : { ffmpeg: readyStatus.ffmpeg, ffprobe: unavailableTool, ready: false },
      );

      render(<App />);

      expect(await screen.findByText(expectedLabel)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
    },
  );

  it("shows the validated version for each available tool", async () => {
    invokeMock.mockResolvedValueOnce(readyStatus);

    render(<App />);

    expect(await screen.findByText(readyStatus.ffmpeg.version)).toBeTruthy();
    expect(screen.getByText(readyStatus.ffprobe.version)).toBeTruthy();
  });

  it("redacts unexpected process diagnostics from tool readiness", async () => {
    const privateDiagnostic = "private process output from a local path";
    invokeMock.mockResolvedValueOnce({
      ...readyStatus,
      ffmpeg: { ...readyStatus.ffmpeg, rawOutput: privateDiagnostic },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Could not check the media tools" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(privateDiagnostic);
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

  it("regrants persisted external media while missing media keeps reopen recovery", async () => {
    let savedDocument: Record<string, unknown> | undefined;
    let openedSourceStatus: "relink_required" | "missing" = "relink_required";
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_ffmpeg_status") return readyStatus;
      if (command === "video_pick_new_project_path") return projectPath;
      if (command === "video_pick_source") return sourcePath;
      if (command === "video_probe_media") return mediaProbe;
      if (command === "video_prepare_asset") return preparedAsset;
      if (command === "video_save_project") {
        savedDocument = (args as { document: Record<string, unknown> }).document;
        return null;
      }
      if (command === "video_open_project") {
        if (savedDocument === undefined) throw new Error("Expected a saved project");
        const revisions = savedDocument.revisions as Array<{
          id: string;
          state: { asset: { id: string } | null };
        }>;
        const currentRevisionId = savedDocument.currentRevisionId as string;
        const asset = revisions.find((revision) => revision.id === currentRevisionId)?.state.asset;
        return {
          path: projectPath,
          document: savedDocument,
          sources: [{ assetId: asset?.id, status: openedSourceStatus, resolvedPath: null }],
        };
      }
      if (command === "video_regrant_project_source") {
        const assetId = (args as { projectPath: string; assetId: string }).assetId;
        return { assetId, status: "resolved", resolvedPath: sourcePath };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<App />);
    await prepareProject();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const restoreButton = await screen.findByRole("button", { name: "Restore source access" });
    expect(screen.queryByRole("button", { name: "Open project again" })).toBeNull();
    fireEvent.click(restoreButton);

    await screen.findByText("Source resolved");
    const regrantCall = invokeMock.mock.calls.find(
      ([command]) => command === "video_regrant_project_source",
    );
    expect(regrantCall?.[1]).toEqual({
      projectPath,
      assetId: expect.any(String),
    });
    expect(screen.getByRole("heading", { name: "Prepared proxy" })).toBeTruthy();

    openedSourceStatus = "missing";
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const reopenButton = await screen.findByRole("button", { name: "Open project again" });
    expect(screen.queryByRole("button", { name: "Restore source access" })).toBeNull();
    const regrantCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "video_regrant_project_source",
    ).length;
    const openCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "video_open_project",
    ).length;
    fireEvent.click(reopenButton);
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_open_project"),
      ).toHaveLength(openCalls + 1),
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_regrant_project_source"),
    ).toHaveLength(regrantCalls);
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
    expect(screen.getByText("Unsaved trim")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_save_project"),
      ).toHaveLength(savesBeforeDraft + 1),
    );
    expect(screen.getByText("5–50")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("keeps New blocked until discard and returns focus on cancel or Escape", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    changeTrimDraft();
    const newButton = screen.getByRole("button", { name: "New" });
    newButton.focus();

    fireEvent.click(newButton);
    const dialog = screen.getByRole("dialog", { name: "Discard unsaved trim?" });
    const keepEditing = screen.getByRole("button", { name: "Keep editing" });
    await waitFor(() => expect(document.activeElement).toBe(keepEditing));
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_pick_new_project_path"),
    ).toHaveLength(1);

    fireEvent.click(keepEditing);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(newButton);
    expect(screen.getByText("Unsaved trim")).toBeTruthy();

    fireEvent.click(newButton);
    await waitFor(() => expect(document.activeElement).toBe(keepEditing));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(newButton);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_pick_new_project_path"),
    ).toHaveLength(1);
  });

  it("creates a new project only after explicit draft discard", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    changeTrimDraft();

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_pick_new_project_path"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_pick_new_project_path"),
      ).toHaveLength(2),
    );
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText("Unsaved trim")).toBeNull();
  });

  it("opens the picker only after explicit draft discard", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    changeTrimDraft();
    const openButton = screen.getByRole("button", { name: "Open" });
    openButton.focus();

    fireEvent.click(openButton);
    expect(invokeMock.mock.calls.some(([command]) => command === "video_open_project")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "video_open_project")).toBe(
        true,
      ),
    );
    expect(screen.getByText("Unsaved trim")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(openButton));
  });

  it("allows clean native close and guards dirty close without double prompts", async () => {
    configureReadyApp();
    render(<App />);
    await prepareProject();
    await waitFor(() => expect(windowApiMock.closeRequestHandler).toBeTypeOf("function"));
    const closeRequest = windowApiMock.closeRequestHandler;
    if (closeRequest === undefined) throw new Error("Expected native close listener");

    const cleanPreventDefault = vi.fn();
    await act(async () => closeRequest({ preventDefault: cleanPreventDefault }));
    expect(cleanPreventDefault).not.toHaveBeenCalled();
    expect(windowApiMock.destroy).not.toHaveBeenCalled();

    changeTrimDraft();
    const trimInput = screen.getByRole("spinbutton", { name: "Trim in" });
    trimInput.focus();
    const firstDirtyPreventDefault = vi.fn();
    await act(async () => closeRequest({ preventDefault: firstDirtyPreventDefault }));
    expect(firstDirtyPreventDefault).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog", { name: "Discard unsaved trim?" });
    expect(screen.getAllByRole("dialog", { name: "Discard unsaved trim?" })).toHaveLength(1);

    const repeatedPreventDefault = vi.fn();
    await act(async () => closeRequest({ preventDefault: repeatedPreventDefault }));
    expect(repeatedPreventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("dialog", { name: "Discard unsaved trim?" })).toHaveLength(1);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(document.activeElement).toBe(trimInput);
    expect(windowApiMock.destroy).not.toHaveBeenCalled();

    await act(async () => closeRequest({ preventDefault: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(windowApiMock.destroy).toHaveBeenCalledTimes(1));
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
