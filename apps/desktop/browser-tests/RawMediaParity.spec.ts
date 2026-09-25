import { expect, test } from "@playwright/test";

import { findVisualMarker } from "./visual-marker";

// Diagnostic control: no React, ProgramMonitor, seeks, or retiming. The exact native
// 1x encoded artifact passes sample/frame transient alignment in the Rust test.
test("raw HTML video with capture graph output-clock alignment", async ({ page }, info) => {
  await page.goto("/browser-tests/program-monitor-speed.html?parity&speed=100");
  await page.setContent(
    '<video controls src="/browser-tests/speed-parity-30-1-1-1.mp4"></video><button>Play raw video</button>',
  );
  const result = await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    const context = new AudioContext();
    await context.audioWorklet.addModule("/browser-tests/parity-audio-worklet.js");
    const capture = new AudioWorkletNode(context, "parity-capture");
    context.createMediaElementSource(video).connect(capture).connect(context.destination);
    const blocks: { time: number; samples: number[] }[] = [];
    const timestamps: AudioTimestamp[] = [];
    const frames: {
      id: number;
      display: number;
      now: number;
      media: number;
      presented: number;
      presentation: number;
    }[] = [];
    capture.port.onmessage = (event) => {
      blocks.push(event.data);
      timestamps.push(context.getOutputTimestamp());
    };
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const c = canvas.getContext("2d")!;
    const observe = (now: number, metadata: VideoFrameCallbackMetadata) => {
      c.drawImage(video, 0, 0, 320, 180);
      let id = 0;
      for (let bit = 0; bit < 8; bit++)
        id |= Number(c.getImageData(20 + bit * 40, 90, 1, 1).data[0]! > 128) << bit;
      frames.push({
        id,
        display: metadata.expectedDisplayTime,
        now,
        media: metadata.mediaTime,
        presented: metadata.presentedFrames,
        presentation: metadata.presentationTime,
      });
      video.requestVideoFrameCallback(observe);
    };
    video.requestVideoFrameCallback(observe);
    document.querySelector("button")!.onclick = async () => {
      await context.resume();
      await video.play();
    };
    Object.assign(window, { rawParity: { video, context, blocks, timestamps, frames } });
    return { ready: true };
  });
  expect(result.ready).toBe(true);
  await page.getByRole("button", { name: "Play raw video" }).click();
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.ended))
    .toBe(true);
  const capture = await page.evaluate(async () => {
    const state = (
      window as unknown as {
        rawParity: {
          context: AudioContext;
          blocks: { time: number; samples: number[] }[];
          timestamps: AudioTimestamp[];
          frames: {
            id: number;
            display: number;
            now: number;
            media: number;
            presented: number;
            presentation: number;
          }[];
        };
      }
    ).rawParity;
    const onset = state.blocks.find(
      (b) => b.samples.reduce((s, x) => s + x * x, 0) / b.samples.length > 0.04,
    )!;
    const stamp = state.timestamps
      .filter((t) => t.contextTime! > 0)
      .reduce((best, t) =>
        Math.abs(t.contextTime! - onset.time) < Math.abs(best.contextTime! - onset.time) ? t : best,
      );
    const audio = stamp.performanceTime! + (onset.time - stamp.contextTime!) * 1000;
    const value = {
      audio,
      frames: state.frames,
      baseLatency: state.context.baseLatency,
      outputLatency: state.context.outputLatency,
      userAgent: navigator.userAgent,
    };
    await state.context.close();
    return value;
  });
  const visual = findVisualMarker(capture.frames, 42);
  const measurement = {
    ...capture,
    visual,
    deltaMs: visual ? capture.audio - visual.display : null,
  };
  await info.attach("raw-control.json", {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });
  expect(
    visual,
    "measurement validity: decoded visual frame 42 must be directly observed",
  ).not.toBeNull();
  expect(
    (Math.abs(measurement.deltaMs ?? Infinity) / 1000) * 30,
    "unchanged one-frame output-clock gate, raw browser baseline",
  ).toBeLessThanOrEqual(1);
});
