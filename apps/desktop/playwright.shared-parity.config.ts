import { defineConfig } from "@playwright/test";
import config from "./playwright.speed.config";
export default defineConfig({
  ...config,
  testMatch: "**/ProgramMonitorSharedParity.spec.ts",
  workers: 1,
  outputDir: "../../evidence/2026-09-14-p2-speed/shared-browser-results",
  use: { ...config.use, trace: "on" },
});
