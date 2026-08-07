// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";
import type { MediaJobRecord } from "@supa-video/media";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { CommandProvider } from "../commands/CommandProvider";
import { createMockVideoService, testMediaJob } from "../test-video-service";
import { useVideoProject } from "../use-video-project";
import { VideoWorkspace } from "./VideoWorkspace";
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
function dispatchTauriEvent(eventName: string, payload: unknown) {
  const callback = listenMock.mock.calls.find(([name]) => name === eventName)?.[1] as
    EventCallback<unknown> | undefined;
  if (callback === undefined) throw new Error(`No listener registered for ${eventName}`);
  callback({ event: eventName, id: 1, payload });
}
function dispatchRender(payload: unknown) {
  dispatchTauriEvent("video:render-event", payload);
}
function dispatchMediaJob(payload: unknown) {
  dispatchTauriEvent("video:media-job-event", payload);
}
class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}
function RippleWorkflowHarness() {
  const controller = useVideoProject();
  const sequence = controller.projection?.state.sequences.find(
    ({ id }) => id === controller.projection?.state.activeSequenceId,
  );
  const firstClip = sequence?.tracks.find((track) => track.kind !== "caption")?.clips[0];
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void controller
            .newProject()
            .then(() => controller.prepareImportedSource("C:\\Neutral\\Media\\clip.mp4"))
        }
      >
        Initialize ripple workflow
      </button>
      <button
        type="button"
        disabled={firstClip === undefined}
        onClick={() =>
          firstClip === undefined
            ? undefined
            : void controller.splitTimelineClip({
                clipId: firstClip.id,
                sourceFrame: firstClip.sourceIn.value + 10,
              })
        }
      >
        Split ripple fixture
      </button>
      {controller.project === null ? null : (
        <VideoWorkspace
          controller={controller}
          mediaJobs={[]}
          project={controller.project}
          readiness={{
            phase: "loaded",
            value: {
              source: "bundled",
              toolchainId: "ffmpeg-test-v1",
              ffmpeg: { available: true, version: "test" },
              ffprobe: { available: true, version: "test" },
              ready: true,
            },
          }}
          onCheckTools={() => undefined}
          onOpenJobCenter={() => undefined}
        />
      )}
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("complete mocked Phase 2 workflow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(vi.fn());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });

  it("creates, grouped-imports, trims, monotonic-undoes/redoes, exports, and reopens", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim in" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Trim out" }), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
    await waitFor(() => expect(screen.getByText("5–50")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getAllByText("0–100").length).toBeGreaterThan(0));
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
  }, 15_000);

  it("routes timeline split through mock IPC and exposes precise undo and redo labels", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const split = screen.getByRole("button", { name: "Split at playhead" });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    expect((split as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(split);

    await waitFor(() =>
      expect(service.projection.state.sequences[0]!.tracks[0]!.kind).toBe("video"),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
      ).toHaveLength(2),
    );
    const splitRequest = invokeMock.mock.calls
      .filter(([command]) => command === "video_execute_project_group")
      .at(-1)?.[1] as { request: { commands: Array<Record<string, unknown>> } };
    expect(splitRequest.request.commands).toEqual([
      expect.objectContaining({
        type: "SplitClip",
        splitAt: expect.objectContaining({ value: 10 }),
      }),
    ]);

    fireEvent.keyDown(window, { code: "KeyD", ctrlKey: true, altKey: true });
    const inspector = (await screen.findByRole("heading", { name: "Project inspector" })).closest(
      "section",
    )!;
    expect(within(inspector).getByText("Split clip")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(service.projection.lastCommand?.summary).toBe("Undid Split clip"));
    fireEvent.keyDown(window, { code: "KeyD", ctrlKey: true, altKey: true });
    const undoInspector = screen
      .getByRole("heading", { name: "Project inspector" })
      .closest("section")!;
    expect(await within(undoInspector).findByText("Undid Split clip")).toBeTruthy();
    fireEvent.click(within(undoInspector).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(service.projection.lastCommand?.summary).toBe("Redid Split clip"));
    fireEvent.keyDown(window, { code: "KeyD", ctrlKey: true, altKey: true });
    const redoInspector = screen
      .getByRole("heading", { name: "Project inspector" })
      .closest("section")!;
    expect(await within(redoInspector).findByText("Redid Split clip")).toBeTruthy();
    expect(invokeMock.mock.calls.some(([command]) => command === "video_undo_project")).toBe(true);
    expect(invokeMock.mock.calls.some(([command]) => command === "video_redo_project")).toBe(true);
  });

  it("round-trips video visibility through IPC and canonical projection authority", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const sequence = service.projection.state.sequences.find(
      ({ id }) => id === service.projection.state.activeSequenceId,
    )!;
    sequence.tracks.push({
      id: "70000000-0000-4000-8000-000000000096",
      name: "Audio 1",
      kind: "audio",
      clips: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("group", { name: "Audio 1 track controls" });

    const videoOutput = () => screen.getByRole("button", { name: "Video 1 video output" });
    const canonicalVideoTrack = () =>
      service.projection.state.sequences[0]!.tracks.find((track) => track.kind === "video");
    expect(videoOutput().getAttribute("aria-pressed")).toBe("true");
    expect(
      within(screen.getByRole("group", { name: "Audio 1 track controls" })).queryByRole("button", {
        name: "Audio 1 audio output",
      }),
    ).toBeNull();

    fireEvent.click(videoOutput());

    await waitFor(() => expect(canonicalVideoTrack()?.hidden).toBe(true));
    expect(service.projection.lastCommand?.summary).toBe("Hid track");
    expect(canonicalVideoTrack()).toMatchObject({ kind: "video", hidden: true });
    expect(videoOutput().getAttribute("aria-pressed")).toBe("false");
    expect(videoOutput().textContent).toContain("Show");
    expect(
      videoOutput().closest(".multitrack-visible-label")?.getAttribute("data-track-hidden"),
    ).toBe("true");
    expect(await screen.findByText("Video track hidden")).toBeTruthy();

    fireEvent.click(videoOutput());

    await waitFor(() => expect(canonicalVideoTrack()?.hidden).toBe(false));
    expect(service.projection.lastCommand?.summary).toBe("Showed track");
    expect(videoOutput().getAttribute("aria-pressed")).toBe("true");
    expect(videoOutput().textContent).toContain("Hide");
    expect(screen.queryByText("Video track hidden")).toBeNull();
  });

  it("locks a track through the controller and round-trips undo while blocking timeline edits", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("multitrack-scroll-region") ? 320 : 0;
    });
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const lockToggle = screen.getByRole("button", { name: "Video 1 track lock" });
    expect(lockToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lockToggle);

    await waitFor(() =>
      expect(service.projection.state.sequences[0]!.tracks[0]!.locked).toBe(true),
    );
    expect(service.projection.revision.number).toBe(2);
    expect(lockToggle.getAttribute("aria-pressed")).toBe("true");
    expect(lockToggle.textContent).toContain("Unlock");
    const executeCallsAfterLock = invokeMock.mock.calls.filter(
      ([command]) => command === "video_execute_project_group",
    );
    expect(executeCallsAfterLock.at(-1)?.[1]).toMatchObject({
      request: {
        baseRevision: 1,
        commands: [expect.objectContaining({ type: "SetTrackLocked", locked: true })],
      },
    });

    const clip = screen.getByRole("button", {
      name: /clip\.mp4, frames 0 through 100.*locked track/,
    });
    fireEvent.click(clip);
    expect(clip.getAttribute("aria-pressed")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Split at playhead" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Ripple delete clip" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Trim start of clip.mp4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.keyDown(clip, { code: "KeyS" });
    fireEvent.keyDown(clip, { code: "Delete", shiftKey: true });
    fireEvent.keyDown(clip, { code: "ArrowLeft", altKey: true });
    fireEvent.keyDown(clip, { code: "ArrowRight", altKey: true });
    fireEvent.pointerDown(clip, { button: 0, pointerId: 41, clientX: 8 });
    fireEvent.pointerMove(clip, { pointerId: 41, clientX: 24 });
    fireEvent.pointerUp(clip, { pointerId: 41, clientX: 24 });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
    ).toHaveLength(executeCallsAfterLock.length);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(service.projection.lastCommand?.summary).toBe("Undid Locked track"));
    expect(lockToggle.getAttribute("aria-pressed")).toBe("false");
    expect(lockToggle.textContent).toContain("Lock");

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(service.projection.lastCommand?.summary).toBe("Redid Locked track"));
    expect(lockToggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("falls back to the first clip when undo removes the selected clip", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
    const rightClip = await screen.findByRole("button", {
      name: /clip\.mp4, frames 10 through 100/,
    });
    fireEvent.click(rightClip);
    expect(rightClip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /clip\.mp4, frames 0 through 100/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(screen.queryByRole("button", { name: /clip\.mp4, frames 10 through 100/ })).toBeNull();
  });

  it("ripple deletes one revision, selects the survivor, and round-trips undo and redo", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(
      <CommandProvider>
        <RippleWorkflowHarness />
      </CommandProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Initialize ripple workflow" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const originalClip = await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 100/,
    });
    expect(originalClip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Split ripple fixture" }));
    await screen.findByRole("button", { name: /clip\.mp4, frames 10 through 100/ });
    const splitTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (splitTrack.kind === "caption") throw new Error("Expected mock clip track");
    const survivorId = splitTrack.clips[1]!.id;
    expect(splitTrack.clips.map((clip) => clip.timelineStart.value)).toEqual([0, 10]);
    expect(service.projection.revision.number).toBe(2);

    const rippleDelete = screen.getByRole("button", { name: "Ripple delete clip" });
    expect((rippleDelete as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(rippleDelete);

    await waitFor(() => expect(service.projection.revision.number).toBe(3));
    const rippleTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (rippleTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(rippleTrack.clips.map((clip) => [clip.id, clip.timelineStart.value])).toEqual([
      [survivorId, 0],
    ]);
    const executeCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "video_execute_project_group",
    );
    const rippleRequest = executeCalls.at(-1)?.[1] as {
      request: { baseRevision: number; commands: Array<Record<string, unknown>> };
    };
    expect(rippleRequest.request.baseRevision).toBe(2);
    expect(rippleRequest.request.commands).toEqual([
      expect.objectContaining({ type: "RippleDeleteClip" }),
    ]);
    const selectedSurvivor = await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 90/,
    });
    await waitFor(() => expect(selectedSurvivor.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(service.projection.revision.number).toBe(4));
    const undoTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (undoTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(undoTrack.clips.map((clip) => clip.timelineStart.value)).toEqual([0, 10]);
    expect(service.projection.lastCommand?.summary).toBe("Undid Ripple deleted clip");

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(service.projection.revision.number).toBe(5));
    const redoTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (redoTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(redoTrack.clips.map((clip) => [clip.id, clip.timelineStart.value])).toEqual([
      [survivorId, 0],
    ]);
    expect(service.projection.lastCommand?.summary).toBe("Redid Ripple deleted clip");
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /clip\.mp4, frames 0 through 90/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("moves one frame per keyboard action and round-trips undo and redo", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const initialBody = await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 100/,
    });
    expect(service.projection.revision.number).toBe(1);
    expect(initialBody.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowRight");
    fireEvent.keyDown(initialBody, { code: "ArrowRight", altKey: true });

    await waitFor(() => expect(service.projection.revision.number).toBe(2));
    const movedTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (movedTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(movedTrack.clips[0]!.timelineStart.value).toBe(1);
    const moveRequest = invokeMock.mock.calls
      .filter(([command]) => command === "video_execute_project_group")
      .at(-1)?.[1] as {
      request: { baseRevision: number; commands: Array<Record<string, unknown>> };
    };
    expect(moveRequest.request).toMatchObject({
      baseRevision: 1,
      commands: [
        expect.objectContaining({
          type: "MoveClip",
          timelineStart: expect.objectContaining({ value: 1 }),
        }),
      ],
    });
    expect(moveRequest.request.commands).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(service.projection.revision.number).toBe(3));
    const undoTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (undoTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(undoTrack.clips[0]!.timelineStart.value).toBe(0);
    expect(service.projection.lastCommand?.summary).toBe("Undid Moved clip");

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(service.projection.revision.number).toBe(4));
    const redoTrack = service.projection.state.sequences[0]!.tracks[0]!;
    if (redoTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(redoTrack.clips[0]!.timelineStart.value).toBe(1);
    expect(service.projection.lastCommand?.summary).toBe("Redid Moved clip");

    fireEvent.click(screen.getByRole("button", { name: "Video 1 track lock" }));
    await waitFor(() => expect(service.projection.revision.number).toBe(5));
    const lockedBody = await screen.findByRole("button", {
      name: /clip\.mp4, frames 1 through 101.*locked track/,
    });
    const executeCount = invokeMock.mock.calls.filter(
      ([command]) => command === "video_execute_project_group",
    ).length;
    fireEvent.keyDown(lockedBody, { code: "ArrowRight", altKey: true });
    expect(service.projection.revision.number).toBe(5);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
    ).toHaveLength(executeCount);
  });

  it("routes timeline move and grouped left trim through one group per gesture", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("multitrack-scroll-region") ? 320 : 0;
    });
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const initialBody = await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 100/,
    });
    expect(initialBody.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(initialBody, { button: 0, pointerId: 21, clientX: 12 });
    fireEvent.pointerMove(initialBody, { pointerId: 21, clientX: 24 });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
    ).toHaveLength(1);
    fireEvent.pointerUp(initialBody, { pointerId: 21, clientX: 24 });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
      ).toHaveLength(2),
    );
    const moveRequest = invokeMock.mock.calls
      .filter(([command]) => command === "video_execute_project_group")
      .at(-1)?.[1] as { request: { commands: Array<Record<string, unknown>> } };
    const moveCommand = moveRequest.request.commands[0] as {
      type: string;
      timelineStart: { value: number };
    };
    expect(moveRequest.request.commands).toHaveLength(1);
    expect(moveCommand.type).toBe("MoveClip");
    expect(moveCommand.timelineStart.value).toBeGreaterThan(0);
    expect(service.projection.lastCommand?.summary).toBe("Moved clip");

    const leftHandle = await screen.findByRole("button", { name: "Trim start of clip.mp4" });
    fireEvent.pointerDown(leftHandle, { button: 0, pointerId: 22, clientX: 8 });
    fireEvent.pointerMove(leftHandle, { pointerId: 22, clientX: 12 });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
    ).toHaveLength(2);
    fireEvent.pointerUp(leftHandle, { pointerId: 22, clientX: 12 });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_execute_project_group"),
      ).toHaveLength(3),
    );
    const trimRequest = invokeMock.mock.calls
      .filter(([command]) => command === "video_execute_project_group")
      .at(-1)?.[1] as { request: { commands: Array<Record<string, unknown>> } };
    expect(trimRequest.request.commands.map(({ type }) => type)).toEqual(["TrimClip", "MoveClip"]);
    const trimCommand = trimRequest.request.commands[0] as { sourceIn: { value: number } };
    const trimMoveCommand = trimRequest.request.commands[1] as { timelineStart: { value: number } };
    expect(trimCommand.sourceIn.value).toBeGreaterThan(0);
    expect(trimMoveCommand.timelineStart.value).toBe(
      moveCommand.timelineStart.value + trimCommand.sourceIn.value,
    );
    expect(service.projection.lastCommand?.summary).toBe("Applied trim, Moved clip");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(service.projection.lastCommand?.summary).toBe("Undid Applied trim, Moved clip"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() =>
      expect(service.projection.lastCommand?.summary).toBe("Redid Applied trim, Moved clip"),
    );
  });

  it("keeps move snapping tied to the previewed clip when another overlapping-source clip is selected", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("multitrack-scroll-region") ? 1_000 : 0;
    });
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    const rendered = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const sequence = service.projection.state.sequences.find(
      ({ id }) => id === service.projection.state.activeSequenceId,
    )!;
    const videoTrack = sequence.tracks.find((track) => track.kind === "video")!;
    if (videoTrack.kind !== "video") throw new Error("Expected mock video track");
    const previewedClip = videoTrack.clips[0]!;
    previewedClip.timelineStart.value = 40;
    const selectedClip = structuredClone(previewedClip);
    selectedClip.id = "70000000-0000-4000-8000-000000000099";
    selectedClip.timelineStart.value = 0;
    sequence.tracks.push({
      id: "70000000-0000-4000-8000-000000000098",
      name: "Cross-track selection",
      kind: "video",
      clips: [selectedClip],
    });
    expect(selectedClip.sourceIn).toEqual(previewedClip.sourceIn);
    expect(selectedClip.sourceOut).toEqual(previewedClip.sourceOut);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 100/,
    });
    await waitFor(() => expect(screen.getAllByText("Saved").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    await screen.findByText("Frame 50");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Ripple delete clip" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const selectedBody = screen.getByRole("button", { name: /clip\.mp4, frames 0 through 100/ });
    fireEvent.click(selectedBody);
    expect(selectedBody.getAttribute("aria-pressed")).toBe("true");

    fireEvent.pointerDown(selectedBody, { button: 0, pointerId: 51, clientX: 10 });
    let movedClip = rendered.container.querySelector<HTMLElement>(
      `.multitrack-clip[data-clip-id='${selectedClip.id}']`,
    );
    expect(movedClip?.classList.contains("is-dragging")).toBe(true);
    fireEvent.pointerMove(selectedBody, { pointerId: 51, clientX: 18 });

    movedClip = rendered.container.querySelector<HTMLElement>(
      `.multitrack-clip[data-clip-id='${selectedClip.id}']`,
    );
    expect(movedClip?.dataset.startFrame).toBe("50");
    const guide = rendered.container.querySelector<HTMLElement>(".multitrack-snap-guide");
    expect(guide?.dataset.snapTargetKind).toBe("playhead");
    expect(guide?.dataset.snapFrame).toBe("50");
  });

  it("rejects an illegal same-track snap with a native-style clip_overlap error", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("multitrack-scroll-region") ? 1_000 : 0;
    });
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    const rendered = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const sequence = service.projection.state.sequences.find(
      ({ id }) => id === service.projection.state.activeSequenceId,
    )!;
    const videoTrack = sequence.tracks.find((track) => track.kind === "video")!;
    if (videoTrack.kind !== "video") throw new Error("Expected mock video track");
    const movingClip = videoTrack.clips[0]!;
    const siblingClip = structuredClone(movingClip);
    siblingClip.id = "70000000-0000-4000-8000-000000000097";
    siblingClip.timelineStart.value = 120;
    videoTrack.clips.push(siblingClip);
    const revisionBeforeMove = service.projection.revision.number;

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const movingBody = await screen.findByRole("button", {
      name: /clip\.mp4, frames 0 through 100/,
    });
    await waitFor(() => expect(screen.getAllByText("Saved").length).toBeGreaterThan(0));
    fireEvent.click(movingBody);
    fireEvent.pointerDown(movingBody, { button: 0, pointerId: 61, clientX: 10 });
    fireEvent.pointerMove(movingBody, { pointerId: 61, clientX: 29.2 });

    const movingElement = rendered.container.querySelector<HTMLElement>(
      `.multitrack-clip[data-clip-id='${movingClip.id}']`,
    );
    expect(rendered.container.querySelector(".multitrack-snap-guide")).toBeNull();
    expect(movingElement?.dataset.startFrame).toBe("120");
    fireEvent.pointerUp(movingBody, { pointerId: 61, clientX: 29.2 });

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some(({ textContent }) =>
            textContent?.includes("Project command failed its preconditions"),
          ),
      ).toBe(true),
    );
    expect(service.projection.revision.number).toBe(revisionBeforeMove);
    expect(videoTrack.clips.find(({ id }) => id === movingClip.id)?.timelineStart.value).toBe(0);
  });

  it("loads equal-timestamp media jobs across composite cursor pages without gaps", async () => {
    const jobs: MediaJobRecord[] = Array.from({ length: 101 }, (_, index) => {
      const number = index + 1;
      return {
        ...testMediaJob,
        id: `70000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
        summary: `Pagination job ${number.toString().padStart(3, "0")}`,
      };
    });
    const expectedSummaries = [...jobs]
      .sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
      .map((job) => job.summary);
    const service = createMockVideoService({ mediaJobs: jobs });
    invokeMock.mockImplementation(service.invoke);

    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    const jobCenter = await screen.findByRole("region", { name: "Job Center" });
    const loadOlder = await within(jobCenter).findByRole("button", { name: "Load older jobs" });
    const visibleSummaries = () =>
      within(jobCenter)
        .getAllByRole("article")
        .map((article) => within(article).getByRole("heading", { level: 3 }).textContent);

    expect(visibleSummaries()).toEqual(expectedSummaries.slice(0, 100));
    expect(within(jobCenter).queryByRole("heading", { name: "Pagination job 001" })).toBeNull();
    await waitFor(() => expect(jobCenter.getAttribute("aria-busy")).toBe("false"));

    fireEvent.click(loadOlder);

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "video_list_media_jobs"),
      ).toHaveLength(2),
    );
    const requests = invokeMock.mock.calls
      .filter(([command]) => command === "video_list_media_jobs")
      .map(([, args]) => (args as { request: Record<string, unknown> }).request);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      limit: 100,
      beforeUpdatedAt: testMediaJob.updatedAt,
      beforeJobId: jobs[1]!.id,
    });
    await waitFor(() => expect(visibleSummaries()).toEqual(expectedSummaries));
    expect(
      within(jobCenter).getByText("1 older job loaded. All available jobs are shown."),
    ).toBeTruthy();
    await expect(
      service.invoke("video_list_media_jobs", {
        request: {
          limit: 100,
          includeSettled: true,
          projectId: null,
          beforeUpdatedAt: testMediaJob.updatedAt,
          beforeJobId: null,
        },
      }),
    ).rejects.toThrow("beforeUpdatedAt and beforeJobId must be provided together");
  });

  it.each(["video_prepare_asset", "video_start_render"] as const)(
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
        await screen.findByRole("heading", { name: "Canonical composition" });
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
    await screen.findByRole("heading", { name: "Canonical composition" });
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
    await screen.findByLabelText("Canonical video layer 1");

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
    await screen.findByLabelText("Canonical video layer 1");
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
  it("reconciles preparation retry and recovery in the panel and Job Center", async () => {
    const service = createMockVideoService({ mediaJobs: [] });
    let failNextPreparation = false;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_prepare_asset" && failNextPreparation) {
        failNextPreparation = false;
        throw {
          code: "process_failed",
          message: "Preview preparation did not complete",
          details: { operation: "prepare_asset" },
        };
      }
      return service.invoke(command, args);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const assetId = service.projection.state.assets[0]!.id;
    const blocked = {
      ...testMediaJob,
      projectId: service.projection.projectId,
      assetId,
      revisionId: null,
      state: "blocked",
      stage: "blocked",
      error: {
        code: "temporary_preview_failure",
        category: "transient_io",
        message: "Preview preparation needs attention.",
        retryable: true,
        action: "retry",
      },
      updatedAt: "2026-07-26T12:00:01.000Z",
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([blocked]));
    expect(await screen.findByText("Preview preparation: Needs attention")).toBeTruthy();

    failNextPreparation = true;
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.queryByText("Could not prepare the preview")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open preview preparation in Job Center" }));
    const jobTitle = await screen.findByRole("heading", { name: "Prepare preview media" });
    await waitFor(() => expect(document.activeElement).toBe(jobTitle.closest("article")));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Preview preparation: Queued")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Job Center" })).toBeTruthy();

    const complete = {
      ...blocked,
      state: "complete",
      stage: "complete",
      progress: { completed: 2, total: 2, unit: "stages" },
      error: null,
      settledAt: "2026-07-26T12:00:02.000Z",
      updatedAt: "2026-07-26T12:00:02.000Z",
      resultAvailable: true,
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([complete]));

    expect(await screen.findByText("Preview preparation: Complete")).toBeTruthy();
    expect(await screen.findByLabelText("Canonical video layer 1")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Job Center" })).getByText("Complete"),
    ).toBeTruthy();
  });

  it("reauthorizes a restarted final render as one durable lifecycle in ExportPanel and Job Center", async () => {
    const durableJobId = "70000000-0000-4000-8000-000000000095";
    const persistedPlanId = "70000000-0000-4000-8000-000000000096";
    const blocked = {
      ...testMediaJob,
      id: durableJobId,
      kind: "final_render",
      projectId: null,
      assetId: null,
      revisionId: "70000000-0000-4000-8000-000000000101",
      priority: "export",
      state: "blocked",
      stage: "authorization",
      progress: { completed: 0, total: 1_800_000, unit: "microseconds" },
      error: {
        code: "output_authorization_required",
        category: "output_authorization_required",
        message: "Choose the export destination again to continue.",
        retryable: false,
        action: "reauthorize_output",
      },
      updatedAt: "2026-07-26T12:00:01.000Z",
    } as MediaJobRecord;
    const service = createMockVideoService({ mediaJobs: [blocked] });
    let reauthorizedPlanId: string | null = null;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "video_reauthorize_media_job_output") {
        reauthorizedPlanId = persistedPlanId;
        expect(args).toEqual({
          request: { jobId: durableJobId, outputPath: service.outputPath },
        });
      }
      return service.invoke(command, args);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });

    const exportPanel = screen.getByRole("region", { name: "Export MP4" });
    expect(await within(exportPanel).findByText("Final export: Needs attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    const jobCenter = await screen.findByRole("region", { name: "Job Center" });
    fireEvent.click(
      within(jobCenter).getByRole("button", { name: "Choose destination and retry" }),
    );

    expect(await within(exportPanel).findByText("Final export: Queued")).toBeTruthy();
    expect(within(jobCenter).getByText("Queued", { exact: true })).toBeTruthy();
    expect(reauthorizedPlanId).toBe(persistedPlanId);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "video_start_render"),
    ).toHaveLength(0);
    expect(
      within(jobCenter)
        .getAllByRole("article")
        .filter((article) => article.getAttribute("aria-labelledby")?.includes(durableJobId)),
    ).toHaveLength(1);

    const complete = {
      ...blocked,
      state: "complete",
      stage: "complete",
      progress: { completed: 1_800_000, total: 1_800_000, unit: "microseconds" },
      error: null,
      settledAt: "2026-07-26T12:00:03.000Z",
      updatedAt: "2026-07-26T12:00:03.000Z",
      resultAvailable: true,
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([complete]));

    expect(await within(exportPanel).findByText("Final export: Complete")).toBeTruthy();
    expect(within(jobCenter).getByText("Complete", { exact: true })).toBeTruthy();
  });

  it("uses one durable render lifecycle through retry and cancellation", async () => {
    const service = createMockVideoService({ mediaJobs: [] });
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });
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
    const running = {
      ...testMediaJob,
      id: identity.jobId,
      kind: "final_render",
      projectId: null,
      assetId: null,
      revisionId: identity.revisionId,
      priority: "export",
      state: "running",
      stage: "encoding",
      progress: { completed: 900_000, total: 1_800_000, unit: "microseconds" },
      attempt: 1,
      startedAt: "2026-07-26T12:00:01.000Z",
      updatedAt: "2026-07-26T12:00:01.000Z",
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([running]));
    expect(await screen.findByText("Final export: Running")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open final export in Job Center" }));
    await screen.findByRole("heading", { name: "Job Center" });
    const exportPanel = screen.getByRole("region", { name: "Export MP4" });
    expect(within(exportPanel).queryByText("Exporting video")).toBeNull();

    const retrying = {
      ...running,
      state: "retrying",
      stage: "retry_wait",
      retryAt: "2026-07-26T12:01:00.000Z",
      error: {
        code: "transient_render_failure",
        category: "transient_io",
        message: "The export will retry.",
        retryable: true,
        action: "retry",
      },
      updatedAt: "2026-07-26T12:00:02.000Z",
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([retrying]));
    expect(await within(exportPanel).findByText("Final export: Retry scheduled")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Job Center" })).getByText("Retry scheduled"),
    ).toBeTruthy();
    expect(within(exportPanel).queryByText("Exporting video")).toBeNull();

    fireEvent.click(within(exportPanel).getByRole("button", { name: "Cancel export" }));
    dispatchRender({ type: "cancelled", ...identity });
    const cancelled = {
      ...running,
      state: "cancelled",
      stage: "cancelled",
      settledAt: "2026-07-26T12:00:03.000Z",
      updatedAt: "2026-07-26T12:00:03.000Z",
    } as MediaJobRecord;
    dispatchMediaJob(service.replaceMediaJobs([cancelled]));

    expect(await within(exportPanel).findByText("Final export: Cancelled")).toBeTruthy();
    expect(within(exportPanel).queryByText("Export cancelled")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Job Center" })).getByText("Cancelled"),
    ).toBeTruthy();
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
