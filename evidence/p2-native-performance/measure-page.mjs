import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { installObserver } from "./browser-observer.mjs";
import {
  assertPlaybackAdvanced,
  distribution,
  counterDelta,
  playbackCommitSummary,
  seededSeeks,
  seekSummary,
} from "./metrics.mjs";
const save = (directory, name, value) => {
  const file = path.join(directory, name);
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: "wx" });
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
};
const direct = (_name, operation) => operation();
export async function pausePlayback(page, trace = direct) {
  const label = (
    await trace("pause.readLabel", () => page.locator(".transport-play").innerText())
  ).trim();
  if (label.startsWith("Pause"))
    await trace("pause.click", () => page.locator(".transport-play").click());
  else if (!label.startsWith("Play")) throw new Error(`Unrecognized transport state: ${label}`);
}
export async function playbackSamples(
  page,
  directory,
  label,
  { profiling, observer = true, repeats = 3, trace = direct } = {},
) {
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
  const summaries = [];
  // Each independent sample rewinds and warms for five seconds, then measures 60 seconds.
  for (let repeat = 0; repeat < repeats; repeat++) {
    await trace("sample.pause.before", () => pausePlayback(page, trace));
    await trace("sample.rewind", () => page.evaluate(() => globalThis.__p2SeekTo(0)));
    await trace("sample.play.click", () => page.locator(".transport-play").click());
    await trace("sample.playing", () =>
      page.waitForFunction(
        () =>
          [...globalThis.document.querySelectorAll("video")].some(
            (v) => !v.paused && v.currentTime > 0,
          ),
        undefined,
        { timeout: 15000 },
      ),
    );
    await trace("sample.warmup.5s", () => delay(5000));
    if (observer)
      await trace("sample.observer.install", () =>
        page.evaluate(installObserver, { cap: 20000, leaseMs: 90000 }),
      );
    const before = await trace("sample.before.evaluate", () =>
      page.evaluate(() => {
        // Per-component commits since the last window: proves the profiler is live even if
        // the window itself records none.
        const preWindowCounts = {};
        for (const s of globalThis.__p2Commits?.samples ?? [])
          preWindowCounts[s.id] = (preWindowCounts[s.id] ?? 0) + 1;
        if (globalThis.__p2Commits) {
          globalThis.__p2Commits.samples.length = 0;
          globalThis.__p2Commits.omitted = 0;
        }
        const baseline = new WeakMap();
        for (const v of globalThis.document.querySelectorAll("video"))
          if (typeof v.getVideoPlaybackQuality === "function")
            baseline.set(v, v.getVideoPlaybackQuality().totalVideoFrames);
        globalThis.__p2FrameBaseline = baseline;
        return {
          preWindowCounts,
          at: globalThis.performance.now(),
          quality: [...globalThis.document.querySelectorAll("video")].map((v) =>
            typeof v.getVideoPlaybackQuality === "function"
              ? {
                  total: v.getVideoPlaybackQuality().totalVideoFrames,
                  dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
                }
              : null,
          ),
        };
      }),
    );
    await trace("sample.measure.60s", () => delay(60000));
    const raw = await trace("sample.snapshot.evaluate", () =>
      page.evaluate((diagnostic) => {
        const mark = (step) => {
          if (diagnostic) globalThis.console.debug(`P2-SNAPSHOT:${step}`);
        };
        mark("entered");
        const at = globalThis.performance.now();
        mark("observer.before");
        const snapshot = globalThis.__p2Observer?.snapshot() ?? null;
        mark("observer.after");
        const commits = globalThis.__p2Commits
          ? globalThis.structuredClone(globalThis.__p2Commits)
          : null;
        // Start the next sample's pre-window liveness count from here, not from this window.
        if (globalThis.__p2Commits) {
          globalThis.__p2Commits.samples.length = 0;
          globalThis.__p2Commits.omitted = 0;
        }
        mark("commits.after");
        const quality = [...globalThis.document.querySelectorAll("video")].map((v) =>
          typeof v.getVideoPlaybackQuality === "function"
            ? {
                total: v.getVideoPlaybackQuality().totalVideoFrames,
                dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
              }
            : null,
        );
        mark("quality.after");
        const baseline = globalThis.__p2FrameBaseline ?? new WeakMap();
        let videoFramesAdvanced = 0;
        for (const v of globalThis.document.querySelectorAll("video"))
          if (typeof v.getVideoPlaybackQuality === "function")
            videoFramesAdvanced += Math.max(
              0,
              v.getVideoPlaybackQuality().totalVideoFrames - (baseline.get(v) ?? 0),
            );
        const playing =
          globalThis.document
            .querySelector(".transport-play")
            ?.textContent.trim()
            .startsWith("Pause") === true;
        globalThis.__p2Observer?.stop();
        mark("stop.after");
        return { at, observer: snapshot, commits, quality, playing, videoFramesAdvanced };
      }, trace !== direct),
    );
    await trace("sample.pause.after", () => pausePlayback(page, trace));
    const elapsed = (raw.at - before.at) / 1000;
    assert.ok(elapsed >= 60, "sample must not be shortened");
    assertPlaybackAdvanced(raw.videoFramesAdvanced, elapsed);
    const commits = profiling
      ? playbackCommitSummary({
          ids: ["VideoWorkspace", "MultitrackTimeline"],
          preWindowCounts: before.preWindowCounts,
          windowSamples: raw.commits?.samples ?? [],
          elapsedSeconds: elapsed,
        })
      : null;
    const frames = raw.observer?.events.filter((e) => e.type === "frame") ?? [];
    const segments = [
      ...(raw.observer?.events.filter((e) => e.type === "decoder-segment") ?? []),
      ...(raw.observer?.videos ?? []),
    ].map((e) => ({
      id: e.id,
      segment: e.segment,
      endpointMayBeIncomplete: e.endpointMayBeIncomplete ?? false,
      total: counterDelta(e.initial?.total, e.final?.total),
      dropped: counterDelta(e.initial?.dropped, e.final?.dropped),
    }));
    summaries.push({
      repeat,
      elapsedSeconds: elapsed,
      stillPlayingAtEnd: raw.playing,
      videoFramesAdvanced: raw.videoFramesAdvanced,
      commits,
      frameGapMs: observer ? distribution(frames.map((e) => e.gapMs)) : null,
      decoderSegments: observer ? segments : null,
      sparseQualityBefore: before.quality,
      sparseQualityAfter: raw.quality,
      longTaskDurationMs: observer
        ? distribution(
            raw.observer.events.filter((e) => e.type === "longtask").map((e) => e.duration),
          )
        : null,
      dom: raw.observer
        ? {
            nodes: raw.observer.domCount,
            visibleRows: raw.observer.visibleRows,
            materializedRows: raw.observer.materializedRows,
            materializedItems: raw.observer.materializedItems,
          }
        : null,
      omitted: raw.observer?.omitted ?? null,
      videoTrackingCapReached: raw.observer?.videoTrackingCapReached ?? null,
      artifact: save(directory, `${label}-playback-${repeat}.json`, { before, ...raw }),
    });
  }
  return summaries;
}
export function armFixtureSeek({
  frame,
  expectedSeconds,
  toleranceSeconds,
  mode,
  clipId,
  timeoutMs = 5000,
}) {
  // Preview binds to the requested clip's element; Final has one verified element.
  globalThis.__p2Observer.armSeek(
    mode === "Final"
      ? 'video[aria-label="Verified final video preview"]'
      : 'video[aria-label^="Canonical video layer"]',
    expectedSeconds,
    toleranceSeconds,
    timeoutMs,
    { clipId: mode === "Final" ? null : clipId },
  );
  globalThis.__p2Observer.markRequest();
  globalThis.__p2SeekTo(frame);
}

export async function seekSamples(page, directory, label, fixture, mode) {
  await pausePlayback(page);
  const selector =
    mode === "Final"
      ? 'video[aria-label="Verified final video preview"]'
      : 'video[aria-label^="Canonical video layer"]';
  await page.evaluate(() => globalThis.__p2SeekTo(0));
  await page.locator(selector).first().waitFor({ state: "attached", timeout: 10000 });
  const frames = seededSeeks(0x5052, fixture.durationFrames, fixture.edges);
  const samples = [];
  for (const [index, frame] of frames.entries()) {
    const rate = fixture.sequence.rate.numerator / fixture.sequence.rate.denominator;
    const clip = fixture.sequence.tracks
      .filter((t) => t.kind === "video" && !t.hidden)
      .flatMap((t) => t.clips)
      .find(
        (c) =>
          frame >= c.timelineStart.value &&
          frame < c.timelineStart.value + c.sourceOut.value - c.sourceIn.value,
      );
    if (!clip && mode !== "Final") {
      await page.evaluate((f) => globalThis.__p2SeekTo(f), frame);
      samples.push({
        index,
        frame,
        status: "gap-no-video-frame",
        seekedMs: null,
        presentedMs: null,
      });
      continue;
    }
    const expectedSeconds =
      mode === "Final"
        ? frame / rate
        : (frame - clip.timelineStart.value + clip.sourceIn.value) / rate;
    await page.evaluate(installObserver, { cap: 4000, leaseMs: 10000 });
    try {
      await page.evaluate(armFixtureSeek, {
        frame,
        expectedSeconds,
        toleranceSeconds: 1 / rate,
        mode,
        clipId: clip?.id,
      });
      await page.waitForFunction(
        () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
        undefined,
        { timeout: 7000 },
      );
      const raw = await page.evaluate(() => globalThis.__p2Observer.snapshot());
      const event = raw.events.find((e) => e.type === "seek");
      assert.ok(event, "every request retains an outcome");
      samples.push({ index, frame, ...event });
    } finally {
      await page.evaluate(() => globalThis.__p2Observer?.stop());
    }
  }
  assert.equal(samples.length, 100);
  return { ...seekSummary(samples), artifact: save(directory, `${label}-seeks.json`, samples) };
}
