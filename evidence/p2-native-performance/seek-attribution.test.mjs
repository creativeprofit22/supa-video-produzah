import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import path from "node:path";
import { installObserver } from "./browser-observer.mjs";
import { armFixtureSeek } from "./measure-page.mjs";
import { seekSummary } from "./metrics.mjs";
const { chromium } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))(
  "@playwright/test",
);
const media = pathToFileURL(
  path.resolve("evidence/p2-native-performance/runs/media-9f3WSn/source-30-1-0.mp4"),
).href;

// Two real decoded layers; `target` is pre-positioned at `startSeconds` and fully settled.
async function layers(page, startSeconds) {
  await page.goto(media, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector("video")?.readyState >= 2,
    undefined,
    { timeout: 7000 },
  );
  await page.evaluate(() => {
    const src = globalThis.document.querySelector("video").currentSrc;
    const stage = globalThis.document.createElement("div");
    stage.className = "monitor-stage";
    for (const id of ["old", "target"]) {
      const v = globalThis.document.createElement("video");
      v.src = src;
      v.muted = true;
      v.dataset.clipId = id;
      v.setAttribute("aria-label", "Canonical video layer 1");
      stage.append(v);
    }
    globalThis.document.body.replaceChildren(stage);
  });
  const ready = '.monitor-stage [data-clip-id="target"]';
  await page.waitForFunction((s) => globalThis.document.querySelector(s)?.readyState >= 2, ready, {
    timeout: 7000,
  });
  await page.evaluate(
    ({ s, start }) => {
      globalThis.document.querySelector(s).currentTime = start;
    },
    { s: ready, start: startSeconds },
  );
  // Settled: seek finished and the frame is decoded (bounded; no unbounded event waits).
  await page.waitForFunction(
    ({ s, start }) => {
      const v = globalThis.document.querySelector(s);
      return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - start) < 1e-3;
    },
    { s: ready, start: startSeconds },
    { timeout: 7000 },
  );
  await page.waitForTimeout(300); // let the settled frame composite before arming
}
const lastSeek = (page) =>
  page.evaluate(() => {
    const seek = globalThis.__p2Observer.snapshot().events.find((e) => e.type === "seek");
    globalThis.__p2Observer.stop();
    return seek;
  });

test(
  "observer latches the requested connected clip, not a removed layer's earlier zero-time write",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true, timeout: 10000 });
    try {
      const page = await browser.newPage();
      await layers(page, 2);
      await page.evaluate(installObserver, { cap: 100, leaseMs: 10000 });
      await page.evaluate(() => {
        globalThis.__p2SeekTo = () => {
          const stage = globalThis.document.querySelector(".monitor-stage");
          const old = stage.querySelector('[data-clip-id="old"]');
          old.remove();
          old.currentTime = 0; // departing layer reset, as in the native trace
          stage.querySelector('[data-clip-id="target"]').currentTime = 0;
        };
      });
      await page.evaluate(armFixtureSeek, {
        frame: 900,
        expectedSeconds: 0,
        toleranceSeconds: 1 / 30,
        mode: "Preview",
        clipId: "target",
        timeoutMs: 3000,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 5000 },
      );
      const seek = await lastSeek(page);
      assert.equal(seek.status, "ok", JSON.stringify(seek));
      assert.equal(seek.requestedClipId, "target");
      assert.equal(seek.observedMedia.clipId, "target");
      assert.equal(seek.observedMedia.connected, true);
      assert.ok(seek.seekedMs >= 0 && seek.presentedMs >= 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  "a detached decoy alone is request-not-observed, never a timeout on the wrong element",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true, timeout: 10000 });
    try {
      const page = await browser.newPage();
      await layers(page, 2);
      await page.evaluate(installObserver, { cap: 100, leaseMs: 10000 });
      await page.evaluate(() => {
        globalThis.__p2SeekTo = () => {
          const old = globalThis.document.querySelector('[data-clip-id="old"]');
          old.remove();
          old.currentTime = 0;
        };
      });
      await page.evaluate(armFixtureSeek, {
        frame: 900,
        expectedSeconds: 0,
        toleranceSeconds: 1 / 30,
        mode: "Preview",
        clipId: "old",
        timeoutMs: 300,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 3000 },
      );
      const seek = await lastSeek(page);
      assert.equal(seek.status, "request-not-observed");
      assert.equal(seek.observedMedia, null);
    } finally {
      await browser.close();
    }
  },
);

const settled = 1 / 30 + 0.000002; // what the app's frame-quantized seek writes for frame 1

test(
  "same-frame re-seek that does present a frame (headless Chromium) is ok, not reclassified",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true, timeout: 10000 });
    try {
      const page = await browser.newPage();
      await layers(page, settled);
      await page.evaluate(installObserver, { cap: 100, leaseMs: 10000 });
      await page.evaluate((value) => {
        globalThis.__p2SeekTo = () => {
          globalThis.document.querySelector('[data-clip-id="target"]').currentTime = value;
        };
      }, settled);
      await page.evaluate(armFixtureSeek, {
        frame: 1,
        expectedSeconds: 1 / 30,
        toleranceSeconds: 1 / 30,
        mode: "Preview",
        clipId: "target",
        timeoutMs: 1500,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 4000 },
      );
      const seek = await lastSeek(page);
      assert.equal(seek.status, "ok", JSON.stringify(seek));
      assert.ok(seek.presentedMs !== null);
    } finally {
      await browser.close();
    }
  },
);

// In the full app (browser build, headless Chromium 151, run seek-attribution-NmfNPz) a same-frame
// re-seek fired `seeked` but no frame callback. The isolated page above re-presents instead, so
// only the callback is withheld here; the media, write, seek and `seeked` event remain real.
test(
  "same-frame re-seek with seeked but no new frame callback is same-frame, separate from a real timeout",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true, timeout: 10000 });
    try {
      const page = await browser.newPage();
      await layers(page, settled);
      await page.evaluate(installObserver, { cap: 100, leaseMs: 10000 });
      await page.evaluate((value) => {
        const target = globalThis.document.querySelector('[data-clip-id="target"]');
        target.requestVideoFrameCallback = () => 0; // withhold presentation callback only
        globalThis.__p2SeekTo = () => {
          target.currentTime = value;
        };
      }, settled);
      await page.evaluate(armFixtureSeek, {
        frame: 1,
        expectedSeconds: 1 / 30,
        toleranceSeconds: 1 / 30,
        mode: "Preview",
        clipId: "target",
        timeoutMs: 1500,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 4000 },
      );
      const seek = await lastSeek(page);
      assert.equal(seek.status, "same-frame-no-new-frame", JSON.stringify(seek));
      assert.ok(seek.seekedMs !== null);
      assert.equal(seek.presentedMs, null);
      assert.ok(seek.beforeWrite.readyState >= 2);
      const summary = seekSummary([seek, { status: "timeout", seekedMs: null, presentedMs: null }]);
      assert.equal(summary.sameFrameNoNewFrame, 1);
      assert.equal(summary.failures, 1);
      assert.equal(summary.presentedMs.count, 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  "a seek to a different frame that never presents stays a timeout",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true, timeout: 10000 });
    try {
      const page = await browser.newPage();
      await layers(page, 2);
      await page.evaluate(installObserver, { cap: 100, leaseMs: 10000 });
      await page.evaluate(() => {
        globalThis.__p2SeekTo = () => {
          const target = globalThis.document.querySelector('[data-clip-id="target"]');
          target.currentTime = 0;
          target.removeAttribute("src");
          target.load(); // write observed, frame never presented
        };
      });
      await page.evaluate(armFixtureSeek, {
        frame: 0,
        expectedSeconds: 0,
        toleranceSeconds: 1 / 30,
        mode: "Preview",
        clipId: "target",
        timeoutMs: 1000,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 3000 },
      );
      const seek = await lastSeek(page);
      assert.equal(seek.status, "timeout", JSON.stringify(seek));
      assert.equal(seek.presentedMs, null);
    } finally {
      await browser.close();
    }
  },
);
