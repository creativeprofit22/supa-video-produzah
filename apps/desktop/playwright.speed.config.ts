import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Isolated port allows this focused UI suite to run beside preview verification.
export default defineConfig({
  ...config,
  testMatch: "**/ClipSpeedControl.spec.ts",
  use: { ...config.use, baseURL: "http://127.0.0.1:4175" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
