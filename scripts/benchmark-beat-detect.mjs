// Times music beat detection: Python Beat This! reference (CUDA) vs the Rust sidecar on CUDA and
// on the CPU, on 3, 10 and 60 minute inputs, and writes the results into
// docs/benchmarks/beat-detect.md (between the benchmark markers). It also checks that all three
// produced the same beats and downbeats.
//
// Usage: node scripts/benchmark-beat-detect.mjs [--source <audio file>] [--minutes 3,10,60]
//
// Inputs are the source looped to each length with the app's ffmpeg conversion (mono, 22.05 kHz,
// 16-bit PCM). The default source is the committed parity fixture.
//
// Needs:
//   SUPA_VIDEO_BEAT_REFERENCE_PYTHON      reference interpreter (beat-detector/reference/.venv)
//   SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT  local final0.ckpt
//   SUPA_VIDEO_BEAT_RUNTIME_DIR           runtime folder with models/ and cuda/
//                                         (default <repo>/.cache/beat-runtime)
// When one is missing it prints "SKIPPED: <reason>", writes nothing and exits 77.
import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const SKIP_EXIT = 77;
const repo = fileURLToPath(new URL("..", import.meta.url));
const detectorDir = join(repo, "apps/desktop/src-tauri/beat-detector");
const referenceScript = join(detectorDir, "reference/beat_this_reference.py");
const sidecar = join(detectorDir, "target/release/supa-beat-detect.exe");
const resultsPath = join(repo, "docs/benchmarks/beat-detect.md");
const startMarker = "<!-- benchmark:start -->";
const endMarker = "<!-- benchmark:end -->";

function skip(reason) {
  console.log(`SKIPPED: ${reason}`);
  process.exit(SKIP_EXIT);
}

function fail(message) {
  console.error(`benchmark-beat-detect: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    source: join(detectorDir, "tests/fixtures/tempo-changes.wav"),
    minutes: [3, 10, 60],
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) fail(`${flag} needs a value`);
    if (flag === "--source") options.source = value;
    else if (flag === "--minutes") {
      options.minutes = value.split(",").map(Number);
      if (
        options.minutes.some((minutes) => !Number.isInteger(minutes) || minutes < 1 || minutes > 60)
      ) {
        fail("--minutes must be whole minutes between 1 and 60");
      }
    } else fail(`unknown option ${flag}`);
  }
  return options;
}

function requireEnvironment() {
  const python = process.env.SUPA_VIDEO_BEAT_REFERENCE_PYTHON;
  const checkpoint = process.env.SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT;
  const runtime = process.env.SUPA_VIDEO_BEAT_RUNTIME_DIR || join(repo, ".cache/beat-runtime");
  if (!python) skip("SUPA_VIDEO_BEAT_REFERENCE_PYTHON is not set (uv sync the reference project)");
  if (!checkpoint)
    skip("SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT is not set (path to a local final0.ckpt)");
  if (!existsSync(python)) skip(`SUPA_VIDEO_BEAT_REFERENCE_PYTHON does not exist: ${python}`);
  if (!existsSync(checkpoint))
    skip(`SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT does not exist: ${checkpoint}`);
  if (!existsSync(join(runtime, "models/beat_this.onnx"))) skip(`no models in ${runtime}`);
  if (!existsSync(join(runtime, "cuda/onnxruntime.dll"))) skip(`no GPU pack in ${runtime}`);
  return { python, checkpoint, runtime };
}

/** Runs a program; resolves with exit code, stdout, stderr and wall time in ms. */
function run(program, args, options = {}) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error), wallMs: 0 }));
    child.on("close", (code) => {
      const wallMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      resolve({ code, stdout, stderr, wallMs });
    });
  });
}

async function makeInput(ffmpeg, source, minutes, directory) {
  const wav = join(directory, `input-${minutes}min.wav`);
  const result = await run(ffmpeg, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-stream_loop",
    "-1",
    "-i",
    source,
    "-map",
    "0:a:0",
    "-vn",
    "-t",
    String(minutes * 60),
    "-ac",
    "1",
    "-ar",
    "22050",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "-y",
    wav,
  ]);
  if (result.code !== 0) fail(`ffmpeg failed for ${minutes} min: ${result.stderr}`);
  return wav;
}

function parseResult(label, result) {
  if (result.code !== 0) fail(`${label} exited ${result.code}: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${label} printed no JSON: ${result.stdout}`);
  }
}

function sameTimes(left, right) {
  return (
    left.length === right.length &&
    left.every((time, index) => Math.abs(time - right[index]) <= 0.001)
  );
}

function sidecarArgs(runtime, device, wav) {
  const args = ["detect", "--models", join(runtime, "models"), "--device", device];
  if (device === "cuda") args.push("--cuda", join(runtime, "cuda"));
  args.push(wav);
  return args;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function writeResults(markdown) {
  const current = existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8")
    : "# Music beat detection\n";
  const section = `${startMarker}\n${markdown}${endMarker}`;
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);
  const next =
    start >= 0 && end > start
      ? `${current.slice(0, start)}${section}${current.slice(end + endMarker.length)}`
      : `${current.trimEnd()}\n\n${section}\n`;
  writeFileSync(resultsPath, next);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const environment = requireEnvironment();
  if (!existsSync(options.source)) fail(`source does not exist: ${options.source}`);
  const ffmpegBundled = join(
    repo,
    "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe",
  );
  const ffmpeg = existsSync(ffmpegBundled) ? ffmpegBundled : "ffmpeg";

  const build = await run("cargo", ["build", "--release", "--locked"], { cwd: detectorDir });
  if (build.code !== 0) fail(`cargo build failed: ${build.stderr}`);

  const scratch = join(tmpdir(), `supa-beat-benchmark-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const rows = [];
  try {
    // Warm the file cache for the GPU pack and models so the first timed run is not a cold read.
    const warm = await makeInput(ffmpeg, options.source, 1, scratch);
    parseResult("warm-up", await run(sidecar, sidecarArgs(environment.runtime, "cuda", warm)));

    for (const minutes of options.minutes) {
      const wav = await makeInput(ffmpeg, options.source, minutes, scratch);
      const python = await run(environment.python, [
        referenceScript,
        "--checkpoint",
        environment.checkpoint,
        "--device",
        "cuda",
        wav,
      ]);
      if (python.code === 4) skip(`reference pin check failed: ${python.stderr.trim()}`);
      const reference = parseResult(`Python ${minutes} min`, python);
      const cudaRun = await run(sidecar, sidecarArgs(environment.runtime, "cuda", wav));
      const cuda = parseResult(`Rust CUDA ${minutes} min`, cudaRun);
      const cpuRun = await run(sidecar, sidecarArgs(environment.runtime, "cpu", wav));
      const cpu = parseResult(`Rust CPU ${minutes} min`, cpuRun);
      if (cuda.device !== "cuda") fail(`Rust CUDA ran on ${cuda.device}: ${cuda.cudaError}`);
      const identical = [cuda, cpu].every(
        (candidate) =>
          sameTimes(reference.beats, candidate.beats) &&
          sameTimes(reference.downbeats, candidate.downbeats),
      );
      const row = {
        minutes,
        beats: reference.beats.length,
        downbeats: reference.downbeats.length,
        python: python.wallMs,
        pythonInternal: reference.elapsedMs,
        cuda: cudaRun.wallMs,
        cudaInference: cuda.timing.melMs + cuda.timing.inferenceMs,
        cpu: cpuRun.wallMs,
        cpuInference: cpu.timing.melMs + cpu.timing.inferenceMs,
        identical,
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `## 3. Speed (${date})`,
    "",
    `Generated by \`node scripts/benchmark-beat-detect.mjs\`. Source looped to each length: \`${options.source.replace(repo, "").replaceAll("\\", "/")}\`.`,
    "Wall time is the whole process (start-up, model load, WAV read, analysis); the bracketed figure is",
    "the analysis alone (Python: `File2Beats` construction + call; Rust: mel + model inference).",
    "",
    "| Input | Beats / downbeats | Python reference (CUDA) | Rust CUDA | Rust CPU | Same result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.minutes} min | ${row.beats} / ${row.downbeats} | ${seconds(row.python)} (${seconds(row.pythonInternal)}) | ${seconds(row.cuda)} (${seconds(row.cudaInference)}) | ${seconds(row.cpu)} (${seconds(row.cpuInference)}) | ${row.identical ? "yes" : "**no**"} |`,
    ),
    "",
  ];
  writeResults(`${lines.join("\n")}\n`);
  console.log(`wrote ${resultsPath}`);
  if (rows.some((row) => !row.identical)) fail("results differ between Python and Rust");
}

await main();
