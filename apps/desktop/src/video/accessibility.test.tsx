// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { createMockVideoService } from "../test-video-service";
import { ExportPanel } from "./ExportPanel";

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
async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
  });
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}
afterEach(cleanup);

describe("Phase 2 accessibility defect scanning", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(vi.fn());
  });

  it("reports zero violations in the opener", async () => {
    invokeMock.mockImplementation(createMockVideoService().invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    await expectNoAxeViolations(container);
  });

  it("reports zero violations in the ready editor and inspector", async () => {
    invokeMock.mockImplementation(createMockVideoService().invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Canonical composition" });
    fireEvent.click(screen.getByRole("button", { name: "Toggle project inspector" }));
    await screen.findByRole("heading", { name: "Project inspector" });
    await expectNoAxeViolations(container);
  });

  it("reports zero violations for a pending snapshot checkpoint warning", async () => {
    invokeMock.mockImplementation(
      createMockVideoService({ checkpointWarningRevisions: [1] }).invoke,
    );
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByText("Revision 1 is saved. Checkpoint pending.");
    await expectNoAxeViolations(container);
  });

  it("reports zero violations for degraded recovery", async () => {
    invokeMock.mockImplementation(createMockVideoService({ recoveryStatus: "degraded" }).invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("alert");
    await expectNoAxeViolations(container);
  });

  it("reports zero violations for running export and overwrite dialog", async () => {
    const base = {
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
    const identity = {
      jobId: "50000000-0000-4000-8000-000000000001",
      planId: "50000000-0000-4000-8000-000000000002",
      revisionId: "50000000-0000-4000-8000-000000000003",
      outputPath: "C:\\Neutral\\output.mp4",
    } as const;
    const { container, rerender } = render(
      <main>
        <ExportPanel
          {...base}
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
          {...base}
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
