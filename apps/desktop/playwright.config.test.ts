import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import playwrightConfig, {
  browserTestBaseUrl,
  browserTestServer,
  browserTestServerCommand,
} from "./playwright.config";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const spawnedProcesses = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of spawnedProcesses) {
    child.kill();
  }
  spawnedProcesses.clear();
});

describe("Playwright server isolation", () => {
  test("uses a dedicated strict-port Vite server that cannot be reused", () => {
    expect(browserTestServer.port).not.toBe(1420);
    expect(browserTestServerCommand).toBe(
      `pnpm dev --host ${browserTestServer.host} --port ${browserTestServer.port} --strictPort`,
    );
    expect(playwrightConfig.use?.baseURL).toBe(browserTestBaseUrl);
    expect(playwrightConfig.webServer).toMatchObject({
      command: browserTestServerCommand,
      url: browserTestBaseUrl,
      reuseExistingServer: false,
    });
  });

  test("fails when the dedicated browser-test port is occupied", async () => {
    const occupyingServer = createServer((_request, response) => {
      response.end("occupied by the isolation regression test");
    });

    await new Promise<void>((resolve, reject) => {
      occupyingServer.once("error", reject);
      occupyingServer.listen(browserTestServer.port, browserTestServer.host, resolve);
    });

    try {
      const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const child = spawn(
        pnpmExecutable,
        [
          "dev",
          "--host",
          browserTestServer.host,
          "--port",
          String(browserTestServer.port),
          "--strictPort",
        ],
        {
          cwd: desktopRoot,
          env: { ...process.env, NO_COLOR: "1" },
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedProcesses.add(child);

      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      spawnedProcesses.delete(child);

      expect(exitCode).not.toBe(0);
      expect(output).toContain(`Port ${browserTestServer.port} is already in use`);
      expect(output).not.toContain("Local:");
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupyingServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 15_000);
});
