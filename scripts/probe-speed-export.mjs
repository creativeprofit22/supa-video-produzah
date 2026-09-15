// Step-6 filter capability measurement, not production preview/export parity proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { resolve } from "node:path";

const ffmpeg = resolve(
  "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe",
);
function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
function measureAudio(pcm) {
  assert.equal(pcm.length % 4, 0);
  const samples = pcm.length / 4;
  // Count positive zero crossings in the middle, excluding algorithm edges.
  const start = Math.floor(samples / 4);
  const end = Math.floor((samples * 3) / 4);
  let crossings = 0;
  for (let i = start + 1; i < end; i += 1) {
    if (pcm.readFloatLE((i - 1) * 4) <= 0 && pcm.readFloatLE(i * 4) > 0) crossings += 1;
  }
  return { samples, seconds: samples / 48_000, frequencyHz: (crossings * 48_000) / (end - start) };
}
const results = [];
for (const [numerator, denominator] of [
  [1, 2],
  [1, 1],
  [3, 2],
  [2, 1],
]) {
  const speed = numerator / denominator;
  const sourceDuration = 2 * speed;
  const sourceFrames = sourceDuration * 30;
  const audioArgs = [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${sourceDuration}`,
  ];
  const core = `atrim=duration=${sourceDuration.toFixed(6)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(2)}`;
  const unbounded = measureAudio(run([...audioArgs, "-af", core, "-f", "f32le", "pipe:1"]));
  const bounded = measureAudio(
    run([...audioArgs, "-af", `${core},atrim=duration=2.000000`, "-f", "f32le", "pipe:1"]),
  );
  const video = run([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=16x16:rate=30:duration=${sourceDuration}`,
    "-vf",
    `trim=end_frame=${sourceFrames},setpts=PTS-STARTPTS,setpts=PTS*${denominator}/${numerator},fps=30/1`,
    "-t",
    "2.000000",
    "-an",
    "-f",
    "framemd5",
    "pipe:1",
  ]).toString();
  const videoFrames = video.split("\n").filter((line) => /^0,/.test(line)).length;
  assert.equal(videoFrames, 60);
  assert.ok(Math.abs(bounded.frequencyHz - 440) / 440 <= 0.01, "pitch capability exceeds 1%");
  assert.ok(bounded.samples <= 96_000, "upper-bound trim must not exceed requested duration");
  // Report deficits; do not conceal them with padding or a loose duration assertion.
  results.push({
    speed,
    sourceFrames,
    videoFrames,
    unbounded,
    bounded,
    deficitSamples: 96_000 - bounded.samples,
  });
}
console.log(
  JSON.stringify(
    { scope: "synthetic bundled filter measurement; no A/V parity claim", results },
    null,
    2,
  ),
);
