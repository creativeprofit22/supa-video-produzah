// Offline synthetic media only. Never launches a browser or an audio capture process.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const cases = [
  [30, 1],
  [30000, 1001],
].flatMap(([rn, rd]) =>
  [
    [1, 2],
    [1, 1],
    [3, 2],
    [2, 1],
  ].map(([sn, sd]) => ({ rn, rd, sn, sd, percent: (100 * sn) / sd })),
);
export const mediaRoot = path.resolve("apps/desktop/browser-tests/completion-media");
export const stem = ({ rn, rd }) => `single-flash-${rn}-${rd}`;
export const key = (c) => `${stem(c)}-${c.sn}-${c.sd}`;
export function tools() {
  const root = path.resolve("apps/desktop/src-tauri/media-toolchain");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.v1.json")));
  return Object.fromEntries(
    ["ffmpeg", "ffprobe"].map((name) => {
      const executable = path.join(root, "bin/x86_64-pc-windows-msvc", name + ".exe");
      const bytes = fs.readFileSync(executable),
        expected = manifest.targets["x86_64-pc-windows-msvc"].binaries[name];
      if (bytes.length !== expected.byteLength || hash(bytes) !== expected.sha256)
        throw Error("Tool manifest mismatch");
      return [name, executable];
    }),
  );
}
export const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exec = (cmd, args) => execFileSync(cmd, args, { timeout: 30000, maxBuffer: 30e6 });
export function pitch(samples, rate = 48000) {
  // Interior of the single tone, excluding codec/envelope boundaries; no audio path changes.
  const active = samples.flatMap((v, i) => (Math.abs(v) > 0.02 ? [i] : []));
  if (!active.length) return NaN;
  const lo = active[0] + Math.round(rate * 0.02),
    hi = active.at(-1) - Math.round(rate * 0.02);
  const crossings = [];
  for (let i = lo + 1; i < hi; i++)
    if (samples[i - 1] <= 0 && samples[i] > 0)
      crossings.push(i - 1 - samples[i - 1] / (samples[i] - samples[i - 1]));
  return crossings.length >= 20
    ? ((crossings.length - 1) * rate) / (crossings.at(-1) - crossings[0])
    : NaN;
}
export function decode(file, expectedFrames, c) {
  const { ffmpeg, ffprobe } = tools();
  const probe = JSON.parse(exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", file]));
  const video = exec(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "scale=1:1",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const pcm = exec(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  const samples = Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4));
  const flashes = [],
    sounds = [];
  let last = -Infinity;
  for (let i = 1; i < video.length; i++)
    if (video[i] > 200 && video[i - 1] < 50) flashes.push((i * c.rd) / c.rn);
  samples.forEach((v, i) => {
    if (Math.abs(v) > 0.005) {
      if (i - last > 4800) sounds.push(i / 48000);
      last = i;
    }
  });
  const hz = pitch(samples),
    frameMs = (1000 * c.rd) / c.rn;
  const result = {
    file,
    sha256: hash(fs.readFileSync(file)),
    frames: video.length,
    flashes,
    sounds,
    hz,
    deltaMs: (sounds[0] - flashes[0]) * 1000,
    frameMs,
    streams: probe.streams,
  };
  result.structurallyValid =
    video.length === expectedFrames &&
    flashes.length === 1 &&
    sounds.length === 1 &&
    probe.streams.find((s) => s.codec_type === "video").avg_frame_rate === `${c.rn}/${c.rd}`;
  result.pitchPass = Number.isFinite(hz) && Math.abs(hz - 1000) <= 10;
  result.timingPass = Number.isFinite(result.deltaMs) && Math.abs(result.deltaMs) <= frameMs;
  result.valid = result.structurallyValid && result.pitchPass && result.timingPass;
  return result;
}
export function generate(outputRoot = mediaRoot) {
  // Refuse overwriting an earlier generation; retain failed artifacts for inspection.
  fs.mkdirSync(outputRoot);
  const { ffmpeg } = tools(),
    results = [];
  for (const c of cases) {
    const input = path.join(outputRoot, stem(c) + ".mp4"),
      output = path.join(outputRoot, key(c) + ".mp4");
    if (c.percent === 50) {
      const onset = (42 * c.rd) / c.rn,
        end = (48 * c.rd) / c.rn;
      exec(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=320x180:r=${c.rn}/${c.rd}:d=6.006,drawbox=c=white:t=fill:enable='gte(t,${onset})*lt(t,${end})'`,
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='if(between(t,${onset},${end}),0.25*sin(2*PI*1000*(t-${onset})),0)':s=48000:d=6.006`,
        "-frames:v",
        "180",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        input,
      ]);
      results.push(decode(input, 180, c));
    }
    const plan = JSON.parse(
      exec(process.execPath, [
        "apps/desktop/browser-tests/compile-speed-export.mjs",
        input,
        output,
        ...[c.rn, c.rd, c.sn, c.sd].map(String),
      ]),
    );
    fs.writeFileSync(path.join(outputRoot, key(c) + ".plan.json"), JSON.stringify(plan, null, 2));
    if (plan.executable !== "ffmpeg" || !Array.isArray(plan.argv))
      throw Error("Unexpected compiler output");
    exec(ffmpeg, plan.argv); // Exact production-compiled argv, never reconstructed.
    results.push(decode(output, 60, c));
  }
  fs.writeFileSync(path.join(outputRoot, "decoded.json"), JSON.stringify(results, null, 2));
  if (results.some((r) => !r.valid))
    throw Error("Decoded media gate failed; retain and inspect decoded.json");
  return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--generate") generate();
  else if (process.argv[2] === "--generate-slow-onset")
    generate(path.join(mediaRoot, "slow-onset"));
  else if (process.argv[2] === "--check-decoded") {
    const results = cases.flatMap((c) => [
      ...(c.percent === 50 ? [decode(path.join(mediaRoot, stem(c) + ".mp4"), 180, c)] : []),
      decode(path.join(mediaRoot, key(c) + ".mp4"), 60, c),
    ]);
    const directory = fs.mkdtempSync(path.join(mediaRoot, "decode-check-"));
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
    console.log(directory);
    if (results.some((r) => !r.valid))
      throw Error("Decoded parity failed; see retained results (no tolerance changes)");
  } else throw Error("Use --generate, --generate-slow-onset or --check-decoded (offline only)");
}
