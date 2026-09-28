// Step 15 probe: long-file transcription strategies, measured on real audio (not production code).
//
//   assign  <words.json> <diar.json> <out.json>
//       Attach a speaker to every word from a whole-file diarization (largest time overlap; the
//       nearest segment when a word overlaps none). Words keep their text and timings.
//   segment <audio.wav> <max-seconds> <out-dir> <runtime-dir>
//       Split the audio at the quietest point before each max-length boundary (ffmpeg
//       silencedetect), transcribe every piece in full-quality (offline) mode without speakers,
//       and stitch the words back onto the original timeline. Records per-piece GPU memory.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { setInterval, clearInterval } from "node:timers";
import { execFileSync, spawn } from "node:child_process";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);

const assign = (wordsFile, diarFile, outFile) => {
  const run = readJson(wordsFile);
  const segments = readJson(diarFile).segments;
  let unmatched = 0;
  const words = run.words.map((word) => {
    let best = null;
    let bestOverlap = 0;
    for (const segment of segments) {
      const overlap = Math.min(word.end, segment.end) - Math.max(word.start, segment.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = segment;
      }
    }
    if (best === null) {
      unmatched++;
      const middle = (word.start + word.end) / 2;
      const distance = (segment) => Math.max(0, segment.start - middle, middle - segment.end);
      best = segments.reduce((a, b) => (distance(b) < distance(a) ? b : a));
    }
    return { ...word, speaker: best.speaker };
  });
  writeJson(outFile, { ...run, words });
  console.log(JSON.stringify({ assigned: words.length, nearestFallback: unmatched, outFile }));
};

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const vramUsed = () =>
  Number(
    execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
    }).trim(),
  );

const segment = async (audio, maxSecondsText, outDir, runtimeDir) => {
  const maxSeconds = Number(maxSecondsText);
  if (!(maxSeconds > 30)) throw new Error("max-seconds must be > 30");
  fs.mkdirSync(outDir, { recursive: true });
  const duration = Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio],
      {
        encoding: "utf8",
      },
    ).trim(),
  );
  // silencedetect prints to stderr; capture it via spawn.
  const detect = await run("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-i",
    audio,
    "-af",
    "silencedetect=noise=-35dB:d=0.25",
    "-f",
    "null",
    "-",
  ]);
  const quiet = [];
  const pattern = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g;
  for (const match of detect.stderr.matchAll(pattern))
    quiet.push({ start: Number(match[1]), end: Number(match[2]) });
  // Cut at the middle of the longest pause in the last 20 % before each boundary.
  const cuts = [0];
  while (duration - cuts.at(-1) > maxSeconds) {
    const from = cuts.at(-1);
    const window = quiet.filter(
      (q) => q.start > from + maxSeconds * 0.8 && q.end < from + maxSeconds,
    );
    const pick = window.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    cuts.push(pick ? (pick.start + pick.end) / 2 : from + maxSeconds);
  }
  cuts.push(duration);

  const words = [];
  const pieces = [];
  for (let index = 0; index + 1 < cuts.length; index++) {
    const start = cuts[index];
    const length = cuts[index + 1] - start;
    const pieceWav = path.join(outDir, `piece-${String(index).padStart(3, "0")}.wav`);
    execFileSync("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-t",
      length.toFixed(3),
      "-i",
      audio,
      "-c:a",
      "pcm_s16le",
      "-y",
      pieceWav,
    ]);
    const base = vramUsed();
    let peak = base;
    const poll = setInterval(() => {
      peak = Math.max(peak, vramUsed());
    }, 250);
    const began = Date.now();
    const result = await run(
      path.join(runtimeDir, "nemo-speech.exe"),
      [
        "--json",
        "transcribe",
        path.resolve(pieceWav),
        "--model",
        path.join(runtimeDir, "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"),
        "--device",
        "cuda:0",
        "--format",
        "json",
      ],
      { cwd: runtimeDir },
    );
    clearInterval(poll);
    if (result.code !== 0) throw new Error(`piece ${index} failed: ${result.stderr.slice(-600)}`);
    const piece = JSON.parse(result.stdout);
    for (const word of piece.words)
      words.push({ ...word, start: word.start + start, end: word.end + start });
    pieces.push({
      index,
      start,
      length,
      words: piece.words.length,
      seconds: (Date.now() - began) / 1000,
      vramBase: base,
      vramPeak: peak,
    });
    console.log(JSON.stringify(pieces.at(-1)));
    fs.rmSync(pieceWav);
  }
  const text = words.map(({ word }) => word).join(" ");
  writeJson(path.join(outDir, "stitched.json"), { file: audio, text, duration, words });
  writeJson(path.join(outDir, "pieces.json"), { maxSeconds, cuts, pieces });
  const peak = Math.max(...pieces.map((p) => p.vramPeak));
  console.log(
    JSON.stringify({
      pieces: pieces.length,
      words: words.length,
      vramPeak: peak,
      seconds: pieces.reduce((s, p) => s + p.seconds, 0),
    }),
  );
};

const [command, ...args] = process.argv.slice(2);
if (command === "assign" && args.length === 3) assign(...args);
else if (command === "segment" && args.length === 4) await segment(...args);
else {
  console.error(
    "usage: assign <words.json> <diar.json> <out.json> | segment <audio.wav> <max-s> <out-dir> <runtime-dir>",
  );
  process.exit(2);
}
