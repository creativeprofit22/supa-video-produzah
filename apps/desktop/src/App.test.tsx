// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
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

afterEach(cleanup);

describe("App media readiness flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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

  it("probes a selected source and renders validated media without its path", async () => {
    invokeMock
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce("C:\\Private\\clip.mp4")
      .mockResolvedValueOnce(mediaProbe);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose video" }));

    await screen.findByRole("heading", { name: "Selected video" });
    expect(screen.getByText("1920 × 1080")).toBeTruthy();
    expect(screen.queryByText(/Private/)).toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith("video_probe_media", {
      path: "C:\\Private\\clip.mp4",
    });
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
  });
});
