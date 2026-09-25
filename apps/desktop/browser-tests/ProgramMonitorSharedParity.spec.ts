import { expect, test, type Page } from "@playwright/test";

import { findVisualMarker } from "./visual-marker";

async function ready(page: Page) {
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
}
async function seekId(page: Page, frame: number) {
  // External playhead changes only synchronize composition layers; use the real
  // transport command to seek both composition and final media.
  await page.getByTestId("parity-seek").fill(String(frame === 0 ? 1 : frame - 1));
  await page
    .getByRole("button", {
      name: frame === 0 ? "Step backward one frame" : "Step forward one frame",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("program-frame")).toHaveText(String(frame));
  // Wait for the actual seek/decode, not just React's playhead label.
  await page.waitForTimeout(120);
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2),
    )
    .toBe(true);
  return page.locator("video").evaluate((v: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const c = canvas.getContext("2d")!;
    c.drawImage(v, 0, 0, 320, 180);
    let id = 0;
    for (let bit = 0; bit < 8; bit++)
      id |= Number(c.getImageData(20 + bit * 40, 90, 1, 1).data[0]! > 128) << bit;
    return {
      id,
      time: v.currentTime,
      src: v.currentSrc,
      rate: v.playbackRate,
      duration: v.duration,
    };
  });
}

for (const fractional of [false, true])
  for (const percent of [50, 100, 150, 200]) {
    const speed = percent / 100;
    const fps = fractional ? 30000 / 1001 : 30;
    const url = `/browser-tests/program-monitor-speed.html?parity&speed=${percent}${fractional ? "&fractional" : ""}`;
    const label = `${fractional ? "30000/1001" : "30/1"} ${percent}%`;
    test(`${label} decoded seeks match canonical mapping and native export`, async ({
      page,
    }, info) => {
      await page.goto(url);
      await ready(page);
      const rows = [];
      for (const frame of [0, 1, 7, 15, 29, 30, 43, 58, 59]) {
        rows.push({
          frame,
          preview: await seekId(page, frame),
          final: null as Awaited<ReturnType<typeof seekId>> | null,
        });
      }
      await page.getByRole("button", { name: "Final", exact: true }).click();
      await ready(page);
      for (const row of rows) row.final = await seekId(page, row.frame);
      await info.attach("decoded-seek-parity.json", {
        body: JSON.stringify(rows, null, 2),
        contentType: "application/json",
      });
      for (const { frame, preview, final } of rows) {
        expect
          .soft(Math.abs((preview.id - 30) / speed - frame), `preview frame ${frame}`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(Math.abs((final!.id - 30) / speed - frame), `export frame ${frame}`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(Math.abs(preview.id - final!.id) / speed, `preview/export frame ${frame}`)
          .toBeLessThanOrEqual(1);
        expect.soft(final!.src).not.toBe(preview.src);
        expect.soft(final!.rate).toBe(1);
        expect.soft(Math.abs(final!.duration * fps - 60)).toBeLessThanOrEqual(1);
      }
    });
    for (const final of [false, true])
      test(`${label} ${final ? "final" : "preview"} live PCM pitch and aligned transient`, async ({
        page,
      }, info) => {
        await page.goto(url);
        if (final) await page.getByRole("button", { name: "Final", exact: true }).click();
        await ready(page);
        await seekId(page, 0);
        await page.locator("video").evaluate(async (v: HTMLVideoElement) => {
          const context = new AudioContext();
          await context.audioWorklet.addModule("/browser-tests/parity-audio-worklet.js");
          const capture = new AudioWorkletNode(context, "parity-capture");
          context.createMediaElementSource(v).connect(capture).connect(context.destination);
          await context.resume();
          const state = {
            context,
            blocks: [] as { time: number; samples: number[] }[],
            frames: [] as { id: number; display: number; media: number }[],
            timestamps: [] as AudioTimestamp[],
          };
          capture.port.onmessage = (event) => {
            state.blocks.push(event.data);
            state.timestamps.push(context.getOutputTimestamp());
          };
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 180;
          const c = canvas.getContext("2d")!;
          const observe = (_: number, metadata: VideoFrameCallbackMetadata) => {
            c.drawImage(v, 0, 0, 320, 180);
            let id = 0;
            for (let bit = 0; bit < 8; bit++)
              id |= Number(c.getImageData(20 + bit * 40, 90, 1, 1).data[0]! > 128) << bit;
            state.frames.push({
              id,
              display: metadata.expectedDisplayTime,
              media: metadata.mediaTime,
            });
            v.requestVideoFrameCallback(observe);
          };
          v.requestVideoFrameCallback(observe);
          Object.assign(window, { parityCapture: state });
        });
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await expect(page.getByTestId("program-frame")).toHaveText("59", { timeout: 10_000 });
        // The last frame is visible for a full frame interval before playback stops.
        // Wait for the actual media state before closing the capture context.
        await expect
          .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused))
          .toBe(true);
        const result = await page.locator("video").evaluate(async (v: HTMLVideoElement) => {
          const state = (
            window as unknown as {
              parityCapture: {
                context: AudioContext;
                blocks: { time: number; samples: number[] }[];
                frames: { id: number; display: number; media: number }[];
                timestamps: AudioTimestamp[];
              };
            }
          ).parityCapture;
          const sampleRate = state.context.sampleRate;
          const onsetBlock = state.blocks.find(
            (b) => b.samples.reduce((s, x) => s + x * x, 0) / b.samples.length > 0.04,
          );
          const stamp =
            onsetBlock &&
            state.timestamps
              .filter((t) => t.contextTime! > 0)
              .reduce<AudioTimestamp | undefined>(
                (best, t) =>
                  !best ||
                  Math.abs(t.contextTime! - onsetBlock.time) <
                    Math.abs(best.contextTime! - onsetBlock.time)
                    ? t
                    : best,
                undefined,
              );
          const audioDisplay =
            onsetBlock && stamp
              ? stamp.performanceTime! + (onsetBlock.time - stamp.contextTime!) * 1000
              : null;
          // Stable tone after all bursts, before clip end. Count actual PCM crossings.
          const active = state.blocks.find((b) => b.samples.some((x) => Math.abs(x) > 0.01));
          const tone = state.blocks
            .filter((b) => active && b.time >= active.time + 1.1 && b.time < active.time + 1.7)
            .flatMap((b) => b.samples);
          let crossings = 0;
          for (let i = 1; i < tone.length; i++) if (tone[i - 1]! <= 0 && tone[i]! > 0) crossings++;
          // This capture reroutes playback through Web Audio. Preserve its latency
          // in the receipt; do not subtract it from the output-clock acceptance gate.
          const measurement = {
            baseLatency: state.context.baseLatency,
            outputLatency: state.context.outputLatency,
            audioDisplay,
            onsetTime: onsetBlock?.time,
            stamp,
            sampleRate,
            toneSamples: tone.length,
            pitchHz: (crossings * sampleRate) / (tone.length - 1),
            frames: state.frames,
            rate: v.playbackRate,
            preservesPitch: v.preservesPitch,
            src: v.currentSrc,
            paused: v.paused,
          };
          await state.context.close();
          return measurement;
        });
        const visual = findVisualMarker(result.frames, 42);
        const visualDisplay = visual?.display ?? null;
        const avFrames =
          result.audioDisplay !== null && visualDisplay !== null
            ? (Math.abs(result.audioDisplay - visualDisplay) / 1000) * fps
            : null;
        await info.attach("live-shared-parity.json", {
          body: JSON.stringify({ ...result, visualDisplay, avFrames }, null, 2),
          contentType: "application/json",
        });
        expect.soft(result.rate).toBe(final ? 1 : speed);
        expect.soft(result.preservesPitch).toBe(true);
        expect.soft(result.frames.length).toBeGreaterThan(10);
        expect.soft(result.toneSamples).toBeGreaterThan(result.sampleRate / 2);
        expect.soft(Math.abs(result.pitchHz / 1000 - 1)).toBeLessThanOrEqual(0.01);
        expect.soft(result.audioDisplay, "decoded audio transient must be observed").not.toBeNull();
        expect(
          visual,
          "measurement validity: decoded visual frame 42 must be directly observed",
        ).not.toBeNull();
        expect
          .soft(
            avFrames ?? Infinity,
            "actual output-clock aligned transient within one sequence frame",
          )
          .toBeLessThanOrEqual(1);
        expect.soft(result.paused).toBe(true);
        if (final) expect.soft(result.src).toMatch(/speed-parity-\d+-\d+-\d+-\d+\.mp4$/);
      });
  }
