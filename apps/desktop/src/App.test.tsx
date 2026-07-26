// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { createMockVideoService } from "./test-video-service";

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

afterEach(cleanup);
describe("App Phase 2 canonical workspace", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(vi.fn());
  });

  it("shows tool loading and the Phase 2 label", async () => {
    let resolve!: (value: unknown) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "Checking FFmpeg and FFprobe" })).toBeTruthy();
    expect(screen.getByText("Phase 2 · Canonical history")).toBeTruthy();
    resolve({
      ffmpeg: { available: true, version: "ffmpeg" },
      ffprobe: { available: true, version: "ffprobe" },
      ready: true,
    });
    expect(await screen.findByRole("heading", { name: "Ready for video work" })).toBeTruthy();
  });

  it("creates and imports through the canonical service", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(await screen.findByRole("heading", { name: "Project media" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    expect(await screen.findByRole("heading", { name: "Prepared proxy" })).toBeTruthy();
    expect(invokeMock.mock.calls.some(([command]) => command === "video_save_project")).toBe(false);
    const execute = invokeMock.mock.calls.find(
      ([command]) => command === "video_execute_project_group",
    )?.[1] as { request: { commands: Array<{ type: string }> } };
    expect(execute.request.commands.map(({ type }) => type)).toEqual([
      "ImportAsset",
      "CreateSequence",
      "InsertClip",
    ]);
  });

  it("toggles the in-flow inspector, wraps diagnostics, and returns focus", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const workspace = await screen.findByRole("main");
    workspace.focus();
    const toggle = screen.getByRole("button", { name: "Toggle project inspector" });
    fireEvent.click(toggle);
    expect(await screen.findByRole("heading", { name: "Project inspector" })).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(screen.queryByRole("heading", { name: "Project inspector" })).toBeNull();
  });

  it("suppresses the inspector shortcut while a form control owns focus", async () => {
    const service = createMockVideoService();
    invokeMock.mockImplementation(service.invoke);
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await screen.findByRole("heading", { name: "Project media" });
    fireEvent.click(screen.getByRole("button", { name: "Choose video" }));
    await screen.findByRole("heading", { name: "Prepared proxy" });
    const input = screen.getByRole("spinbutton", { name: "Trim in" });
    input.focus();
    fireEvent.keyDown(input, { code: "KeyD", ctrlKey: true, altKey: true });
    expect(screen.queryByRole("heading", { name: "Project inspector" })).toBeNull();
  });

  it("shows irreversible V1 history reset outside the inspector", async () => {
    const service = createMockVideoService({
      recovery: {
        status: "migrated_v1",
        message: "Current V1 state migrated; legacy history was reset.",
        legacyHistoryReset: true,
      },
    });
    invokeMock.mockImplementation(service.invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Legacy undo history was permanently reset");
    expect(alert.textContent).toContain("cannot be undone");
    fireEvent.click(screen.getByRole("button", { name: "Toggle project inspector" }));
    expect(await screen.findByText("Reset permanently")).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("shows recovered tail details in the inspector", async () => {
    const service = createMockVideoService({
      recovery: {
        status: "recovered",
        recoveredRevision: 12,
        replayedRecordCount: 4,
        discardedTailBytes: 32,
        message: "Project recovered from durable journal data.",
      },
    });
    invokeMock.mockImplementation(service.invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project inspector" }));
    expect(await screen.findByText("32 bytes")).toBeTruthy();
    expect(screen.getByText("Project recovered from durable journal data.")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("shows recreated-journal details in the inspector", async () => {
    const service = createMockVideoService({
      recovery: {
        status: "journal_recreated",
        message: "Recovery journal recreated from the validated snapshot.",
      },
    });
    invokeMock.mockImplementation(service.invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project inspector" }));
    expect(await screen.findByText("journal recreated")).toBeTruthy();
    expect(
      screen.getByText("Recovery journal recreated from the validated snapshot."),
    ).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("keeps degraded recovery visible outside the hidden inspector", async () => {
    const service = createMockVideoService({ recoveryStatus: "degraded" });
    invokeMock.mockImplementation(service.invoke);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Ready for video work" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("possible lost edits");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
