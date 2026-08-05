// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProgramMonitor } from "./ProgramMonitor";

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

  it("enforces canonical source mute and uses rendered media state for final preview", () => {
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        hasAudio
        timelineAudioMuted
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

  it("keeps a black visibility overlay over mounted, clocking media in source and final modes", () => {
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
    const finalOverlay = screen.getByText("Video track hidden").parentElement!;
    expect(finalVideo).toBe(sourceVideo);
    expect(finalOverlay.className).toBe("monitor-hidden-video");
    expect(finalOverlay.parentElement?.contains(finalVideo)).toBe(true);

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

  it("seeks one or ten frames with keyboard shortcuts outside editable controls", () => {
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
        hasAudio
        timelineAudioMuted={false}
        convertCachePath={(path) => `asset:${path}`}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={50}
        onPlayheadChange={onPlayheadChange}
      />,
    );
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    expect(onPlayheadChange).toHaveBeenNthCalledWith(1, 51);
    expect(onPlayheadChange).toHaveBeenNthCalledWith(2, 40);

    const playButton = screen.getByRole("button", { name: "Play" });
    fireEvent.keyDown(playButton, { key: "ArrowRight" });
    expect(onPlayheadChange).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByRole("button", { name: "Seek forward ten frames" }));
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
