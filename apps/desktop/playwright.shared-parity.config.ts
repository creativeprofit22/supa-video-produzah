import { defineConfig } from "@playwright/test";
import config from "./playwright.speed.config";
export default defineConfig({
  ...config,
  testMatch: "**/ProgramMonitorSharedParity.spec.ts",
  workers: 1,
  outputDir: "../../evidence/2026-09-14-p2-speed/shared-browser-results",
  use: { ...config.use, baseURL: "http://127.0.0.1:4177", trace: "on" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4177 --strictPort",
    url: "http://127.0.0.1:4177",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
