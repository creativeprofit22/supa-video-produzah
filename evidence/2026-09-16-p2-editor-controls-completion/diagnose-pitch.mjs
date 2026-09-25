// Independent offline diagnosis; does not alter the existing pitch gate or its data.
import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tools, hash } from "./step8-media.mjs";
const ffmpeg = tools().ffmpeg;
const root = fs.mkdtempSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-pitch-"),
);
const files = ["speed-parity-30-1-1-2.mp4", "speed-parity-30000-1001-1-2.mp4"];
const results = [];
for (const name of files) {
  const input = path.join("C:/Users/SPARTA~1/AppData/Local/Temp/.tmpFok7YA", name);
  const bytes = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 2e6 },
  );
  const samples = Array.from({ length: bytes.length / 4 }, (_, i) =>
    bytes.readFloatLE(i * 4),
  ).slice(12000, -12000);
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
  const weighted = samples.map(
    (s, i) => s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1))),
  );
  const spectrum = [];
  for (let hz = 900; hz <= 1100; hz += 0.25) {
    const coefficient = 2 * Math.cos((2 * Math.PI * hz) / 48000);
    let previous = 0,
      previous2 = 0;
    for (const sample of weighted) {
      const value = sample + coefficient * previous - previous2;
      previous2 = previous;
      previous = value;
    }
    spectrum.push({
      hz,
      power: previous * previous + previous2 * previous2 - coefficient * previous * previous2,
    });
  }
  spectrum.sort((a, b) => b.power - a.power);
  const localCounts = [];
  for (let start = 0; start + 4800 <= samples.length; start += 4800) {
    let count = 0;
    for (let i = start + 1; i < start + 4800; i++)
      if (samples[i - 1] <= 0 && samples[i] > 0) count++;
    localCounts.push((count * 48000) / 4799);
  }
  results.push({
    input,
    sha256: hash(fs.readFileSync(input)),
    originalGateHz: (crossings * 48000) / (samples.length - 1),
    local100msCountsHz: localCounts,
    dominantPeaks: spectrum.slice(0, 12),
  });
}
fs.writeFileSync(
  path.join(root, "results.json"),
  JSON.stringify({ recordingPerformed: false, results }, null, 2),
);
console.log(JSON.stringify({ root, results }, null, 2));
