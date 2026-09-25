import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "**/ProgramMonitorAudio.spec.ts",
  workers: 1,
  reporter: [
    ["line"],
    [
      "json",
      { outputFile: "../../evidence/2026-09-14-p2-editor-controls/browser-audio-results.json" },
    ],
  ],
  outputDir: "../../test-results/program-monitor-audio",
});
