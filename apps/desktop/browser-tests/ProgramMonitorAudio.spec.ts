import { expect, test, type Page, type TestInfo } from "@playwright/test";
// These tests use a real host audio device. Keep one playback stream at a time
// within this file, without serial-mode fail-fast/skips or global worker changes.
// Other UI files remain parallel; all five independent assertions still execute.
test.describe.configure({ mode: "default" });
async function save(info: TestInfo, name: string, data: unknown) {
  await info.attach(name, { body: JSON.stringify(data, null, 2), contentType: "application/json" });
}

async function capture(page: Page, milliseconds: number) {
  return page.evaluate(async (duration) => {
    const taps = (
      window as unknown as {
        audioTaps: {
          context: AudioContext;
          input: AnalyserNode;
          output: AnalyserNode;
          media: HTMLMediaElement;
        }[];
      }
    ).audioTaps;
    const tap = taps[0]!;
    const rms = (node: AnalyserNode) => {
      const data = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    };
    const result = [];
    const start = performance.now();
    while (performance.now() - start < duration) {
      const input = rms(tap.input),
        output = rms(tap.output);
      result.push({
        contextTime: tap.context.currentTime,
        mediaTime: tap.media.currentTime,
        input,
        output,
        ratio: output / input,
        state: tap.context.state,
        windowSeconds: tap.output.fftSize / tap.context.sampleRate,
        paused: tap.media.paused,
        seeking: tap.media.seeking,
        readyState: tap.media.readyState,
        ended: tap.media.ended,
        visibility: document.visibilityState,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return result;
  }, milliseconds);
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

for (const mode of ["Raw audition", "Final"]) {
  test(`reset effects then ${mode} is actual unity PCM at 1x`, async ({ page }, info) => {
    await page.goto("/browser-tests/ProgramMonitorAudio.html?speed=2");
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Enable fades", exact: true }).click();
    await page.getByRole("button", { name: "Plus six", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(400);
    const baselineSamples = await capture(page, 350);
    await save(info, "baseline-pcm.json", baselineSamples);
    const baseline = mean(baselineSamples.map((s) => s.input));
    expect(baseline).toBeGreaterThan(0.001);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Reset effects", exact: true }).click();
    await page.getByRole("button", { name: mode, exact: true }).click();
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const result = await video.evaluate(async (v: HTMLVideoElement) => {
      // Raw/final intentionally have no production effects graph. Observe their
      // real decoded PCM with one replacement audible path, never two.
      const Native = (window as unknown as { NativeAudioContext: typeof AudioContext })
        .NativeAudioContext;
      const context = new Native();
      await context.resume();
      const source = context.createMediaElementSource(v);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      source.connect(context.destination);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const start = { media: v.currentTime, wall: performance.now() };
      const samples = [];
      for (let i = 0; i < 30; i++) {
        const pcm = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(pcm);
        samples.push(Math.sqrt(pcm.reduce((a, b) => a + b * b, 0) / pcm.length));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const measuredRate =
        (v.currentTime - start.media) / ((performance.now() - start.wall) / 1000);
      const result = {
        samples,
        measuredRate,
        playbackRate: v.playbackRate,
        volume: v.volume,
        muted: v.muted,
      };
      await context.close();
      return result;
    });
    const ratio = mean(result.samples) / baseline;
    console.log(
      JSON.stringify({
        mode,
        baseline,
        rms: mean(result.samples),
        ratio,
        measuredRate: result.measuredRate,
      }),
    );
    await save(info, "raw-final-pcm.json", { mode, baseline, ratio, ...result });
    expect(Math.abs(ratio - 1)).toBeLessThan(0.03);
    expect(result.playbackRate).toBe(1);
    expect(Math.abs(result.measuredRate - 1)).toBeLessThan(0.05);
    expect(result.volume).toBe(1);
    expect(result.muted).toBe(false);
  });
}

for (const [speed, audioOnly] of [
  [1, false],
  [2, false],
  [1, true],
] as const) {
  test(`real PCM gain, linear fades and reset ${speed}x audioOnly=${audioOnly}`, async ({
    page,
  }, info) => {
    await page.goto(
      `/browser-tests/ProgramMonitorAudio.html?speed=${speed}${audioOnly ? "&audioOnly" : ""}`,
    );
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((v: HTMLVideoElement) => v.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    // The fixture never constructs or resumes a context: production owns both.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(400);
    const minus = await capture(page, 450);
    await page.getByRole("button", { name: "Plus six", exact: true }).click();
    await page.waitForTimeout(250);
    const plus = await capture(page, 450);
    await page.getByRole("button", { name: "Reset effects", exact: true }).click();
    await page.waitForTimeout(250);
    const reset = await capture(page, 450);
    await save(info, "gain-input-observations.json", { minus, plus, reset });
    for (const [samples, target] of [
      [minus, 10 ** (-6 / 20)],
      [plus, 10 ** (6 / 20)],
      [reset, 1],
    ] as const) {
      expect(samples.every((s) => s.state === "running" && s.input > 0.001)).toBe(true);
      expect(Math.abs(mean(samples.map((s) => s.ratio)) / target - 1)).toBeLessThan(0.03);
    }
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Enable fades", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeCloseTo(1, 2);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const envelope = await capture(page, 4750);
    // Compare each actual PCM window against its actual media clock midpoint.
    // A linear ramp's window RMS is sqrt(mean(a(t)^2)), not simply its endpoint.
    const windows = envelope
      .filter((s) => {
        const t = (s.mediaTime - 1) / speed;
        return s.input > 0.001 && ((t > 0.35 && t < 1.8) || (t > 3.2 && t < 4.65));
      })
      .map((s) => {
        const t = (s.mediaTime - 1) / speed;
        const midpoint = t - s.windowSeconds / 2;
        const amplitude = midpoint < 2 ? midpoint / 2 : (5 - midpoint) / 2;
        const expected = Math.sqrt(amplitude ** 2 + s.windowSeconds ** 2 / 48);
        return { ...s, t, expected, error: Math.abs(s.ratio - expected) };
      });
    expect(windows.length).toBeGreaterThan(50);
    // One sequence frame at slope 1/2 per second, plus 0.5% PCM/window noise.
    const tolerance = 1 / 30 / 2 + 0.005;
    const earlyIn = mean(windows.filter((s) => s.t < 0.8).map((s) => s.ratio));
    const lateIn = mean(windows.filter((s) => s.t > 1.3 && s.t < 1.8).map((s) => s.ratio));
    const earlyOut = mean(windows.filter((s) => s.t > 3.2 && s.t < 3.7).map((s) => s.ratio));
    const lateOut = mean(windows.filter((s) => s.t > 4.2).map((s) => s.ratio));
    const summary = {
      speed,
      audioOnly,
      minusRms: mean(minus.map((s) => s.output)),
      plusRms: mean(plus.map((s) => s.output)),
      minusRatio: mean(minus.map((s) => s.ratio)),
      plusRatio: mean(plus.map((s) => s.ratio)),
      resetRatio: mean(reset.map((s) => s.ratio)),
      earlyIn,
      lateIn,
      earlyOut,
      lateOut,
      maxEnvelopeError: Math.max(...windows.map((s) => s.error)),
      tolerance,
      windows: windows.length,
    };
    console.log(JSON.stringify(summary));
    await save(info, "actual-pcm.json", { summary, minus, plus, reset, windows });
    expect(lateIn).toBeGreaterThan(earlyIn * 2);
    expect(earlyOut).toBeGreaterThan(lateOut * 2);
    expect(summary.maxEnvelopeError).toBeLessThan(tolerance);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Reset effects", exact: true }).click();
    await page.getByRole("button", { name: "Rewind", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(350);
    const afterFades = await capture(page, 300);
    expect(Math.abs(mean(afterFades.map((s) => s.ratio)) - 1)).toBeLessThan(0.03);
    await save(info, "reset-after-fades.json", afterFades);
  });
}
