import { defineConfig } from "@playwright/test";
import config from "./playwright.shared-parity.config";
export default defineConfig({
  ...config,
  testMatch: "**/RawMediaParity.spec.ts",
  outputDir: "../../evidence/2026-09-14-p2-speed/raw-browser-control",
});
