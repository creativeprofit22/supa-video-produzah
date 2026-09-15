import { createRequire } from "node:module";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Local synthetic media only. No device microphone or private media capture.
const require = createRequire(resolve("apps/desktop/package.json"));
const { chromium } = require("@playwright/test");
const ffmpeg = resolve(
  "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe",
);
const generated = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=8",
    "-f",
    "wav",
    "pipe:1",
  ],
  { maxBuffer: 4 * 1024 * 1024 },
);
if (generated.status !== 0)
  throw new Error(generated.stderr?.toString() || "Tone generation failed");
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  const results = await page.evaluate(
    async (url) => {
      const results = [];
      for (const preservesPitch of [true, false]) {
        for (const rate of [0.5, 1, 1.5, 2]) {
          const media = new globalThis.Audio(url);
          if (!("preservesPitch" in media)) throw new Error("Pitch preservation unsupported");
          media.preservesPitch = preservesPitch;
          media.playbackRate = rate;
          const context = new globalThis.AudioContext();
          const source = context.createMediaElementSource(media);
          const analyser = context.createAnalyser();
          analyser.fftSize = 32768;
          source.connect(analyser);
          analyser.connect(context.destination);
          try {
            await context.resume();
            await media.play();
            const start = media.currentTime;
            const wallStart = globalThis.performance.now();
            await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
            const actualRate =
              (media.currentTime - start) / ((globalThis.performance.now() - wallStart) / 1000);
            const bins = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(bins);
            let peak = 1;
            for (let i = 2; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
            const frequency = (peak * context.sampleRate) / analyser.fftSize;
            results.push({ rate, preservesPitch, actualRate, frequency, peakDb: bins[peak] });
          } finally {
            media.pause();
            source.disconnect();
            analyser.disconnect();
            await context.close();
            media.removeAttribute("src");
            media.load();
          }
        }
      }
      return results;
    },
    `data:audio/wav;base64,${generated.stdout.toString("base64")}`,
  );
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
  for (const result of results) {
    const expected = 440 * (result.preservesPitch ? 1 : result.rate);
    if (Math.abs(result.frequency / expected - 1) > 0.01 || result.peakDb < -80)
      throw new Error(`Pitch measurement failed: ${JSON.stringify(result)}`);
    if (Math.abs(result.actualRate / result.rate - 1) > 0.1)
      throw new Error(`Playback timing failed: ${JSON.stringify(result)}`);
  }
} finally {
  await browser.close();
}
