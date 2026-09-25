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

import { parseTestPort } from "./test-port.mjs";
import speedConfig from "./playwright.speed.config";
import parityConfig from "./playwright.shared-parity.config";
import audioConfig from "./playwright.program-monitor-audio.config";
import previewAudioConfig from "./playwright.preview-audio.config";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const spawnedProcesses = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of spawnedProcesses) {
    child.kill();
  }
  spawnedProcesses.clear();
});

describe("test port validation", () => {
  test("defaults only when the override is absent", () => {
    expect(parseTestPort(undefined)).toBe(4173);
  });
  test.each(["1024", "4183", "65535", "04183"])("accepts decimal port %s", (value) => {
    expect(parseTestPort(value)).toBe(Number(value));
  });
  test.each([
    "",
    " ",
    "4183 ",
    " 4183",
    "1023",
    "65536",
    "-4183",
    "+4183",
    "4183.0",
    "4e3",
    "0x1057",
    "localhost:4183",
    "4183 --host 0.0.0.0",
    "4183;echo bad",
    "4183\n",
    "999999999999999999999",
  ])("rejects invalid override %j", (value) => {
    expect(() => parseTestPort(value)).toThrow("SUPA_VIDEO_TEST_PORT");
  });
});

describe("Playwright server isolation", () => {
  test("uses a dedicated strict-port Vite server that cannot be reused", () => {
    expect(browserTestServer.host).toBe("127.0.0.1");
    expect(browserTestServer.port).toBe(parseTestPort(process.env.SUPA_VIDEO_TEST_PORT));
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

  test.each([speedConfig, parityConfig, audioConfig, previewAudioConfig])(
    "dedicated suites inherit the selected local strict-port server",
    (config) => {
      expect(config.use?.baseURL).toBe(browserTestBaseUrl);
      expect(config.webServer).toEqual(playwrightConfig.webServer);
    },
  );

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
