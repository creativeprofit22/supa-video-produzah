import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";

export async function boundedProbe(operation, milliseconds = 2000) {
  let timer;
  const start = performance.now();
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe deadline exceeded")), milliseconds);
      }),
    ]);
    return { ok: true, elapsedMs: performance.now() - start, value };
  } catch (error) {
    return { ok: false, elapsedMs: performance.now() - start, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeResponsiveness(page, trace, record, { idle = false } = {}) {
  // Deadlines report unavailability; they do not cancel pending CDP requests.
  // Stop on first failure and let the external owned-job lease bound teardown.
  const browser = await trace("probe.browser-session", () =>
    page.context().browser().newBrowserCDPSession(),
  );
  const samples = [];
  const start = performance.now();
  try {
    if (!idle) await trace("probe.play", () => page.locator(".transport-play").click());
    for (let i = 0; i < 15; i++) {
      const [control, renderer] = await trace(`probe.round.${i}`, () =>
        Promise.all([
          boundedProbe(() => browser.send("Browser.getVersion")),
          boundedProbe(() =>
            page.evaluate(() => ({
              at: globalThis.performance.now(),
              mountedMediaCount:
                globalThis.document.querySelectorAll(".monitor-stage video").length,
              activeMediaCount: globalThis.document.querySelectorAll(
                '.monitor-stage video[data-active="true"]',
              ).length,
              mediaWithMetadata: [
                ...globalThis.document.querySelectorAll(".monitor-stage video"),
              ].filter((v) => v.readyState >= 1).length,
              videos: [...globalThis.document.querySelectorAll("video")]
                .slice(0, 8)
                .map((v) => ({
                  currentTime: v.currentTime,
                  paused: v.paused,
                  readyState: v.readyState,
                })),
              heap: globalThis.performance.memory
                ? {
                    used: globalThis.performance.memory.usedJSHeapSize,
                    total: globalThis.performance.memory.totalJSHeapSize,
                  }
                : null,
            })),
          ),
        ]),
      );
      const sample = {
        round: i,
        utc: new Date().toISOString(),
        seconds: (performance.now() - start) / 1000,
        control,
        renderer,
      };
      samples.push(sample);
      record(sample);
      if (!control.ok || !renderer.ok) break;
      await trace("probe.interval", () => delay(1000));
    }
    return {
      diagnosticOnly: true,
      idle,
      samples,
      allResponsive: samples.length === 15 && samples.every((s) => s.control.ok && s.renderer.ok),
    };
  } finally {
    await trace("probe.browser-session.detach", () => boundedProbe(() => browser.detach()));
  }
}
