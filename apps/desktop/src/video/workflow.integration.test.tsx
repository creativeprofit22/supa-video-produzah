// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { createMockVideoService } from "../test-video-service";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: vi.fn(async () => undefined),
    onCloseRequested: vi.fn(async () => vi.fn()),
  }),
}));
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
function dispatchRender(payload: unknown) {
  const callback = listenMock.mock.calls.at(-1)?.[1] as EventCallback<unknown>;
  callback({ event: "video:render-event", id: 1, payload });
}
afterEach(cleanup);

describe("complete mocked Phase 2 workflow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(vi.fn());
  });

  it("creates, grouped-imports, trims, monotonic-undoes/redoes, exports, and reopens", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Prepared proxy" });
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
    expect(service.projection.revision.number).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await screen.findByRole("button", { name: "Cancel export" });
    const start = invokeMock.mock.calls.find(
      ([command]) => command === "video_start_render",
    )?.[1] as { plan: { planId: string; revisionId: string } };
    const identity = {
      jobId: "70000000-0000-4000-8000-000000000090",
      planId: start.plan.planId,
      revisionId: start.plan.revisionId,
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
        outputPath: service.outputPath,
        previewPath: "C:\\Neutral\\Cache\\final.mp4",
        probe: {
          ...service.projection.state.assets[0]!.probe,
          durationMicroseconds: 1_800_000,
          fileSizeBytes: 4_000_000,
        },
      },
    });
    expect(await screen.findByText("Export complete")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("spinbutton", { name: "Trim in" }) as HTMLInputElement).valueAsNumber,
      ).toBe(5),
    );
    expect(invokeMock.mock.calls.some(([command]) => command === "video_save_project")).toBe(false);
  });

  it.each(["video_probe_media", "video_prepare_asset", "video_start_render"])(
    "refreshes and disables media actions after %s reports tool_unavailable",
    async (failedCommand) => {
      const service = createMockVideoService();
      let toolsReady = true;
      let failureSent = false;
      invokeMock.mockImplementation(async (command, args) => {
        if (command === "video_ffmpeg_status" && !toolsReady)
          return {
            source: "bundled",
            toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
            ffmpeg: { available: false, problem: "not_found" },
            ffprobe: { available: false, problem: "not_found" },
            ready: false,
          };
        if (command === failedCommand && !failureSent) {
          failureSent = true;
          toolsReady = false;
          throw {
            code: "tool_unavailable",
            message: "Bundled media tools are unavailable",
            details: { operation: failedCommand },
          };
        }
        return service.invoke(command, args);
      });

      render(<App />);
      await screen.findByRole("heading", { name: "Ready for video work" });
      fireEvent.click(screen.getByRole("button", { name: "New project" }));
      await screen.findByRole("heading", { name: "Project media" });

      const chooseVideo = screen.getByRole("button", { name: "Choose video" });
      fireEvent.click(chooseVideo);
      if (failedCommand === "video_start_render") {
        await screen.findByRole("heading", { name: "Prepared proxy" });
        fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
      }

      await screen.findByText("Media tools unavailable");
      const currentChooseVideo = screen.queryByRole("button", { name: "Choose video" });
      if (currentChooseVideo !== null)
        expect((currentChooseVideo as HTMLButtonElement).disabled).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Export MP4" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_ffmpeg_status"),
      ).toHaveLength(2);
    },
  );

  it("keeps readiness valid after an ordinary render process failure", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_start_render")
        throw {
          code: "process_failed",
          message: "FFmpeg exited unsuccessfully",
          details: { operation: "render" },
        };
      return service.invoke(command, args);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Prepared proxy" });
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));

    await screen.findByText(
      "FFmpeg could not finish this export. Check disk space, then try again.",
    );
    expect(screen.queryByText("Media tools unavailable")).toBeNull();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_ffmpeg_status"),
    ).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Export MP4" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows durable checkpoint warnings without changing Saved semantics and clears them when healthy", async () => {
    const service = createMockVideoService({ checkpointWarningRevisions: [1] });
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));

    expect(await screen.findByText("Revision 1 is saved. Checkpoint pending.")).toBeTruthy();
    expect(screen.getByText(/Your edit is durable in the project journal/)).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim out" }), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));

    await waitFor(() =>
      expect(screen.queryByText("Revision 1 is saved. Checkpoint pending.")).toBeNull(),
    );
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("relinks a missing source in place and prepares the returned projection", async () => {
    const service = createMockVideoService({ sourceStatusOnOpen: "missing" });
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByLabelText("Prepared source proxy");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("Source file is missing");
    expect(
      screen.getByText("Choose the source file at its new location to continue working."),
    ).toBeTruthy();
    const openCallsBeforeRecovery = invokeMock.mock.calls.filter(
      ([command]) => command === "video_open_project",
    ).length;
    const prepareCallsBeforeRecovery = invokeMock.mock.calls.filter(
      ([command]) => command === "video_prepare_asset",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Choose replacement" }));

    await screen.findByText("Source resolved");
    await screen.findByLabelText("Prepared source proxy");
    const assetId = service.projection.state.assets[0]!.id;
    expect(invokeMock).toHaveBeenCalledWith("video_relink_project_asset", {
      projectId: service.projection.projectId,
      assetId,
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_open_project"),
    ).toHaveLength(openCallsBeforeRecovery);
    const prepareCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "video_prepare_asset",
    );
    expect(prepareCalls).toHaveLength(prepareCallsBeforeRecovery + 1);
    expect(prepareCalls.at(-1)?.[1]).toMatchObject({
      projectId: service.projection.projectId,
      assetId,
      path: service.replacementPath,
    });
  });
  it("preserves the opener on cancellation and redacts malformed open", async () => {
    const service = createMockVideoService();
    let openCount = 0;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_open_project")
        return openCount++ === 0 ? null : { privateDiagnostic: "C:\\Users\\private" };
      return service.invoke(command, args);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Start or continue" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("private");
  });
});
