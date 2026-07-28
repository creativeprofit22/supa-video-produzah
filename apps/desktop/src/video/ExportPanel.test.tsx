// @vitest-environment jsdom

import type { MediaJobRecord } from "@supa-video/media";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testMediaJob } from "../test-video-service";
import { ExportPanel } from "./ExportPanel";

const identity = {
  jobId: "30000000-0000-4000-8000-000000000001",
  planId: "30000000-0000-4000-8000-000000000002",
  revisionId: "30000000-0000-4000-8000-000000000003",
};

function baseProps() {
  return {
    readiness: {
      phase: "loaded" as const,
      value: {
        source: "bundled" as const,
        toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
        ffmpeg: { available: true, version: "8.1.2" },
        ffprobe: { available: true, version: "8.1.2" },
        ready: true,
      },
    },
    renderJob: null,
    destinationPending: false,
    destinationError: null,
    disabled: false,
    onExport: vi.fn(),
    onCancel: vi.fn(),
    onConfirmOverwrite: vi.fn(),
    onOpenJobCenter: vi.fn(),
  } as const;
}

afterEach(cleanup);

describe("ExportPanel", () => {
  it("opens a native overwrite dialog with initial focus and returns focus on cancel", async () => {
    const props = baseProps();
    render(
      <ExportPanel
        {...props}
        render={{
          phase: "failed",
          ...identity,
          outputPath: "C:\\Neutral\\output.mp4",
          error: new Error("collision"),
          canOverwrite: true,
        }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Replace the existing file?" });
    const cancel = screen.getByRole("button", { name: "Keep existing file" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(dialog.hasAttribute("open")).toBe(true);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export MP4" }));
    expect(props.onConfirmOverwrite).not.toHaveBeenCalled();
  });

  it("confirms replacement only through the dialog action", () => {
    const props = baseProps();
    render(
      <ExportPanel
        {...props}
        render={{
          phase: "failed",
          ...identity,
          outputPath: "C:\\Neutral\\output.mp4",
          error: new Error("collision"),
          canOverwrite: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace existing file" }));
    expect(props.onConfirmOverwrite).toHaveBeenCalledTimes(1);
  });

  it("uses the durable retry lifecycle instead of compatibility progress", () => {
    const onOpenJobCenter = vi.fn();
    const retryingJob = {
      ...testMediaJob,
      id: identity.jobId,
      kind: "final_render",
      projectId: null,
      assetId: null,
      revisionId: identity.revisionId,
      priority: "export",
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
      attempt: 1,
    } as MediaJobRecord;
    render(
      <ExportPanel
        {...baseProps()}
        renderJob={retryingJob}
        onOpenJobCenter={onOpenJobCenter}
        render={{
          phase: "running",
          ...identity,
          outputPath: "C:\\Neutral\\output.mp4",
          progress: 42,
          cancellationPending: false,
          cancellationError: null,
        }}
      />,
    );

    expect(screen.getByText("Final export: Retry scheduled")).toBeTruthy();
    expect(screen.queryByText("Exporting video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open final export in Job Center" }));
    expect(onOpenJobCenter).toHaveBeenCalledWith(identity.jobId);
  });

  it("reports verified output facts and the display-only destination", () => {
    render(
      <ExportPanel
        {...baseProps()}
        render={{
          phase: "completed",
          ...identity,
          output: {
            outputPath: "C:\\Neutral\\Exports\\final.mp4",
            previewPath: "C:\\Neutral\\Cache\\preview.mp4",
            probe: {
              durationMicroseconds: 1_500_000,
              averageFrameRate: { numerator: 30, denominator: 1 },
              realFrameRate: { numerator: 30, denominator: 1 },
              variableFrameRate: false,
              width: 320,
              height: 180,
              videoCodecName: "h264",
              audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
              fileSizeBytes: 200_000,
            },
          },
        }}
      />,
    );
    expect(screen.getByText("Export complete")).toBeTruthy();
    expect(screen.getByText("0:02")).toBeTruthy();
    expect(screen.getByText("320 × 180")).toBeTruthy();
    expect(screen.getByText("H264")).toBeTruthy();
    expect(screen.getByText("AAC")).toBeTruthy();
    expect(screen.getByText("C:\\Neutral\\Exports\\final.mp4")).toBeTruthy();
  });
});
