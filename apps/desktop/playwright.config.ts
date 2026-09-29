import { defineConfig } from "@playwright/test";
import { testPort } from "./test-port.mjs";

export const browserTestServer = {
  host: "127.0.0.1",
  port: testPort,
} as const;

export const browserTestBaseUrl = `http://${browserTestServer.host}:${browserTestServer.port}`;
export const browserTestServerCommand = `pnpm dev --host ${browserTestServer.host} --port ${browserTestServer.port} --strictPort`;

/**
 * Specs that measure live audio/video timing or PCM level. They share one
 * audio output device and are sensitive to CPU contention, so they run in a
 * serial project instead of alongside the parallel UI specs.
 */
export const liveTimingSpecs = [
  "**/ProgramMonitorSharedParity.spec.ts",
  "**/RawMediaParity.spec.ts",
  "**/ProgramMonitorSpeed.spec.ts",
  "**/ProgramMonitorAudio.spec.ts",
] as const;

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  projects: [
    {
      name: "parallel",
      testIgnore: [...liveTimingSpecs],
    },
    {
      name: "live-timing",
      testMatch: [...liveTimingSpecs],
      fullyParallel: false,
      workers: 1,
      // Headless Chromium caps requestVideoFrameCallback at ~30/s, so at 1.5x about a third of
      // presented frames are never observed. Lifting the cap makes callbacks match presentations.
      use: { launchOptions: { args: ["--disable-frame-rate-limit"] } },
    },
  ],
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  outputDir: "../../test-results/desktop-browser",
  use: {
    baseURL: browserTestBaseUrl,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: browserTestServerCommand,
    url: browserTestBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
