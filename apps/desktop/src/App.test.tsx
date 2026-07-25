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
const preparedAsset = {
  proxyPath: "C:\\Private\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Private\\Cache\\thumbnail.jpg",
  proxyProbe: { ...mediaProbe, width: 1_280, height: 720, fileSizeBytes: 5_000_000 },
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
});
