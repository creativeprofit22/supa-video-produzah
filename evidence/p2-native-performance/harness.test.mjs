import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  distribution,
  sampleBuffer,
  counterDelta,
  seekSummary,
  slope,
  seededSeeks,
  assertPlaybackAdvanced,
  playbackCommitSummary,
} from "./metrics.mjs";
import { workload, fixtureId } from "./workloads.mjs";
import { assertOwnedTarget } from "./ownership.mjs";
import { installObserver } from "./browser-observer.mjs";
import profileConfig from "./vite.profile.config.mjs";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { videoSequenceV2Schema } = await import("../../packages/video-contracts/dist/index.js");

test("nearest-rank distributions retain unavailable values and reject nonfinite samples", () => {
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, p99: null, max: null });
  assert.deepEqual(distribution([null, NaN, -1, 10, 20, 30, Infinity]), {
    count: 3,
    p50: 20,
    p95: 30,
    p99: 30,
    max: 30,
  });
});
test("sample storage caps and reset preserve omission counts", () => {
  const b = sampleBuffer(2);
  [1, 2, 3].forEach((v) => b.push(v));
  assert.deepEqual(b.snapshot(), { values: [1, 2], omitted: 1 });
  b.clear();
  assert.deepEqual(b.snapshot(), { values: [], omitted: 0 });
  assert.throws(() => sampleBuffer(0));
});
test("missing/reset counters are unavailable, not zero", () => {
  assert.equal(counterDelta(null, 3), null);
  assert.equal(counterDelta(5, 2), null);
  assert.equal(counterDelta(2, 2), 0);
  assert.equal(counterDelta(2, 6), 4);
});
test("seek timeout accounting retains observed latency and requested failures", () => {
  const result = seekSummary([
    { status: "ok", seekedMs: 20, presentedMs: 30 },
    { status: "timeout", seekedMs: 40, presentedMs: null },
  ]);
  assert.equal(result.requested, 2);
  assert.equal(result.failures, 1);
  assert.equal(result.seekedMs.count, 2);
  assert.equal(result.presentedMs.count, 1);
  assert.equal(
    slope(
      [
        { seconds: 0, bytes: 10 },
        { seconds: 5, bytes: 20 },
      ],
      "bytes",
    ),
    2,
  );
});
test("shared deterministic sequences pass the installed contracts for both rates", () => {
  for (const rate of [
    { numerator: 30, denominator: 1 },
    { numerator: 30000, denominator: 1001 },
  ]) {
    for (const kind of ["small", "timeline-1000", "two-layer"]) {
      const input = workload(kind, rate, [fixtureId(101), fixtureId(102)]);
      videoSequenceV2Schema.parse(input.sequence);
      assert.deepEqual(input, workload(kind, rate, [fixtureId(101), fixtureId(102)]));
      if (kind === "timeline-1000")
        assert.equal(
          input.sequence.tracks.reduce((sum, t) => sum + (t.clips ?? t.captions).length, 0),
          1000,
        );
      const seeks = seededSeeks(123, input.durationFrames, input.edges);
      assert.equal(seeks.length, 100);
      assert.deepEqual(seeks, seededSeeks(123, input.durationFrames, input.edges));
      assert.ok(seeks.every((f) => f >= 0 && f < input.durationFrames));
      assert.ok(seeks.some((f) => f > input.durationFrames / 2));
    }
  }
  assert.throws(() => workload("small", { numerator: 25, denominator: 1 }, []));
});
test("native identity refuses profile escapes, reused PID, unexpected port owner and page", () => {
  const expected = {
    isolatedRoot: "C:\\evidence\\run",
    executable: "C:\\evidence\\run\\app.exe",
    pid: 100,
    creationUtc: "2026-09-19T00:00:00.000Z",
    port: 9444,
  };
  const observed = {
    ...expected,
    address: "127.0.0.1",
    portOwnerPid: 101,
    pageUrl: "http://tauri.localhost/",
    descendants: [
      {
        pid: 101,
        creationUtc: "2026-09-19T00:00:01.000Z",
        commandLineArguments: ["--remote-debugging-port=9444"],
      },
    ],
  };
  assert.equal(assertOwnedTarget(expected, observed), true);
  for (const delta of [
    { executable: "C:\\elsewhere\\app.exe" },
    { creationUtc: "later" },
    { address: "0.0.0.0" },
    { portOwnerPid: 102 },
    { pageUrl: "http://example.com/" },
  ])
    assert.throws(() => assertOwnedTarget(expected, { ...observed, ...delta }));
});
test("opt-in transform changes only named component entrypoints and refuses source drift", () => {
  const config = profileConfig({ mode: "production" });
  const plugin = config.plugins[0];
  for (const name of ["VideoWorkspace", "MultitrackTimeline"]) {
    const file = fileURLToPath(
      new URL(`../../apps/desktop/src/video/${name}.tsx`, import.meta.url),
    );
    const result = plugin.transform(readFileSync(file, "utf8"), file);
    assert.ok(result.code.includes(`id="${name}"`));
    assert.ok(result.code.includes(`function P2${name}(`));
    assert.throws(() => plugin.transform("unrecognized", file));
  }
  assert.equal(plugin.transform("unchanged", "other.tsx"), null);
});
test("resource sampler refuses an unrelated/nonexistent process before sampling", () => {
  assert.throws(
    () =>
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-File",
          fileURLToPath(new URL("./sample-resources.ps1", import.meta.url)),
          "-OwnedPid",
          "2147483647",
          "-ExpectedExecutable",
          "C:\\not-owned\\app.exe",
          "-ExpectedCreationUtc",
          "2026-09-19T00:00:00Z",
          "-DurationSeconds",
          "5",
        ],
        { stdio: "pipe", timeout: 10000 },
      ),
    (error) => String(error.stderr).includes("Refusing non-isolated executable"),
  );
});
test("real browser observer times out, caps samples and tears down listeners", async () => {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<video id="probe"></video>');
    await page.evaluate(installObserver, { cap: 2, leaseMs: 1000 });
    await page.evaluate(() => globalThis.__p2Observer.armSeek("#probe", 1, 1 / 30, 20));
    await page.waitForFunction(() =>
      globalThis.__p2Observer.snapshot().events.some((e) => e.type === "seek"),
    );
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => globalThis.__p2Observer.armSeek("#probe", 1, 1 / 30, 20));
      await page.waitForFunction(() => globalThis.__p2Observer.snapshot().pendingSeeks === 0);
    }
    const state = await page.evaluate(() => {
      const observer = globalThis.__p2Observer;
      const result = observer.snapshot();
      observer.stop();
      observer.stop();
      return { result, removed: !globalThis.__p2Observer };
    });
    assert.equal(state.result.events.length, 2);
    assert.ok(state.result.omitted >= 1);
    assert.equal(state.result.events.find((e) => e.type === "seek").status, "request-not-observed");
    assert.equal(state.removed, true);
    const ts = require("typescript");
    const actualSeekModule = ts.transpileModule(
      readFileSync(
        fileURLToPath(new URL("../../apps/desktop/src/video/mediaSeek.ts", import.meta.url)),
        "utf8",
      ),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
    ).outputText;
    await page.evaluate(async (code) => {
      globalThis.__actualSeek = (
        await import(`data:text/javascript,${encodeURIComponent(code)}`)
      ).seekMediaTime;
      globalThis.__originalSetter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLMediaElement.prototype,
        "currentTime",
      ).set;
    }, actualSeekModule);
    await page.evaluate(installObserver, { cap: 20, leaseMs: 1000 });
    await page.evaluate(() => {
      globalThis.__p2Observer.armSeek("#probe", 1.001, 1 / 30, 20);
      globalThis.__actualSeek(globalThis.document.querySelector("#probe"), 1.001);
    });
    await page.waitForFunction(() => globalThis.__p2Observer.snapshot().pendingSeeks === 0);
    const request = await page.evaluate(() =>
      globalThis.__p2Observer.snapshot().events.find((e) => e.type === "seek"),
    );
    assert.equal(request.latencyOrigin, "real-media-write-boundary");
    assert.equal(request.requestedValue, 1.001001);
    assert.ok(request.requestedAt >= request.armedAt);
    assert.equal(request.status, "timeout");
    await page.evaluate(() => {
      const v = globalThis.document.querySelector("#probe");
      v.dispatchEvent(new globalThis.Event("emptied"));
      v.dispatchEvent(new globalThis.Event("emptied"));
    });
    const segments = await page.evaluate(() =>
      globalThis.__p2Observer.snapshot().events.filter((e) => e.type === "decoder-segment"),
    );
    assert.deepEqual(
      segments.map((e) => e.segment),
      [0, 1],
    );
    await page.waitForFunction(() => !globalThis.__p2Observer);
    assert.equal(
      await page.evaluate(
        () =>
          Object.getOwnPropertyDescriptor(globalThis.HTMLMediaElement.prototype, "currentTime")
            .set === globalThis.__originalSetter,
      ),
      true,
    );
  } finally {
    await browser.close();
  }
});

test("zero in-window commits pass when the profiler is live and playback advances", () => {
  const ids = ["VideoWorkspace", "MultitrackTimeline"];
  assert.doesNotThrow(() => assertPlaybackAdvanced(1800, 60));
  const summary = playbackCommitSummary({
    ids,
    preWindowCounts: { VideoWorkspace: 4, MultitrackTimeline: 2 },
    windowSamples: [],
    elapsedSeconds: 60,
  });
  assert.deepEqual(
    summary.map((s) => [s.id, s.count, s.commitsPerSecond, s.durationMs.p95]),
    [
      ["VideoWorkspace", 0, 0, null],
      ["MultitrackTimeline", 0, 0, null],
    ],
  );
});

test("zero commits with stuck video frames fail as a playback stall", () => {
  for (const advanced of [0, null, undefined, Number.NaN])
    assert.throws(() => assertPlaybackAdvanced(advanced, 60), /^Error: Playback stalled/);
});

test("no commits before the window fail as a dead profiler, not a zero result", () => {
  assert.throws(
    () =>
      playbackCommitSummary({
        ids: ["VideoWorkspace", "MultitrackTimeline"],
        preWindowCounts: { VideoWorkspace: 3 },
        windowSamples: [],
        elapsedSeconds: 60,
      }),
    /Profiler not live: no MultitrackTimeline commits recorded before the window/,
  );
  assert.throws(
    () =>
      playbackCommitSummary({
        ids: ["VideoWorkspace"],
        preWindowCounts: undefined,
        windowSamples: [{ id: "VideoWorkspace", actualDuration: 1 }],
        elapsedSeconds: 60,
      }),
    /Profiler not live: no VideoWorkspace commits/,
  );
});
