import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "**/PreviewAudio.spec.ts",
  use: { ...config.use, baseURL: "http://127.0.0.1:4186" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4186 --strictPort",
    url: "http://127.0.0.1:4186",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
