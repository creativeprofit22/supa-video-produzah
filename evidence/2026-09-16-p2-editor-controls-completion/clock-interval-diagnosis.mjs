// Offline diagnosis only. Retains the original six-timestamp result and all source bytes.
import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, "capture-nDAhAy");
const output = fs.mkdtempSync(path.join(root, "capture-clock-diagnosis-"));
const original = JSON.parse(fs.readFileSync(path.join(source, "results.json"), "utf8"));
const results = [];
for (const condition of ["sync", "late", "early"]) {
  const file = path.join(source, condition, "visual/frames.csv");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 1e6) throw Error("Frame input bound");
  const rows = bytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",").map(Number));
  if (
    !rows.length ||
    rows.length > 4096 ||
    rows.some((r) => r.length !== 8 || !r.every(Number.isFinite))
  )
    throw Error("Frame shape bound");
  const clock = fs.readFileSync(path.join(source, condition, "visual/clock.txt"), "utf8");
  const frequency = Number(/^qpcFrequency=(\d+)$/m.exec(clock.replace(/\r/g, ""))?.[1]);
  if (!Number.isSafeInteger(frequency) || frequency <= 0) throw Error("Invalid QPC frequency");
  const offsets = rows.map((r) => (r[1] / 1e7 - r[3] / frequency) * 1000);
  const acquiredOffsets = rows.map((r) => (r[1] / 1e7 - r[2] / frequency) * 1000);
  const observation = original.results.find((r) => r.name === condition);
  if (observation.sounds.length !== 1 || observation.visualOnsets.length !== 1)
    throw Error("Unexpected event count");
  const event = observation.visualOnsets[0],
    audio = observation.sounds[0].onsetSeconds;
  const previous = rows.find((r) => r[0] === event.previousIndex),
    current = rows.find((r) => r[0] === event.currentIndex);
  if (!previous || !current) throw Error("Missing referenced frame");
  const interval = (lo, hi) => [(audio - hi) * 1000 - 1, (audio - lo) * 1000 + 1];
  results.push({
    condition,
    frames: rows.length,
    originalClassification: observation.classification,
    originalSixTimestampIntervalMs: observation.audioMinusVisualMs,
    futureDatedRelativeToReadback: offsets.filter((n) => n > 0).length,
    futureDatedRelativeToAcquisition: acquiredOffsets.filter((n) => n > 0).length,
    srtMinusReadbackMs: {
      min: Math.min(...offsets),
      max: Math.max(...offsets),
      mean: offsets.reduce((a, b) => a + b) / offsets.length,
    },
    srtLabelledIntervalMs: interval(previous[1] / 1e7, current[1] / 1e7),
    observerReadbackIntervalMs: interval(previous[3] / frequency, current[3] / frequency),
    inputSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}
const report = {
  recordingPerformed: false,
  methodQualified: false,
  source: "capture-nDAhAy",
  note: "Alternative intervals are diagnostics, NOT substituted acceptance bounds. No API guarantee links the timestamp hull to compositor/presentation onset; do not select a passing clock interpretation.",
  results,
};
fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }, null, 2));
