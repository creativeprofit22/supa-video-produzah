import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import assert from "node:assert/strict";
import console from "node:console";
import { distribution } from "./metrics.mjs";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = require("@playwright/test");
let server, browser;
try {
  server = await preview({
    configFile: fileURLToPath(new URL("./vite.profile.config.mjs", import.meta.url)),
    mode: "profile-validation",
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string" && address.address === "127.0.0.1");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/browser-tests/video-workspace.html`);
  await page.getByRole("button", { name: "Initialize workspace fixture" }).click();
  await page.waitForFunction(() =>
    ["VideoWorkspace", "MultitrackTimeline"].every((id) =>
      globalThis.__p2Commits?.samples.some((s) => s.id === id),
    ),
  );
  const initial = await page.evaluate(() => globalThis.__p2Commits.samples.length);
  await page.getByRole("button", { name: "Split fixture into two clips" }).click();
  await page.waitForFunction((count) => globalThis.__p2Commits.samples.length > count, initial);
  const buffer = await page.evaluate(() => globalThis.__p2Commits);
  assert.equal(buffer.omitted, 0);
  for (const id of ["VideoWorkspace", "MultitrackTimeline"]) {
    const values = buffer.samples.filter((s) => s.id === id);
    assert.ok(values.some((s) => s.phase === "mount"));
    assert.ok(values.some((s) => s.phase !== "mount"));
    assert.ok(values.every((s) => Number.isFinite(s.actualDuration)));
    console.log(
      JSON.stringify({
        id,
        commits: values.length,
        durationsMs: distribution(values.map((s) => s.actualDuration)),
        scope:
          "production profiling callback validation in browser mock-IPC fixture, not native playback or stress measurement",
      }),
    );
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
}
