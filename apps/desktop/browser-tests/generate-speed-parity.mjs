// No dependencies. Regenerates the speed-parity source clips with the exact ffmpeg filters used by
// src-tauri/src/video/tests/speed_export_parity.rs, checks that the existing (gitignored) browser copies decode to
// the same frame identities and audio onset, and writes:
//   - speed-parity-events.json: the known media-time event of every timing clip (read by the specs)
//   - speed-parity-negative-{rn}-{rd}.mp4: negative control whose audio burst is 3 frames late (frame 45)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const ffmpeg = fileURLToPath(
  new URL("../src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe", import.meta.url),
);
const here = fileURLToPath(new URL(".", import.meta.url));
const rates = [
  [30, 1],
  [30000, 1001],
];
const eventFrame = 42;
const negativeAudioFrame = 45;
const burstSeconds = 0.08;
const width = 320;
const height = 180;

function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", ...args], {
    maxBuffer: 1 << 30,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
  return result.stdout;
}

function generate(output, rn, rd, audioFrame) {
  const burst = (audioFrame * rd) / rn;
  run([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=${width}x${height}:r=${rn}/${rd}:d=6,geq=lum='16+219*mod(floor(N/pow(2,floor(X/40))),2)':cb=128:cr=128`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='(0.08+0.72*between(t,${burst.toFixed(9)},${(burst + burstSeconds).toFixed(9)}))*sin(2*PI*1000*t)':s=48000:d=6`,
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    output,
  ]);
  return burst;
}

function frameIds(path) {
  const bytes = run([
    "-i",
    path,
    "-map",
    "0:v:0",
    "-vf",
    "format=gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const size = width * height;
  const ids = [];
  for (let offset = 0; offset + size <= bytes.length; offset += size) {
    let id = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      if (bytes[offset + 90 * width + bit * 40 + 20] > 128) id |= 1 << bit;
    }
    ids.push(id);
  }
  return ids;
}

function audioOnsetSeconds(path) {
  const bytes = run([
    "-i",
    path,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  // Same 2 ms RMS window and threshold as speed_export_parity.rs.
  for (let window = 0; (window + 1) * 96 <= pcm.length; window += 1) {
    let energy = 0;
    for (let i = window * 96; i < (window + 1) * 96; i += 1) energy += pcm[i] * pcm[i];
    if (energy / 96 > 0.04) return window * 0.002;
  }
  throw new Error(`missing audio transient in ${path}`);
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

const scratch = mkdtempSync(join(tmpdir(), "speed-parity-"));
const clips = {};
const report = [];
try {
  for (const [rn, rd] of rates) {
    const frameSeconds = rd / rn;
    const name = `speed-parity-${rn}-${rd}.mp4`;
    const regenerated = join(scratch, name);
    const burst = generate(regenerated, rn, rd, eventFrame);
    const committed = join(here, name);
    const regeneratedIds = frameIds(regenerated);
    const committedIds = frameIds(committed);
    if (!regeneratedIds.every((id, index) => id === index % 256)) {
      throw new Error(`${name}: regenerated frame identities are not sequential`);
    }
    if (!sameIds(regeneratedIds, committedIds)) {
      throw new Error(
        `${name}: existing browser clip frame identities differ from regenerated source`,
      );
    }
    const regeneratedOnset = audioOnsetSeconds(regenerated);
    const committedOnset = audioOnsetSeconds(committed);
    for (const [label, onset] of [
      ["regenerated", regeneratedOnset],
      ["committed", committedOnset],
    ]) {
      if (Math.abs(onset - burst) > frameSeconds) {
        throw new Error(`${name}: ${label} onset ${onset} is not within one frame of ${burst}`);
      }
    }
    clips[name] = {
      fpsNumerator: rn,
      fpsDenominator: rd,
      eventFrame,
      audioEventFrame: eventFrame,
      burstStartSeconds: burst,
      burstEndSeconds: burst + burstSeconds,
    };
    report.push({ name, frames: committedIds.length, committedOnset, regeneratedOnset, burst });

    const negativeName = `speed-parity-negative-${rn}-${rd}.mp4`;
    const negativePath = join(here, negativeName);
    const negativeBurst = generate(negativePath, rn, rd, negativeAudioFrame);
    const negativeOnset = audioOnsetSeconds(negativePath);
    if (!sameIds(frameIds(negativePath), regeneratedIds)) {
      throw new Error(`${negativeName}: video must match the source clip`);
    }
    if (Math.abs(negativeOnset - negativeBurst) > frameSeconds) {
      throw new Error(
        `${negativeName}: onset ${negativeOnset} not within one frame of ${negativeBurst}`,
      );
    }
    clips[negativeName] = {
      fpsNumerator: rn,
      fpsDenominator: rd,
      eventFrame,
      audioEventFrame: negativeAudioFrame,
      burstStartSeconds: negativeBurst,
      burstEndSeconds: negativeBurst + burstSeconds,
    };
    report.push({ name: negativeName, committedOnset: negativeOnset, burst: negativeBurst });
  }
  writeFileSync(join(here, "speed-parity-events.json"), `${JSON.stringify({ clips }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
