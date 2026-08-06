// @vitest-environment jsdom

import type { VideoToolProblem, VideoToolStatus } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandProvider, useCommandHandler } from "../commands/CommandProvider";
import { VideoProjectOpener, type ReadinessState } from "./VideoProjectOpener";

const toolchainId = "ffmpeg-8.1.2-gyan-essentials-windows-x86_64";

function status(problem?: VideoToolProblem, identity = toolchainId): VideoToolStatus {
  if (problem !== undefined) {
    return {
      source: "bundled",
      toolchainId: identity,
      ffmpeg: { available: false, problem },
      ffprobe: { available: false, problem },
      ready: false,
    };
  }
  return {
    source: "bundled",
    toolchainId: identity,
    ffmpeg: { available: true, version: "8.1.2" },
    ffprobe: { available: true, version: "8.1.2" },
    ready: true,
  };
}

function ProjectCommandHandlers() {
  useCommandHandler("project.new", { canExecute: true, execute: () => undefined });
  useCommandHandler("project.open", { canExecute: true, execute: () => undefined });
  return null;
}

function opener(readiness: ReadinessState, onCheckTools: () => void) {
  return (
    <CommandProvider>
      <ProjectCommandHandlers />
      <VideoProjectOpener
        readiness={readiness}
        projectPending={false}
        projectError={null}
        onCheckTools={onCheckTools}
      />
    </CommandProvider>
  );
}

function renderOpener(readiness: ReadinessState, onCheckTools = vi.fn()) {
  return {
    onCheckTools,
    ...render(opener(readiness, onCheckTools)),
  };
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
  });
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

afterEach(() => {
  cleanup();
});

describe("VideoProjectOpener bundled media-tool states", () => {
  it("keeps projects available while bundled tools load", () => {
    renderOpener({ phase: "loading" });
    expect(screen.getByRole("heading", { name: "Checking bundled media tools" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "New project" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Open project" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows only the short version and stable bundled identity when ready", async () => {
    const { container } = renderOpener({ phase: "loaded", value: status() });
    expect(screen.getByRole("heading", { name: "Ready for video work" })).toBeTruthy();
    expect(screen.getAllByText("8.1.2")).toHaveLength(2);
    expect(screen.getByText(toolchainId)).toBeTruthy();
    expect(container.textContent).not.toContain("C:\\");
    expect(container.textContent).not.toContain("--enable-");
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    await expectNoAxeViolations(container);
  });

  it.each([
    {
      name: "FFmpeg-only incompatible",
      value: {
        source: "bundled",
        toolchainId,
        ffmpeg: { available: false, problem: "incompatible_build" },
        ffprobe: { available: true, version: "8.1.2" },
        ready: false,
      } satisfies VideoToolStatus,
      heading: "FFmpeg is incompatible",
      ffmpegDetail: "FFmpeg is incompatible with this application",
      ffprobeDetail: "8.1.2",
    },
    {
      name: "FFprobe-only missing",
      value: {
        source: "bundled",
        toolchainId,
        ffmpeg: { available: true, version: "8.1.2" },
        ffprobe: { available: false, problem: "not_found" },
        ready: false,
      } satisfies VideoToolStatus,
      heading: "FFprobe is missing",
      ffmpegDetail: "8.1.2",
      ffprobeDetail: "FFprobe is missing from the application",
    },
  ])(
    "renders independent $name results",
    async ({ value, heading, ffmpegDetail, ffprobeDetail }) => {
      const { container } = renderOpener({ phase: "loaded", value });
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
      const ffmpegResult = screen.getByText("FFmpeg").parentElement;
      const ffprobeResult = screen.getByText("FFprobe").parentElement;
      expect(ffmpegResult?.textContent).toContain(
        value.ffmpeg.available ? "Available" : "Unavailable",
      );
      expect(ffmpegResult?.textContent).toContain(ffmpegDetail);
      expect(ffprobeResult?.textContent).toContain(
        value.ffprobe.available ? "Available" : "Unavailable",
      );
      expect(ffprobeResult?.textContent).toContain(ffprobeDetail);
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      await expectNoAxeViolations(container);
    },
  );

  it.each([
    ["not_found", "Bundled media tools are missing", "missing from the application"],
    ["integrity_failed", "Bundled media tools are damaged", "is damaged"],
    ["incompatible_build", "Bundled media tools are incompatible", "is incompatible"],
    ["invalid_version", "Bundled media tools are incompatible", "was not recognized"],
    ["timed_out", "Media tool check timed out", "verification timed out"],
    ["failed", "Could not verify bundled media tools", "could not be verified"],
  ] as const)("renders the %s repair state with one retry", async (problem, heading, detail) => {
    const onCheckTools = vi.fn();
    const { container } = renderOpener({ phase: "loaded", value: status(problem) }, onCheckTools);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getAllByText(new RegExp(detail, "i"))).toHaveLength(2);
    expect(container.textContent).toContain("Repair or reinstall the application");
    const buttons = screen.getAllByRole("button").map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["New project", "Open project", "Check again"]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheckTools).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });

  it("replaces the retry control after a status request recovers", () => {
    const onCheckTools = vi.fn();
    const { rerender } = renderOpener({ phase: "error" }, onCheckTools);
    const retry = screen.getByRole("button", { name: "Check again" });
    expect(
      screen.getByRole("heading", { name: "Could not check the bundled media tools" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "New project",
      "Open project",
      "Check again",
    ]);
    retry.focus();
    expect(document.activeElement).toBe(retry);
    rerender(opener({ phase: "loaded", value: status() }, onCheckTools));
    expect(document.activeElement).not.toBe(retry);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});
