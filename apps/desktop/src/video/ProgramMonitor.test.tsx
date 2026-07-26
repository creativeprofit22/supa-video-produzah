// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProgramMonitor } from "./ProgramMonitor";

const rate = { numerator: 25, denominator: 1 } as const;

describe("ProgramMonitor", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("converts only controlled cache paths and switches to the verified final preview", () => {
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath="/cache/final-preview.mp4"
        convertCachePath={convertCachePath}
        rate={rate}
        trimIn={10}
        trimOut={90}
        playhead={10}
        onPlayheadChange={vi.fn()}
      />,
    );

    expect(convertCachePath).toHaveBeenCalledWith("/cache/proxy.mp4");
    expect(screen.getByLabelText("Prepared source proxy").getAttribute("src")).toBe(
      "asset:/cache/proxy.mp4",
    );
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(convertCachePath).toHaveBeenCalledWith("/cache/final-preview.mp4");
    expect(screen.getByLabelText("Verified final video preview").getAttribute("src")).toBe(
      "asset:/cache/final-preview.mp4",
    );
    expect(convertCachePath).toHaveBeenCalledTimes(2);
  });

  it("starts inside trim-in and pauses one frame before trim-out", async () => {
    const onPlayheadChange = vi.fn();
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
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

  it("keeps exact controls available when media loading fails", () => {
    render(
      <ProgramMonitor
        proxyPath="/cache/proxy.mp4"
        finalPreviewPath={null}
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
