import type { VideoToolStatus } from "@supa-video/contracts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import React from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import { CommandProvider, useCommandHandler } from "../src/commands/CommandProvider";
import { VideoProjectOpener, type ReadinessState } from "../src/video/VideoProjectOpener";

const longToolchainId = `ffmpeg-${"x".repeat(121)}`;

const readyStatus = {
  source: "bundled",
  toolchainId: longToolchainId,
  ffmpeg: { available: true, version: "8.1.2" },
  ffprobe: { available: true, version: "8.1.2" },
  ready: true,
} satisfies VideoToolStatus;

const failureStatus = {
  source: "bundled",
  toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
  ffmpeg: { available: false, problem: "integrity_failed" },
  ffprobe: { available: false, problem: "integrity_failed" },
  ready: false,
} satisfies VideoToolStatus;

const requestedState = new URLSearchParams(window.location.search).get("state");
const readiness: ReadinessState = {
  phase: "loaded",
  value: requestedState === "failure" ? failureStatus : readyStatus,
};

function ProjectCommandHandlers() {
  useCommandHandler("project.new", { canExecute: true, execute: () => undefined });
  useCommandHandler("project.open", { canExecute: true, execute: () => undefined });
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CommandProvider>
      <ProjectCommandHandlers />
      <VideoProjectOpener
        readiness={readiness}
        projectPending={false}
        projectError={null}
        onCheckTools={() => undefined}
      />
    </CommandProvider>
  </React.StrictMode>,
);
