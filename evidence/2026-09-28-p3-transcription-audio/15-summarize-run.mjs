// Summarizes a 15-sample-gpu.ps1 CSV: baseline and peak GPU memory, and the
// wall-clock span of each process (ffmpeg, piece-NNNN, diarize).
// usage: node 15-summarize-run.mjs <samples.csv>
import fs from "node:fs";
import process from "node:process";
import console from "node:console";

const [csvPath] = process.argv.slice(2);
if (csvPath === undefined) {
  console.error("usage: node 15-summarize-run.mjs <samples.csv>");
  process.exit(2);
}
const rows = fs
  .readFileSync(csvPath, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [t, vram, procs = ""] = line.split(",");
    return { t: Number(t), vram: Number(vram), procs: procs.split(" ").filter(Boolean) };
  });
const spans = new Map();
for (const { t, vram, procs } of rows)
  for (const name of new Set(procs)) {
    const span = spans.get(name) ?? { first: t, last: t, peak: 0 };
    span.last = t;
    span.peak = Math.max(span.peak, vram);
    spans.set(name, span);
  }
const idle = rows.filter((row) => row.procs.length === 0).map((row) => row.vram);
const pieces = [...spans].filter(([name]) => name.startsWith("piece-"));
const seconds = (span) => Number(((span.last - span.first) / 1000).toFixed(1));
console.log(
  JSON.stringify(
    {
      samples: rows.length,
      baselineMiB: idle.length === 0 ? null : Math.min(...idle),
      peakMiB: Math.max(...rows.map((row) => row.vram)),
      extractionSeconds: spans.has("ffmpeg") ? seconds(spans.get("ffmpeg")) : null,
      pieceCount: pieces.length,
      pieceSecondsMax: Math.max(...pieces.map(([, span]) => seconds(span))),
      piecePeakMiB: Math.max(...pieces.map(([, span]) => span.peak)),
      diarizeSeconds: spans.has("diarize") ? seconds(spans.get("diarize")) : null,
      diarizePeakMiB: spans.has("diarize") ? spans.get("diarize").peak : null,
      spans: Object.fromEntries(
        [...spans].map(([name, span]) => [name, { seconds: seconds(span), peakMiB: span.peak }]),
      ),
    },
    null,
    2,
  ),
);
