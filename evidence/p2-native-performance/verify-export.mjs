import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import console from "node:console";
const [baselinePath, releasePath] = process.argv.slice(2);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")),
  release = JSON.parse(readFileSync(releasePath, "utf8"));
assert.equal(baseline.status, "passed");
assert.equal(release.status, "passed");
const runs = realpathSync(fileURLToPath(new URL("./runs/", import.meta.url)));
const output = realpathSync(baseline.exportProbeArgv.at(-1));
const relative = path.relative(runs, output);
assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
assert.equal(sha(output), baseline.exportSha256);
const ffprobe = path.join(path.dirname(release.executable), "media-tools/ffprobe.exe");
assert.equal(
  sha(ffprobe),
  release.resources.find((r) => r.path === "media-tools/ffprobe.exe").sha256,
);
const args = [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_frames",
  "-show_entries",
  "frame=nb_samples:stream=sample_rate,channels",
  "-of",
  "json",
  output,
];
const audio = JSON.parse(
  execFileSync(ffprobe, args, { encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 }),
);
assert.equal(audio.streams.length, 1);
assert.equal(Number(audio.streams[0].sample_rate), 48000);
const samples = audio.frames.reduce((sum, frame) => {
  assert.ok(Number.isInteger(frame.nb_samples) && frame.nb_samples > 0);
  return sum + frame.nb_samples;
}, 0);
const sequence = baseline.project.projection.state.sequences[0];
const expectedFrames = sequence.tracks[0].clips[0].sourceOut.value;
const expectedSamples =
  (expectedFrames * sequence.rate.denominator * 48000) / sequence.rate.numerator;
const samplesPerFrame = (48000 * sequence.rate.denominator) / sequence.rate.numerator;
// Preserve the baseline's one sequence-frame duration assertion, including AAC padding.
assert.ok(Math.abs(samples - expectedSamples) <= samplesPerFrame);
console.log(
  JSON.stringify({
    utc: new Date().toISOString(),
    outputSha256: baseline.exportSha256,
    argv: [ffprobe, ...args],
    exitCode: 0,
    decodedAudioSamples: samples,
    expectedTimelineSamples: expectedSamples,
    differenceSamples: samples - expectedSamples,
    toleranceSamples: samplesPerFrame,
    sampleRate: 48000,
    scope:
      "decoded output frame/duration/sample accounting, not live A/V synchronization or physical display proof",
  }),
);
