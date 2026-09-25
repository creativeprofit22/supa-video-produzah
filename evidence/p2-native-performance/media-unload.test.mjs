import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import path from "node:path";
import { captureMediaForUnload, inspectMediaUnload, mediaIsUnloaded } from "./media-unload.mjs";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

for (const reset of [false, true]) {
  test(
    `real media detach ${reset ? "with load resets resources despite remembered URL" : "without load is rejected"}`,
    { timeout: 20000 },
    async () => {
      const browser = await chromium.launch({ headless: true, timeout: 10000 });
      try {
        const page = await browser.newPage();
        await page.goto(
          pathToFileURL(
            path.resolve("evidence/p2-native-performance/runs/media-9f3WSn/source-30-1-0.mp4"),
          ).href,
          { waitUntil: "domcontentloaded", timeout: 10000 },
        );
        await page.waitForFunction(
          () => globalThis.document.querySelector("video")?.readyState >= 2,
          undefined,
          { timeout: 7000 },
        );
        await page.evaluate(() => {
          const src = globalThis.document.querySelector("video").currentSrc;
          const stage = globalThis.document.createElement("div");
          stage.className = "monitor-stage";
          const video = globalThis.document.createElement("video");
          video.src = src;
          stage.append(video);
          globalThis.document.body.replaceChildren(stage);
        });
        await page.waitForFunction(
          () => globalThis.document.querySelector("video")?.readyState >= 2,
          undefined,
          { timeout: 7000 },
        );
        await page.evaluate(captureMediaForUnload);
        await page.evaluate((reset) => {
          const video = globalThis.document.querySelector("video");
          video.remove();
          video.pause();
          video.removeAttribute("src");
          if (reset) video.load();
        }, reset);
        const [result] = await page.evaluate(inspectMediaUnload);
        assert.ok(result.before.currentSrc.length > 0);
        assert.equal(result.before.connected, true);
        assert.ok(result.before.readyState >= 2);
        assert.equal(mediaIsUnloaded(result.settled), reset, JSON.stringify(result));
        if (reset) {
          assert.ok(result.events.some((event) => event.type === "emptied"));
          assert.equal(result.omitted, 0);
        }
        assert.equal(await page.evaluate(() => "__p2UnloadProbe" in globalThis), false);
      } finally {
        await browser.close();
      }
    },
  );
}
