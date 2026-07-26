// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { ExportPanel } from "./ExportPanel";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const ready = {
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

async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
  });
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

function configureReadyEditor(): void {
  invokeMock.mockImplementation(async (command) => {
    if (command === "video_ffmpeg_status") return ready;
    if (command === "video_pick_new_project_path") return "C:\\Neutral\\project.svpvideo";
    if (command === "video_save_project") return null;
    if (command === "video_pick_source") return "C:\\Neutral\\clip.mp4";
    if (command === "video_probe_media") return probe;
    if (command === "video_prepare_asset") {
      return {
        proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
        thumbnailPath: "C:\\Neutral\\Cache\\thumb.jpg",
        proxyProbe: { ...probe, width: 540, height: 720, fileSizeBytes: 4_000_000 },
      };
    }
    if (command === "video_open_project") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
}

afterEach(cleanup);

describe("automated accessibility defect scanning", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
  });

  it("reports zero applicable violations in the project opener", async () => {
    invokeMock.mockResolvedValueOnce(ready);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    await expectNoAxeViolations(container);
  });

  it("reports zero applicable violations in the ready editor", async () => {
    configureReadyEditor();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Prepared proxy" });
    await expectNoAxeViolations(container);
  });

  it("reports zero applicable violations for a blocking project error", async () => {
    invokeMock.mockResolvedValueOnce(ready).mockResolvedValueOnce({ privateDiagnostic: "private" });
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("alert");
    await expectNoAxeViolations(container);
  });

  it("reports zero applicable violations for running export and open overwrite dialog states", async () => {
    const baseProps = {
      destinationPending: false,
      destinationError: null,
      disabled: false,
      onExport: vi.fn(),
      onCancel: vi.fn(),
      onConfirmOverwrite: vi.fn(),
    } as const;
    const identity = {
      jobId: "50000000-0000-4000-8000-000000000001",
      planId: "50000000-0000-4000-8000-000000000002",
      revisionId: "50000000-0000-4000-8000-000000000003",
      outputPath: "C:\\Neutral\\output.mp4",
    } as const;
    const { container, rerender } = render(
      <main>
        <ExportPanel
          {...baseProps}
          render={{
            phase: "running",
            ...identity,
            progress: 42,
            cancellationPending: false,
            cancellationError: null,
          }}
        />
      </main>,
    );
    await expectNoAxeViolations(container);

    rerender(
      <main>
        <ExportPanel
          {...baseProps}
          render={{
            phase: "failed",
            ...identity,
            jobId: null,
            error: new Error("collision"),
            canOverwrite: true,
          }}
        />
      </main>,
    );
    await screen.findByRole("dialog", { name: "Replace the existing file?" });
    await expectNoAxeViolations(container);
  });
});
