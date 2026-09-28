// Visible-layer decoder drop attribution, exercised on real decoded media in Chromium.
// Real playback supplies the decoded-frame totals and the observer's state stream. Where a case
// needs drops on a known layer, that element's getVideoPlaybackQuality() is wrapped to report
// dropped frames derived from its real totals; which element drops is then known exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import path from "node:path";
import { installObserver } from "./browser-observer.mjs";
import { visibleDropAttribution } from "./metrics.mjs";
const { chromium } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))(
  "@playwright/test",
);
const media = pathToFileURL(
  path.resolve("evidence/p2-native-performance/runs/media-9f3WSn/source-30-1-0.mp4"),
).href;

// Builds a monitor stage of real layers. `hidden` layers mirror the app's inactive markup.
async function stage(page, layers) {
  await page.goto(media, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector("video")?.readyState >= 2,
    undefined,
    { timeout: 7000 },
  );
  await page.evaluate((specs) => {
    const src = globalThis.document.querySelector("video").currentSrc;
    const root = globalThis.document.createElement("div");
    root.className = "monitor-stage";
    if (specs.some((s) => s.style)) {
      root.style.cssText = "position:relative;width:640px;height:360px";
    }
    for (const { id, hidden, style } of specs) {
      const v = globalThis.document.createElement("video");
      v.src = src;
      v.muted = true;
      v.playsInline = true;
      if (id !== null) {
        v.dataset.clipId = id;
        v.dataset.active = hidden ? "false" : "true";
      }
      if (style) v.style.cssText = style;
      v.style.visibility = hidden ? "hidden" : "visible";
      root.append(v);
    }
    globalThis.document.body.replaceChildren(root);
  }, layers);
  await page.waitForFunction(
    (n) =>
      [...globalThis.document.querySelectorAll(".monitor-stage video")].filter(
        (v) => v.readyState >= 2,
      ).length === n,
    layers.length,
    { timeout: 7000 },
  );
}
const play = (page) =>
  page.evaluate(() =>
    Promise.all(
      [...globalThis.document.querySelectorAll(".monitor-stage video")].map((v) => v.play()),
    ),
  );
// Wrap one element's counters: dropped = f(real total), total unchanged.
const wrapDrops = (page, clipId, mode) =>
  page.evaluate(
    ({ clipId: id, mode: m }) => {
      const v = globalThis.document.querySelector(`[data-clip-id="${id}"]`);
      const real = v.getVideoPlaybackQuality.bind(v);
      v.getVideoPlaybackQuality = () => {
        const q = real();
        const since = globalThis.__p2DropFrom?.[id];
        const dropped =
          m === "all"
            ? q.totalVideoFrames
            : m === "after-swap" && since !== undefined
              ? q.totalVideoFrames - since
              : m === "before-swap" && since === undefined
                ? q.totalVideoFrames
                : m === "before-swap"
                  ? since
                  : 0;
        return {
          totalVideoFrames: q.totalVideoFrames,
          droppedVideoFrames: dropped,
          corruptedVideoFrames: 0,
        };
      };
    },
    { clipId, mode },
  );
const finish = (page) =>
  page.evaluate(() => {
    const snapshot = globalThis.__p2Observer.snapshot();
    globalThis.__p2Observer.stop();
    return snapshot;
  });
const launch = () =>
  chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

test(
  "single layer: every decoded frame is visible and attributed to the only video",
  {
    timeout: 30000,
  },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await stage(page, [{ id: null, hidden: false }]);
      await play(page);
      await page.evaluate(installObserver, { cap: 5000, leaseMs: 20000 });
      await page.waitForTimeout(1500);
      const snapshot = await finish(page);
      const frames = snapshot.events.filter((e) => e.type === "frame");
      assert.ok(frames.length > 10, `expected real frames, got ${frames.length}`);
      assert.ok(frames.every((e) => e.attribution.onlyVideo && e.attribution.visible));
      assert.ok(frames.every((e) => e.quality && Number.isFinite(e.quality.total)));
      const result = visibleDropAttribution(snapshot);
      assert.equal(result.attributionAvailable, true);
      assert.ok(result.visible.total > 10, JSON.stringify(result));
      assert.equal(result.hidden.total, 0);
      assert.equal(result.unattributed.intervals, 0);
      assert.equal(result.visibleDropRate, result.visible.dropped / result.visible.total);
    } finally {
      await browser.close();
    }
  },
);

test(
  "two layers, one hidden: hidden-layer drops never count as visible",
  {
    timeout: 30000,
  },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await stage(page, [
        { id: "front", hidden: false },
        { id: "preloaded", hidden: true },
      ]);
      await wrapDrops(page, "front", "none");
      await wrapDrops(page, "preloaded", "all");
      await play(page);
      await page.evaluate(installObserver, { cap: 5000, leaseMs: 20000 });
      await page.waitForTimeout(1500);
      const snapshot = await finish(page);
      const states = snapshot.events.filter((e) => e.type === "visibility");
      assert.deepEqual(
        states
          .map((e) => [e.attribution.clipId, e.attribution.visible, e.attribution.onlyVideo])
          .sort(),
        [
          ["front", true, false],
          ["preloaded", false, false],
        ],
      );
      const result = visibleDropAttribution(snapshot);
      assert.ok(result.visible.total > 10, JSON.stringify(result));
      assert.equal(result.visible.dropped, 0);
      assert.equal(result.visibleDropRate, 0);
      assert.equal(result.meetsVisibleTarget, true);
      assert.equal(result.byClip.front.hidden.total, 0);
      assert.equal(result.byClip.preloaded.visible.total, 0);
      // The hidden layer really decoded; all of it reported as dropped, and all of it stays hidden.
      assert.ok(result.hidden.total > 0, JSON.stringify(result));
      assert.equal(result.hidden.dropped, result.hidden.total);
    } finally {
      await browser.close();
    }
  },
);

test(
  "clip-churn boundary: counters split at the swap and at removal",
  {
    timeout: 30000,
  },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await stage(page, [
        { id: "outgoing", hidden: false },
        { id: "incoming", hidden: true },
      ]);
      // outgoing drops only after it is hidden; incoming drops only before it is shown.
      await wrapDrops(page, "outgoing", "after-swap");
      await wrapDrops(page, "incoming", "before-swap");
      await play(page);
      await page.evaluate(installObserver, { cap: 5000, leaseMs: 20000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        const [outgoing, incoming] = ["outgoing", "incoming"].map((id) =>
          globalThis.document.querySelector(`[data-clip-id="${id}"]`),
        );
        // Freeze each counter origin in the same task as the swap, as an app update would.
        const total = (v) => v.getVideoPlaybackQuality().totalVideoFrames;
        globalThis.__p2DropFrom = { outgoing: total(outgoing), incoming: total(incoming) };
        outgoing.dataset.active = "false";
        outgoing.style.visibility = "hidden";
        incoming.dataset.active = "true";
        incoming.style.visibility = "visible";
      });
      await page.waitForTimeout(1200);
      await page.evaluate(() =>
        globalThis.document.querySelector('[data-clip-id="outgoing"]').remove(),
      );
      await page.waitForTimeout(600);
      const snapshot = await finish(page);
      const changes = snapshot.events.filter(
        (e) => e.type === "visibility" && e.reason === "change",
      );
      assert.deepEqual(changes.map((e) => [e.attribution.clipId, e.attribution.visible]).sort(), [
        ["incoming", true],
        ["outgoing", false],
      ]);
      const detached = snapshot.events.find(
        (e) => e.type === "decoder-segment" && e.reason === "detached",
      );
      assert.equal(detached?.attribution.clipId, "outgoing");
      const result = visibleDropAttribution(snapshot);
      assert.equal(result.visible.dropped, 0, JSON.stringify(result));
      assert.ok(result.byClip.outgoing.visible.total > 0, JSON.stringify(result.byClip));
      assert.ok(result.byClip.incoming.visible.total > 0, JSON.stringify(result.byClip));
      assert.equal(result.byClip.outgoing.hidden.dropped, result.byClip.outgoing.hidden.total);
      assert.equal(result.byClip.incoming.hidden.dropped, result.byClip.incoming.hidden.total);
      assert.ok(result.byClip.outgoing.hidden.total > 0, JSON.stringify(result.byClip));
      assert.ok(result.byClip.incoming.hidden.total > 0, JSON.stringify(result.byClip));
      assert.equal(result.hidden.dropped, result.hidden.total);
    } finally {
      await browser.close();
    }
  },
);

// Mirrors the app's stacking: absolutely positioned layers, the higher z-index drawn on top.
const layer = (z, scale) =>
  `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${z};transform:scale(${scale})`;

test(
  "a CSS-visible layer fully covered by an opaque layer counts as occluded, not visible",
  {
    timeout: 30000,
  },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await stage(page, [
        { id: "top", hidden: false, style: layer(2, 1) },
        { id: "covered", hidden: false, style: layer(1, 0.5) },
      ]);
      await wrapDrops(page, "top", "none");
      await wrapDrops(page, "covered", "all");
      await play(page);
      await page.evaluate(installObserver, { cap: 5000, leaseMs: 20000 });
      await page.waitForTimeout(1200);
      // Hiding the top layer uncovers the lower one: a sibling change must close its interval.
      await page.evaluate(() => {
        globalThis.document.querySelector('[data-clip-id="top"]').style.visibility = "hidden";
      });
      await page.waitForTimeout(1200);
      const snapshot = await finish(page);
      const covered = snapshot.events.filter(
        (e) => e.type === "visibility" && e.attribution.clipId === "covered",
      );
      assert.deepEqual(
        covered.map((e) => [e.reason, e.attribution.visible, e.attribution.occluded]),
        [
          ["attach", true, true],
          ["change", true, false],
        ],
      );
      assert.equal(covered[0].attribution.shownPoints, 0);
      assert.equal(covered[1].attribution.shownPoints, 5);
      const result = visibleDropAttribution(snapshot);
      assert.equal(result.occlusionAvailable, true);
      assert.ok(result.byClip.covered.occluded.total > 0, JSON.stringify(result.byClip));
      assert.equal(result.byClip.covered.occluded.dropped, result.byClip.covered.occluded.total);
      assert.equal(result.byClip.top.occluded.total, 0);
      assert.ok(result.byClip.top.visible.total > 0, JSON.stringify(result.byClip));
      assert.equal(result.byClip.top.visible.dropped, 0);
      // Once uncovered, the lower layer's drops are visible drops.
      assert.ok(result.byClip.covered.visible.total > 0, JSON.stringify(result.byClip));
      assert.equal(result.byClip.covered.visible.dropped, result.byClip.covered.visible.total);
    } finally {
      await browser.close();
    }
  },
);

test(
  "a partly covered layer (smaller layer on top) stays visible",
  {
    timeout: 30000,
  },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await stage(page, [
        { id: "inset", hidden: false, style: layer(2, 0.5) },
        { id: "full", hidden: false, style: layer(1, 1) },
      ]);
      await play(page);
      await page.evaluate(installObserver, { cap: 5000, leaseMs: 20000 });
      await page.waitForTimeout(800);
      const snapshot = await finish(page);
      const full = snapshot.events.find(
        (e) => e.type === "visibility" && e.attribution.clipId === "full",
      );
      assert.equal(full.attribution.occluded, false);
      assert.equal(full.attribution.shownPoints, 4);
      const result = visibleDropAttribution(snapshot);
      assert.equal(result.occluded.total, 0);
      assert.ok(result.byClip.full.visible.total > 0, JSON.stringify(result.byClip));
      assert.ok(result.byClip.inset.visible.total > 0, JSON.stringify(result.byClip));
    } finally {
      await browser.close();
    }
  },
);

test("older snapshots without attribution report unavailable, never a visible rate", () => {
  const result = visibleDropAttribution({
    events: [
      { type: "frame", id: 0, segment: 0, at: 1, gapMs: null },
      { type: "frame", id: 0, segment: 0, at: 2, gapMs: 1 },
    ],
    videos: [
      { id: 0, segment: 0, initial: { total: 0, dropped: 0 }, final: { total: 60, dropped: 3 } },
    ],
  });
  assert.equal(result.attributionAvailable, false);
  assert.equal(result.occlusionAvailable, false);
  assert.equal(result.visible.total, 0);
  assert.equal(result.visibleDropRate, null);
  assert.equal(result.meetsVisibleTarget, null);
  assert.equal(result.unattributed.intervals, 2);
});
