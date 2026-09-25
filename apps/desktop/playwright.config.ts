import { defineConfig } from "@playwright/test";
import { testPort } from "./test-port.mjs";

export const browserTestServer = {
  host: "127.0.0.1",
  port: testPort,
} as const;

export const browserTestBaseUrl = `http://${browserTestServer.host}:${browserTestServer.port}`;
export const browserTestServerCommand = `pnpm dev --host ${browserTestServer.host} --port ${browserTestServer.port} --strictPort`;

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
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
