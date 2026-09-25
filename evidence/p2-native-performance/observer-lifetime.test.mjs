import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { installObserver } from "./browser-observer.mjs";
const { chromium } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))(
  "@playwright/test",
);
test("observer releases detached nodes and tracks more than 32 lifetime videos", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver, { cap: 1000, leaseMs: 10000 });
    for (let i = 0; i < 40; i++)
      await page.evaluate(() => {
        globalThis.document.body.replaceChildren(globalThis.document.createElement("video"));
      });
    const result = await page.evaluate(() => globalThis.__p2Observer.snapshot());
    assert.equal(result.videoTrackingCapReached, false);
    assert.equal(result.videosObserved, 40);
    assert.equal(result.videos.length, 1);
    assert.equal(result.events.filter((e) => e.reason === "detached").length, 39);
    assert.equal(
      new Set([...result.events.map((e) => e.id), ...result.videos.map((v) => v.id)]).size,
      40,
    );
    await page.evaluate(() => globalThis.__p2Observer.stop());
    assert.equal(await page.evaluate(() => "__p2Observer" in globalThis), false);
  } finally {
    await browser.close();
  }
});
