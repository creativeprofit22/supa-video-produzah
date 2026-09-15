import { expect, test } from "@playwright/test";

for (const percent of [50, 100, 150, 200]) {
  test(`real ProgramMonitor ${percent}% clock, decoded frames, pitch, seek and end`, async ({
    page,
  }, info) => {
    await page.goto(`/browser-tests/program-monitor-speed.html?speed=${percent}`);
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Seek program 1s", exact: true }).click();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(1 + percent / 100, 2);
    // WebAudio observes actual decoded, rate-adjusted media output, not a synthetic oscillator.
    await video.evaluate(async (v: HTMLVideoElement) => {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaElementSource(v);
      const analyser = context.createAnalyser();
      analyser.fftSize = 32768;
      source.connect(analyser);
      analyser.connect(context.destination);
      const state = {
        context,
        analyser,
        frames: [] as { time: number; presented: number; program: number }[],
      };
      Object.assign(window, { speedCapture: state });
      const observe = (_: number, metadata: VideoFrameCallbackMetadata) => {
        state.frames.push({
          time: metadata.mediaTime,
          presented: metadata.presentedFrames,
          program: Number(document.querySelector('[data-testid="program-frame"]')?.textContent),
        });
        v.requestVideoFrameCallback(observe);
      };
      v.requestVideoFrameCallback(observe);
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const measurement = await video.evaluate(async (v: HTMLVideoElement) => {
      const state = (
        window as unknown as {
          speedCapture: { context: AudioContext; analyser: AnalyserNode; frames: unknown[] };
        }
      ).speedCapture;
      await new Promise((resolve) => setTimeout(resolve, 350)); // exclude onset and seek transients
      const start = {
        media: v.currentTime,
        wall: performance.now(),
        program: Number(document.querySelector('[data-testid="program-frame"]')?.textContent),
      };
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const spectrum = new Float32Array(state.analyser.frequencyBinCount);
      state.analyser.getFloatFrequencyData(spectrum);
      let peak = 1;
      for (let i = 2; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peak]!) peak = i;
      return {
        start,
        end: {
          media: v.currentTime,
          wall: performance.now(),
          program: Number(document.querySelector('[data-testid="program-frame"]')?.textContent),
        },
        pitchHz: (peak * state.context.sampleRate) / state.analyser.fftSize,
        peakDb: spectrum[peak],
        playbackRate: v.playbackRate,
        preservesPitch: v.preservesPitch,
        frames: state.frames,
      };
    });
    await info.attach("real-media-measurements.json", {
      body: JSON.stringify(measurement, null, 2),
      contentType: "application/json",
    });
    const wall = (measurement.end.wall - measurement.start.wall) / 1000;
    expect(measurement.playbackRate).toBe(percent / 100);
    expect(measurement.preservesPitch).toBe(true);
    expect(
      Math.abs((measurement.end.media - measurement.start.media) / wall - percent / 100),
    ).toBeLessThan(0.08);
    expect(
      Math.abs((measurement.end.program - measurement.start.program) / 30 - wall),
    ).toBeLessThan(2 / 30);
    expect(measurement.frames.length).toBeGreaterThan(10);
    expect(measurement.peakDb).toBeGreaterThan(-60);
    expect(Math.abs(measurement.pitchHz - 1000) / 1000).toBeLessThan(0.01);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.waitForTimeout(200);
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(paused, 3);
    await page.getByRole("button", { name: "Seek near end", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByTestId("program-frame")).toHaveText(String(18000 / percent - 1));
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(
      7 - percent / 100 / 30,
      2,
    );
    await page.screenshot({ path: info.outputPath("program-monitor.png") });
    await page.getByRole("button", { name: "Final", exact: true }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1);
    expect(await video.evaluate((v: HTMLVideoElement) => v.preservesPitch)).toBe(true);
  });
}

test("final playback and wrong-speed pitch-shift measurement controls", async ({ page }, info) => {
  await page.goto("/browser-tests/program-monitor-speed.html?speed=200");
  await page.getByRole("button", { name: "Final", exact: true }).click();
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const result = await video.evaluate(async (v: HTMLVideoElement) => {
    const context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 32768;
    context.createMediaElementSource(v).connect(analyser);
    analyser.connect(context.destination);
    const measure = async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const start = v.currentTime;
      const wall = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 1;
      for (let i = 2; i < bins.length; i++) if (bins[i]! > bins[peak]!) peak = i;
      return {
        ratio: (v.currentTime - start) / ((performance.now() - wall) / 1000),
        pitchHz: (peak * context.sampleRate) / analyser.fftSize,
        peakDb: bins[peak],
      };
    };
    const final = await measure();
    // Deliberate measurement control only: never a production preview setting.
    v.playbackRate = 2;
    v.preservesPitch = false;
    const wrong = await measure();
    await context.close();
    return { final, wrong };
  });
  await info.attach("controls.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(Math.abs(result.final.ratio - 1)).toBeLessThan(0.08);
  expect(Math.abs(result.final.pitchHz - 1000) / 1000).toBeLessThan(0.01);
  expect(result.wrong.peakDb).toBeGreaterThan(-60);
  expect(Math.abs(result.wrong.ratio - 2)).toBeLessThan(0.08);
  expect(Math.abs(result.wrong.pitchHz - 2000) / 2000).toBeLessThan(0.01);
  expect(Math.abs(result.wrong.ratio - 1)).toBeGreaterThan(0.08);
  expect(Math.abs(result.wrong.pitchHz - 1000) / 1000).toBeGreaterThan(0.01);
});

test("raw source audition stays 1x despite speed metadata", async ({ page }) => {
  await page.goto("/browser-tests/program-monitor-speed.html?speed=200&raw");
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const result = await video.evaluate(async (v: HTMLVideoElement) => {
    const start = v.currentTime;
    const wall = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      ratio: (v.currentTime - start) / ((performance.now() - wall) / 1000),
      rate: v.playbackRate,
      pitch: v.preservesPitch,
    };
  });
  expect(result.rate).toBe(1);
  expect(result.pitch).toBe(true);
  expect(Math.abs(result.ratio - 1)).toBeLessThan(0.08);
});
