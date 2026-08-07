// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as testingLibraryRender,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandProvider } from "../commands/CommandProvider";
import { ProgramMonitor } from "./ProgramMonitor";

function render(ui: ReactElement): RenderResult {
  const result = testingLibraryRender(<CommandProvider>{ui}</CommandProvider>);
  const rerender = (nextUi: ReactNode) =>
    result.rerender(<CommandProvider>{nextUi}</CommandProvider>);
  return { ...result, rerender };
}

const rate = { numerator: 25, denominator: 1 } as const;
const originalRequestVideoFrameCallback = Object.getOwnPropertyDescriptor(
  HTMLVideoElement.prototype,
  "requestVideoFrameCallback",
);
const originalCancelVideoFrameCallback = Object.getOwnPropertyDescriptor(
  HTMLVideoElement.prototype,
  "cancelVideoFrameCallback",
);

function restoreVideoFrameCallbacks(): void {
  if (originalRequestVideoFrameCallback === undefined) {
    Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
  } else {
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "requestVideoFrameCallback",
      originalRequestVideoFrameCallback,
    );
  }
  if (originalCancelVideoFrameCallback === undefined) {
    Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
  } else {
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "cancelVideoFrameCallback",
      originalCancelVideoFrameCallback,
    );
  }
}

function installVideoFrameCallbacks() {
  let nextId = 1;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  const request = vi.fn((callback: VideoFrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value: request,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
    configurable: true,
    value: cancel,
  });

  const peekNext = (): { id: number; callback: VideoFrameRequestCallback } => {
    const entry = callbacks.entries().next().value as
      [number, VideoFrameRequestCallback] | undefined;
    if (entry === undefined) {
      throw new Error("Expected a pending video frame callback");
    }
    return { id: entry[0], callback: entry[1] };
  };

  return {
    request,
    cancel,
    peekNext,
    pendingCount: () => callbacks.size,
    fireNext(mediaTime: number) {
      const pending = peekNext();
      callbacks.delete(pending.id);
      act(() => {
        pending.callback(0, { mediaTime } as VideoFrameCallbackMetadata);
      });
    },
  };
}

function preparedProxyMonitor(
  proxyPath = "/cache/proxy.mp4",
  hasAudio = true,
  timelineAudioMuted = false,
) {
  return (
    <ProgramMonitor
      proxyPath={proxyPath}
      finalPreviewPath={null}
      hasAudio={hasAudio}
      timelineAudioMuted={timelineAudioMuted}
      timelineVideoHidden={false}
      convertCachePath={(path) => `asset:${path}`}
      rate={rate}
      trimIn={10}
      trimOut={90}
      playhead={10}
      onPlayheadChange={vi.fn()}
    />
  );
}

describe("ProgramMonitor", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    restoreVideoFrameCallbacks();
  });

  it("shows active source captions and leaves captions to the burned-in final preview", () => {
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio={false}
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        activeCaptions={[{ captionId: "shown-cue", text: "Shown cue" }]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={0}
        trimOut={100}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );

    const overlay = screen.getByLabelText("Active captions");
    expect(overlay.textContent).toContain("Shown cue");
    expect(overlay.querySelector('[data-caption-id="shown-cue"]')).not.toBeNull();
    expect(screen.queryByText("Hidden cue")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(screen.queryByLabelText("Active captions")).toBeNull();
  });

  it("stacks canonical source layers and removes hidden layers without muting their audio", () => {
    const { container } = render(
      <ProgramMonitor
        proxyPath={null}
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        sourceLayers={[
          {
            clipId: "top",
            path: "/cache/top.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 0,
            sourceInFrame: 10,
            sourceOutFrame: 90,
            hidden: true,
            muted: false,
            hasAudio: true,
          },
          {
            clipId: "bottom",
            path: "/cache/bottom.mp4",
            canonicalTrackIndex: 1,
            timelineStartFrame: 0,
            sourceInFrame: 10,
            sourceOutFrame: 90,
            hidden: false,
            muted: true,
            hasAudio: true,
          },
        ]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );

    const layers = [...container.querySelectorAll<HTMLVideoElement>("video[data-clip-id]")];
    expect(layers.map((layer) => layer.dataset.clipId)).toEqual(["top", "bottom"]);
    expect(layers[0]?.style.visibility).toBe("hidden");
    expect(layers[0]?.style.zIndex).toBe("0");
    expect(layers[1]?.style.visibility).toBe("visible");
    expect(layers[1]?.style.zIndex).toBe("1");
    expect(screen.queryByText("Video track hidden")).toBeNull();
    expect(screen.getByRole("button", { name: "Mute audio" })).toHaveProperty("disabled", false);
  });

  it("densely stacks visible video layers across caption, audio, and hidden canonical slots", () => {
    const { container } = render(
      <ProgramMonitor
        proxyPath={null}
        finalPreviewPath={null}
        hasAudio={false}
        timelineAudioMuted
        timelineVideoHidden={false}
        sourceLayers={[
          {
            clipId: "front-video",
            path: "/cache/front.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 100,
            hidden: false,
            muted: false,
            hasAudio: false,
          },
          {
            clipId: "hidden-video",
            path: "/cache/hidden.mp4",
            canonicalTrackIndex: 2,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 100,
            hidden: true,
            muted: false,
            hasAudio: false,
          },
          {
            clipId: "middle-video",
            path: "/cache/middle.mp4",
            canonicalTrackIndex: 4,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 100,
            hidden: false,
            muted: false,
            hasAudio: false,
          },
          {
            clipId: "back-video",
            path: "/cache/back.mp4",
            canonicalTrackIndex: 8,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 100,
            hidden: false,
            muted: false,
            hasAudio: false,
          },
        ]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={0}
        trimOut={100}
        playhead={0}
        onPlayheadChange={vi.fn()}
      />,
    );
    const layerStyles = new Map(
      [...container.querySelectorAll<HTMLVideoElement>("video[data-clip-id]")].map((layer) => [
        layer.dataset.clipId,
        { visibility: layer.style.visibility, zIndex: Number(layer.style.zIndex) },
      ]),
    );

    expect(layerStyles).toEqual(
      new Map([
        ["front-video", { visibility: "visible", zIndex: 3 }],
        ["hidden-video", { visibility: "hidden", zIndex: 0 }],
        ["middle-video", { visibility: "visible", zIndex: 2 }],
        ["back-video", { visibility: "visible", zIndex: 1 }],
      ]),
    );
    expect(
      [...layerStyles.values()]
        .filter(({ visibility }) => visibility === "visible")
        .every(({ zIndex }) => zIndex > 0),
    ).toBe(true);
  });

  it("maps an offset clip between source media and its timeline start", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    const { container } = render(
      <ProgramMonitor
        proxyPath={null}
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        sourceLayers={[
          {
            clipId: "offset",
            path: "/cache/offset.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 100,
            sourceInFrame: 10,
            sourceOutFrame: 20,
            hidden: false,
            muted: false,
            hasAudio: true,
          },
        ]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={0}
        trimOut={200}
        playhead={102}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = container.querySelector<HTMLVideoElement>('[data-clip-id="offset"]')!;

    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBeCloseTo(12 / 25);
    onPlayheadChange.mockClear();
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    frameCallbacks.fireNext(13 / 25);

    expect(onPlayheadChange).toHaveBeenLastCalledWith(103);
  });

  it("activates the second half of a split at its timeline boundary", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    const { container } = render(
      <ProgramMonitor
        proxyPath={null}
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        sourceLayers={[
          {
            clipId: "split-left",
            path: "/cache/source.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 25,
            hidden: false,
            muted: false,
            hasAudio: true,
          },
          {
            clipId: "split-right",
            path: "/cache/source.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 25,
            sourceInFrame: 25,
            sourceOutFrame: 50,
            hidden: false,
            muted: false,
            hasAudio: true,
          },
        ]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={0}
        trimOut={50}
        playhead={25}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const left = container.querySelector<HTMLVideoElement>('[data-clip-id="split-left"]')!;
    const right = container.querySelector<HTMLVideoElement>('[data-clip-id="split-right"]')!;

    expect(left.dataset.active).toBe("false");
    expect(left.style.visibility).toBe("hidden");
    expect(right.dataset.active).toBe("true");
    expect(right.style.visibility).toBe("visible");
    fireEvent.loadedMetadata(right);
    expect(right.currentTime).toBeCloseTo(25 / 25);
    onPlayheadChange.mockClear();
    Object.defineProperty(right, "paused", { configurable: true, value: false });
    fireEvent.play(right);
    frameCallbacks.fireNext(26 / 25);

    expect(onPlayheadChange).toHaveBeenLastCalledWith(26);
  });

  it("uses the first visible active layer instead of a hidden first layer as the clock", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    const { container } = render(
      <ProgramMonitor
        proxyPath={null}
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        activeCaptions={[{ captionId: "visible-clock-cue", text: "Visible clock cue" }]}
        sourceLayers={[
          {
            clipId: "hidden-first",
            path: "/cache/hidden.mp4",
            canonicalTrackIndex: 0,
            timelineStartFrame: 0,
            sourceInFrame: 0,
            sourceOutFrame: 50,
            hidden: true,
            muted: false,
            hasAudio: true,
          },
          {
            clipId: "visible-second",
            path: "/cache/visible.mp4",
            canonicalTrackIndex: 1,
            timelineStartFrame: 40,
            sourceInFrame: 10,
            sourceOutFrame: 30,
            hidden: false,
            muted: false,
            hasAudio: true,
          },
        ]}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={0}
        trimOut={50}
        playhead={40}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const hidden = container.querySelector<HTMLVideoElement>('[data-clip-id="hidden-first"]')!;
    const visible = container.querySelector<HTMLVideoElement>('[data-clip-id="visible-second"]')!;

    fireEvent.play(hidden);
    expect(frameCallbacks.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Active captions").textContent).toContain("Visible clock cue");
    Object.defineProperty(visible, "paused", { configurable: true, value: false });
    fireEvent.play(visible);
    frameCallbacks.fireNext(11 / 25);

    expect(onPlayheadChange).toHaveBeenLastCalledWith(41);
  });

  it("enforces canonical source mute and uses rendered media state for final preview", () => {
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted
        timelineVideoHidden={false}
        convertCachePath={convertCachePath}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );

    const sourceVideo = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    expect(convertCachePath).toHaveBeenCalledWith("/cache/proxy.mp4");
    expect(sourceVideo.getAttribute("src")).toBe("asset:/cache/proxy.mp4");
    expect(sourceVideo.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Audio muted by timeline track" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Final" }));

    const finalVideo = screen.getByLabelText("Verified final video preview") as HTMLVideoElement;
    expect(convertCachePath).toHaveBeenCalledWith("/cache/final-preview.mp4");
    expect(finalVideo.getAttribute("src")).toBe("asset:/cache/final-preview.mp4");
    expect(finalVideo.muted).toBe(false);
    expect(screen.getByRole("button", { name: "Mute audio" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("Audio muted by timeline track")).toBeNull();

    finalVideo.muted = true;
    fireEvent.volumeChange(finalVideo);
    expect(finalVideo.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute audio" })).toHaveProperty("disabled", false);
    expect(convertCachePath).toHaveBeenCalledTimes(2);
  });

  it("keeps source visibility output-neutral once the rendered final preview is selected", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );

    const sourceVideo = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const sourceOverlay = screen.getByText("Video track hidden").parentElement!;
    expect(sourceOverlay.className).toBe("monitor-hidden-video");
    expect(sourceOverlay.parentElement?.contains(sourceVideo)).toBe(true);

    Object.defineProperty(sourceVideo, "paused", { configurable: true, value: false });
    fireEvent.play(sourceVideo);
    frameCallbacks.fireNext(10 / 25);
    expect(onPlayheadChange).toHaveBeenLastCalledWith(10);

    fireEvent.click(screen.getByRole("button", { name: "Final" }));

    const finalVideo = screen.getByLabelText("Verified final video preview") as HTMLVideoElement;
    expect(finalVideo).toBe(sourceVideo);
    expect(screen.queryByText("Video track hidden")).toBeNull();

    fireEvent.play(finalVideo);
    frameCallbacks.fireNext(12 / 25);
    expect(onPlayheadChange).toHaveBeenLastCalledWith(12);
  });

  it("keeps video visibility independent from audio mute and volume state", () => {
    const monitor = (timelineVideoHidden: boolean) => (
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={timelineVideoHidden}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />
    );
    const rendered = render(monitor(true));
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" });

    expect(video.muted).toBe(false);
    expect(screen.getByText("Video track hidden").parentElement!).toBeTruthy();
    fireEvent.change(volumeControl, { target: { value: "0.35" } });
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(true);
    expect(screen.getByText("Video track hidden").parentElement!).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unmute audio" }));
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);

    rendered.rerender(monitor(false));
    expect(screen.queryByText("Video track hidden")).toBeNull();
    expect(screen.getByLabelText("Prepared source proxy")).toBe(video);
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);
  });

  it("uses monotonic presented frames and stops at the exact half-open trim-out", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });

    fireEvent.play(video);
    expect(frameCallbacks.request).toHaveBeenCalledTimes(1);
    frameCallbacks.fireNext(10 / 25);
    frameCallbacks.fireNext(11 / 25);
    expect(onPlayheadChange.mock.calls.map(([frame]) => frame)).toEqual([10, 11]);

    video.currentTime = 20 / 25;
    fireEvent.timeUpdate(video);
    expect(onPlayheadChange).toHaveBeenCalledTimes(2);

    frameCallbacks.fireNext(90 / 25);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBeCloseTo(89 / 25);
    expect(onPlayheadChange.mock.calls.map(([frame]) => frame)).toEqual([10, 11, 89]);
    expect(frameCallbacks.request).toHaveBeenCalledTimes(3);
  });

  it("replaces an existing frame loop instead of starting a duplicate", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    const staleFrame = frameCallbacks.peekNext();

    fireEvent.play(video);
    expect(frameCallbacks.cancel).toHaveBeenCalledWith(staleFrame.id);
    expect(frameCallbacks.pendingCount()).toBe(1);
    act(() => {
      staleFrame.callback(0, { mediaTime: 11 / 25 } as VideoFrameCallbackMetadata);
    });
    expect(onPlayheadChange).not.toHaveBeenCalled();
    expect(frameCallbacks.pendingCount()).toBe(1);
  });

  it("cancels frame observation on pause and ignores the stale callback", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    const staleFrame = frameCallbacks.peekNext();

    fireEvent.pause(video);
    expect(frameCallbacks.cancel).toHaveBeenCalledWith(staleFrame.id);
    act(() => {
      staleFrame.callback(0, { mediaTime: 11 / 25 } as VideoFrameCallbackMetadata);
    });
    expect(onPlayheadChange).not.toHaveBeenCalled();
    expect(frameCallbacks.request).toHaveBeenCalledTimes(1);
  });

  it("cancels stale callbacks when the source or preview mode changes", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    const convertCachePath = (path: string) => `asset:${path}`;
    const { rerender } = render(
      <ProgramMonitor
        proxyPath="/cache/proxy-a.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={convertCachePath}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    const staleSourceFrame = frameCallbacks.peekNext();

    rerender(
      <ProgramMonitor
        proxyPath="/cache/proxy-b.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={convertCachePath}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    expect(frameCallbacks.cancel).toHaveBeenCalledWith(staleSourceFrame.id);
    act(() => {
      staleSourceFrame.callback(0, { mediaTime: 11 / 25 } as VideoFrameCallbackMetadata);
    });

    fireEvent.play(video);
    const staleModeFrame = frameCallbacks.peekNext();
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(frameCallbacks.cancel).toHaveBeenCalledWith(staleModeFrame.id);
    act(() => {
      staleModeFrame.callback(0, { mediaTime: 12 / 25 } as VideoFrameCallbackMetadata);
    });
    expect(onPlayheadChange).not.toHaveBeenCalled();
    expect(frameCallbacks.request).toHaveBeenCalledTimes(2);
  });

  it("cancels frame observation on unmount and ignores the stale callback", () => {
    const frameCallbacks = installVideoFrameCallbacks();
    const onPlayheadChange = vi.fn();
    const { unmount } = render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    const staleFrame = frameCallbacks.peekNext();

    unmount();
    expect(frameCallbacks.cancel).toHaveBeenCalledWith(staleFrame.id);
    act(() => {
      staleFrame.callback(0, { mediaTime: 11 / 25 } as VideoFrameCallbackMetadata);
    });
    expect(onPlayheadChange).not.toHaveBeenCalled();
    expect(frameCallbacks.request).toHaveBeenCalledTimes(1);
  });

  it("falls back to timeupdate when cancellable video frame callbacks are unavailable", () => {
    const requestVideoFrameCallback = vi.fn();
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
      configurable: true,
      value: requestVideoFrameCallback,
    });
    Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={0}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    video.currentTime = 0;
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(video.currentTime).toBeCloseTo(0.4);
    expect(video.play).toHaveBeenCalled();
    expect(requestVideoFrameCallback).not.toHaveBeenCalled();

    video.currentTime = 3.6;
    fireEvent.timeUpdate(video);
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(3.56);
    expect(onPlayheadChange).toHaveBeenCalledWith(89);
  });

  it("seeks one or five frames with keyboard shortcuts outside interactive controls", () => {
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={50}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    fireEvent.keyDown(window, { code: "ArrowRight", key: "ArrowRight" });
    fireEvent.keyDown(window, { code: "ArrowLeft", key: "ArrowLeft", shiftKey: true });
    expect(onPlayheadChange).toHaveBeenNthCalledWith(1, 51);
    expect(onPlayheadChange).toHaveBeenNthCalledWith(2, 46);

    const playButton = screen.getByRole("button", { name: "Play" });
    fireEvent.keyDown(playButton, { code: "ArrowRight", key: "ArrowRight" });
    expect(onPlayheadChange).toHaveBeenCalledTimes(2);
  });

  it("accumulates repeated frame steps and jumps before the parent rerenders", () => {
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={50}
        onPlayheadChange={onPlayheadChange}
      />,
    );

    fireEvent.keyDown(window, { code: "ArrowRight", key: "ArrowRight", repeat: true });
    fireEvent.keyDown(window, { code: "ArrowRight", key: "ArrowRight", repeat: true });
    fireEvent.keyDown(window, {
      code: "ArrowRight",
      key: "ArrowRight",
      shiftKey: true,
      repeat: true,
    });
    fireEvent.keyDown(window, {
      code: "ArrowRight",
      key: "ArrowRight",
      shiftKey: true,
      repeat: true,
    });

    expect(onPlayheadChange.mock.calls.map(([frame]) => frame)).toEqual([51, 52, 57, 62]);
    expect(
      (screen.getByLabelText("Prepared source proxy") as HTMLVideoElement).currentTime,
    ).toBeCloseTo(62 / 25);
  });

  it("toggles mute while preserving the current non-zero volume", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" });

    fireEvent.change(volumeControl, { target: { value: "0.35" } });
    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Unmute audio" }));
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);
  });

  it("enforces timeline track mute and restores the prior transport volume", () => {
    const { rerender } = render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;

    fireEvent.change(volumeControl, { target: { value: "0.35" } });
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);

    rerender(preparedProxyMonitor("/cache/proxy.mp4", true, true));

    const timelineMuteControl = screen.getByRole("button", {
      name: "Audio muted by timeline track",
    }) as HTMLButtonElement;
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(true);
    expect(timelineMuteControl.disabled).toBe(true);
    expect(volumeControl.disabled).toBe(true);
    expect(screen.getByText("Audio muted by timeline track").getAttribute("role")).toBe("status");

    fireEvent.click(timelineMuteControl);
    fireEvent.change(volumeControl, { target: { value: "0.8" } });
    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(true);

    rerender(preparedProxyMonitor());

    expect(video.volume).toBeCloseTo(0.35);
    expect(video.muted).toBe(false);
    expect(volumeControl.value).toBe("0.35");
    expect(volumeControl.disabled).toBe(false);
    expect(screen.queryByText("Audio muted by timeline track")).toBeNull();
  });

  it("restores a user-muted transport after timeline track mute clears", () => {
    const { rerender } = render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;

    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
      target: { value: "0.45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));
    expect(video.muted).toBe(true);

    rerender(preparedProxyMonitor("/cache/proxy.mp4", true, true));
    rerender(preparedProxyMonitor());

    expect(video.volume).toBeCloseTo(0.45);
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute audio" })).toBeTruthy();
  });

  it("updates media volume from the accessible range without seeking", () => {
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;

    fireEvent.change(volumeControl, { target: { value: "0.6" } });
    expect(video.volume).toBeCloseTo(0.6);
    expect(video.muted).toBe(false);
    expect(volumeControl.value).toBe("0.6");

    fireEvent.keyDown(volumeControl, { key: "ArrowLeft" });
    expect(onPlayheadChange).not.toHaveBeenCalled();
  });

  it("treats zero volume as muted and restores the last audible level", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" });

    fireEvent.change(volumeControl, { target: { value: "0.4" } });
    fireEvent.change(volumeControl, { target: { value: "0" } });
    expect(video.volume).toBe(0);
    expect(video.muted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Unmute audio" }));
    expect(video.volume).toBeCloseTo(0.4);
    expect(video.muted).toBe(false);
  });

  it("synchronizes controls from media volumechange events", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    const volumeControl = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;

    video.volume = 0.65;
    video.muted = true;
    fireEvent.volumeChange(video);

    expect(volumeControl.value).toBe("0.65");
    expect(screen.getByRole("button", { name: "Unmute audio" })).toBeTruthy();
  });

  it("persists audio settings when switching between source and final previews", () => {
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );
    const sourceVideo = screen.getByLabelText("Prepared source proxy") as HTMLVideoElement;
    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
      target: { value: "0.45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));

    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    const finalVideo = screen.getByLabelText("Verified final video preview") as HTMLVideoElement;
    fireEvent.loadedMetadata(finalVideo);
    expect(finalVideo).toBe(sourceVideo);
    expect(finalVideo.volume).toBeCloseTo(0.45);
    expect(finalVideo.muted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.loadedMetadata(screen.getByLabelText("Prepared source proxy"));
    expect((screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement).value).toBe("0.45");
    expect(screen.getByRole("button", { name: "Unmute audio" })).toBeTruthy();
  });

  it("hides audio controls when backend metadata reports no audio", () => {
    render(preparedProxyMonitor("/cache/silent-proxy.mp4", false));

    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
    expect(screen.queryByRole("button", { name: /mute audio/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("announces waiting and clears the status when playback resumes", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy");

    fireEvent.waiting(video);
    expect(
      screen.getByText("Buffering preview. Please wait.").parentElement?.getAttribute("role"),
    ).toBe("status");

    fireEvent.playing(video);
    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();
  });

  it("shows a stalled status and clears it when the media can play", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy");

    fireEvent.stalled(video);
    expect(screen.getByText("Buffering preview. Please wait.")).toBeTruthy();

    fireEvent.canPlay(video);
    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();
  });

  it("clears buffering when the controlled source changes", () => {
    const { rerender } = render(preparedProxyMonitor("/cache/proxy-a.mp4"));
    fireEvent.waiting(screen.getByLabelText("Prepared source proxy"));
    expect(screen.getByText("Buffering preview. Please wait.")).toBeTruthy();

    rerender(preparedProxyMonitor("/cache/proxy-b.mp4"));

    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();
    expect(screen.getByLabelText("Prepared source proxy").getAttribute("src")).toBe(
      "asset:/cache/proxy-b.mp4",
    );
  });

  it("clears stale buffering feedback on pause and deliberate seek", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy");

    fireEvent.waiting(video);
    fireEvent.pause(video);
    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();

    fireEvent.waiting(video);
    fireEvent.click(screen.getByRole("button", { name: "Step forward five frames" }));
    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();
  });

  it("gives fatal media errors precedence over recoverable buffering", () => {
    render(preparedProxyMonitor());
    const video = screen.getByLabelText("Prepared source proxy");

    fireEvent.waiting(video);
    fireEvent.error(video);

    expect(screen.queryByText("Buffering preview. Please wait.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Preview could not be loaded");
  });

  it("keeps exact controls available when media loading fails", () => {
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        timelineVideoHidden={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );
    fireEvent.error(screen.getByLabelText("Prepared source proxy"));
    expect(screen.getByRole("alert").textContent).toContain("Preview could not be loaded");
    expect(screen.getByRole("button", { name: "Try media again" })).toBeTruthy();
  });
});
