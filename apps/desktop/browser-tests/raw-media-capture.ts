import { expect, type Page } from "@playwright/test";

import type { PlaybackAnchor } from "./known-time";

export type RawFrame = Readonly<{
  id: number;
  display: number;
  now: number;
  media: number;
  presented: number;
  presentation: number;
}>;

export type RawCapture = Readonly<{
  /** Onset mapped to performance time through the output timestamp (absolute output-clock gate). */
  audio: number;
  /** AudioContext render time of the first PCM block over the onset threshold. */
  onsetTime: number;
  anchors: PlaybackAnchor[];
  frames: RawFrame[];
  baseLatency: number;
  outputLatency: number;
  userAgent: string;
}>;

// Plain <video> through the capture worklet: no React, ProgramMonitor, seeks, or retiming.
export async function captureRawPlayback(page: Page, src: string): Promise<RawCapture> {
  await page.goto("/browser-tests/program-monitor-speed.html?parity&speed=100");
  await page.setContent(`<video controls src="${src}"></video><button>Play raw video</button>`);
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
    const anchors: { context: number; media: number; rate: number }[] = [];
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
    // Known-time anchor: context render clock and element media clock in one task.
    video.addEventListener("playing", () =>
      anchors.push({
        context: context.currentTime,
        media: video.currentTime,
        rate: video.playbackRate,
      }),
    );
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
    Object.assign(window, { rawParity: { video, context, blocks, timestamps, frames, anchors } });
    return { ready: true };
  });
  expect(result.ready).toBe(true);
  await page.getByRole("button", { name: "Play raw video" }).click();
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.ended), {
      timeout: 15_000,
    })
    .toBe(true);
  return page.evaluate(async () => {
    const state = (
      window as unknown as {
        rawParity: {
          context: AudioContext;
          blocks: { time: number; samples: number[] }[];
          timestamps: AudioTimestamp[];
          anchors: { context: number; media: number; rate: number }[];
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
      onsetTime: onset.time,
      anchors: state.anchors,
      frames: state.frames,
      baseLatency: state.context.baseLatency,
      outputLatency: state.context.outputLatency,
      userAgent: navigator.userAgent,
    };
    await state.context.close();
    return value;
  });
}
