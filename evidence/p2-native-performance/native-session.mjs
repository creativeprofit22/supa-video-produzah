import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { launchOwned } from "./owned-run.mjs";
import { assertOwnedTarget } from "./ownership.mjs";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const base = fileURLToPath(new URL("./", import.meta.url));
export async function nativeSession({
  launcherReceipt,
  executable,
  executableSha256,
  leaseMs = 120000,
}) {
  const runs = realpathSync(path.join(base, "runs")),
    exe = realpathSync(executable);
  const relative = path.relative(runs, exe);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Executable not isolated");
  const hashExe = () => createHash("sha256").update(readFileSync(exe)).digest("hex");
  if (hashExe() !== executableSha256) throw new Error("Release executable identity mismatch");
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const run = mkdtempSync(path.join(runs, "native-")),
    profile = path.join(run, "webview");
  mkdirSync(profile);
  const env = {
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  };
  const owned = await launchOwned(launcherReceipt, exe, [], { leaseMs, env });
  let browser;
  try {
    let observed;
    const deadline = Date.now() + 25000;
    while (!observed && Date.now() < deadline) {
      try {
        observed = JSON.parse(
          execFileSync(
            "powershell",
            [
              "-NoProfile",
              "-File",
              path.join(base, "inspect-owned.ps1"),
              "-OwnedPid",
              String(owned.identity.pid),
              "-Creation",
              owned.identity.creation,
              "-Port",
              String(port),
            ],
            { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
          ),
        );
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(200);
      }
    }
    if (!observed) throw new Error("Owned CDP readiness unavailable");
    const expected = {
      isolatedRoot: runs,
      executable: exe,
      pid: owned.identity.pid,
      creationUtc: observed.creationUtc,
      port,
    };
    // Validate OS ownership before sending any CDP request. Page URL is checked after attach.
    assertOwnedTarget(expected, { ...observed, pageUrl: "http://tauri.localhost/" });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Owned WebView context absent");
    const page = context.pages()[0] || (await context.waitForEvent("page", { timeout: 10000 }));
    await page.waitForURL(/^https?:\/\/tauri\.localhost\/$/, { timeout: 10000 });
    assertOwnedTarget(expected, { ...observed, pageUrl: page.url() });
    return {
      page,
      run,
      owned,
      observed,
      env,
      async close() {
        let cleanup;
        try {
          await browser.close();
        } finally {
          cleanup = await owned.close();
        }
        if (hashExe() !== executableSha256) throw new Error("Executable changed during run");
        return cleanup;
      },
    };
  } catch (error) {
    const failure = {
      utc: new Date().toISOString(),
      error: String(error),
      identity: owned.identity,
      env,
      pages: browser?.contexts().flatMap((c) => c.pages().map((p) => p.url())) ?? [],
    };
    try {
      await browser?.close();
    } finally {
      failure.cleanup = await owned.close();
      writeFileSync(
        path.join(run, "session-failure.json"),
        `${JSON.stringify(failure, null, 2)}\n`,
        { flag: "wx" },
      );
    }
    throw new Error(`${error}; pages=${JSON.stringify(failure.pages)}; receipt=${run}`, {
      cause: error,
    });
  }
}
