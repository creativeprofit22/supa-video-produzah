// Offline decoder diagnostics only: stdout PCM never reaches an audio device.
import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tools, pitch, mediaRoot, hash, cases, stem } from "./step8-media.mjs";
const { ffmpeg } = tools();
const output = fs.mkdtempSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-tempo-"),
);
const source = path.join(mediaRoot, "single-flash-30-1.mp4");
const final = path.join(mediaRoot, "single-flash-30-1-1-2.mp4");
const filter = "atrim=duration=1.000000,asetpts=PTS-STARTPTS";
const tail = ["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"];
const inputs = ["-ss", "1.000000", "-t", "1.000000", "-i", source];
const clean = [
  "-f",
  "lavfi",
  "-i",
  "aevalsrc='if(between(t,0.4,0.6),0.25*sin(2*PI*1000*(t-0.4)),0)':s=48000:d=1",
];
function measure(name, input, audioFilter) {
  const argv = [
    "-v",
    "error",
    "-nostdin",
    ...input,
    ...(audioFilter ? ["-af", audioFilter] : []),
    ...tail,
  ];
  const bytes = execFileSync(ffmpeg, argv, { maxBuffer: 2e6 });
  const samples = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
  const first = samples.findIndex((s) => Math.abs(s) > 0.005);
  const last = samples.findLastIndex((s) => Math.abs(s) > 0.005);
  return {
    name,
    argv,
    pcmSha256: hash(bytes),
    sampleCount: samples.length,
    firstSeconds: first / 48000,
    lastSeconds: last / 48000,
    pitchHz: pitch(samples),
  };
}
const results = [
  measure("trimmed-source-no-tempo", inputs, filter + ",atrim=duration=2.000000"),
  measure(
    "trimmed-source-production-tempo-before-encoder",
    inputs,
    filter + ",atempo=0.50,atrim=duration=2.000000",
  ),
  measure("production-export-after-AAC", ["-i", final]),
  measure("clean-synthetic-PCM-no-tempo", clean, filter),
  measure(
    "clean-synthetic-PCM-production-tempo",
    clean,
    filter + ",atempo=0.50,atrim=duration=2.000000",
  ),
  measure(
    "clean-synthetic-PCM-bundled-rubberband-probe",
    clean,
    filter + ",rubberband=tempo=0.50,atrim=duration=2.000000",
  ),
  measure(
    "clean-synthetic-PCM-rubberband-short-window-probe",
    clean,
    filter + ",rubberband=tempo=0.50:window=short,atrim=duration=2.000000",
  ),
];
for (const c of cases) {
  const speed = c.sn / c.sd;
  const sourceDuration = ((60 * c.rd) / c.rn) * speed;
  const outputDuration = (60 * c.rd) / c.rn;
  const input = [
    "-ss",
    ((30 * c.rd) / c.rn).toFixed(6),
    "-t",
    sourceDuration.toFixed(6),
    "-i",
    path.join(mediaRoot, stem(c) + ".mp4"),
  ];
  const row = measure(
    `rubberband-short-${c.rn}-${c.rd}-${c.percent}`,
    input,
    `atrim=duration=${sourceDuration.toFixed(6)},asetpts=PTS-STARTPTS,rubberband=tempo=${speed}:window=short,atrim=duration=${outputDuration.toFixed(6)}`,
  );
  row.expectedFirst = (12 * c.rd) / c.rn / speed;
  row.expectedLast = (18 * c.rd) / c.rn / speed;
  row.firstErrorMs = (row.firstSeconds - row.expectedFirst) * 1000;
  row.lastErrorMs = (row.lastSeconds - row.expectedLast) * 1000;
  row.timingPitchPass =
    Math.abs(row.firstErrorMs) <= (1000 * c.rd) / c.rn &&
    Math.abs(row.lastErrorMs) <= (1000 * c.rd) / c.rn &&
    Math.abs(row.pitchHz - 1000) <= 10;
  results.push(row);
}
fs.writeFileSync(
  path.join(output, "results.json"),
  JSON.stringify(
    {
      recordingPerformed: false,
      sourceSha256: hash(fs.readFileSync(source)),
      finalSha256: hash(fs.readFileSync(final)),
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, results }, null, 2));
