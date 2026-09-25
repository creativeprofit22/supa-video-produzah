import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "**/MultilayerCompletion.spec.ts",
  outputDir: "../../test-results/multilayer-completion",
});
