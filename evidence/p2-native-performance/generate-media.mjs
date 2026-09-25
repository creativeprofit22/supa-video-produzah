import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import console from "node:console";
import { performance } from "node:perf_hooks";
import process from "node:process";
const durationSeconds = Number(process.argv[2] ?? 40);
if (![40, 90].includes(durationSeconds))
  throw new Error("Approved media lengths are 40 or 90 seconds");

const root = fileURLToPath(new URL("../../", import.meta.url));
const tools = path.join(root, "apps/desktop/src-tauri/media-toolchain");
const manifest = JSON.parse(readFileSync(path.join(tools, "manifest.v1.json"), "utf8"));
const target = manifest.targets["x86_64-pc-windows-msvc"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binaries = {};
for (const name of ["ffmpeg", "ffprobe"]) {
  const file = path.join(tools, "bin/x86_64-pc-windows-msvc", `${name}.exe`);
  const bytes = readFileSync(file);
  if (
    bytes.length !== target.binaries[name].byteLength ||
    hash(bytes) !== target.binaries[name].sha256
  )
    throw new Error(`Pinned identity mismatch: ${name}`);
  binaries[name] = file;
}
const runs = fileURLToPath(new URL("./runs/", import.meta.url));
mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(path.join(runs, "media-"));
const receipt = {
  utc: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  }).trim(),
  trackedDiffSha256: hash(
    execFileSync("git", ["diff", "HEAD", "--binary", "--no-ext-diff"], {
      cwd: root,
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    }),
  ),
  generatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  environmentOverrides: {},
  toolchainId: manifest.toolchainId,
  binaries: target.binaries,
  generated: [],
  durationSeconds,
  scope: "Synthetic generated input only, not playback/export parity",
};
try {
  for (const rate of ["30/1", "30000/1001"]) {
    for (const variant of [0, 1]) {
      const output = path.join(directory, `source-${rate.replace("/", "-")}-${variant}.mp4`);
      const args = [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-n",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=1920x1080:rate=${rate}:duration=${durationSeconds}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${variant ? 660 : 440}:sample_rate=48000:duration=${durationSeconds}`,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        variant ? "hflip" : "null",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-movflags",
        "+faststart",
        output,
      ];
      const start = performance.now();
      execFileSync(binaries.ffmpeg, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      const probeArgs = [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_type,width,height,avg_frame_rate,nb_read_frames,sample_rate,duration:format=duration",
        "-of",
        "json",
        output,
      ];
      const probe = JSON.parse(
        execFileSync(binaries.ffprobe, probeArgs, {
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        }),
      );
      const video = probe.streams.find((s) => s.codec_type === "video"),
        audio = probe.streams.find((s) => s.codec_type === "audio");
      if (
        !video ||
        !audio ||
        video.width !== 1920 ||
        video.height !== 1080 ||
        Number(audio.sample_rate) !== 48000 ||
        video.avg_frame_rate !== rate ||
        !Number.isFinite(Number(probe.format.duration)) ||
        Number(video.nb_read_frames) !==
          Math.ceil(durationSeconds * (rate === "30/1" ? 30 : 30000 / 1001)) ||
        Math.abs(Number(probe.format.duration) - durationSeconds) > 0.1
      )
        throw new Error("Generated media shape mismatch");
      const bytes = readFileSync(output);
      receipt.generated.push({
        output,
        rate,
        variant,
        sha256: hash(bytes),
        bytes: bytes.length,
        elapsedMs: performance.now() - start,
        argv: args,
        probeArgv: probeArgs,
        probe,
        exitCode: 0,
      });
    }
  }
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error);
  throw error;
} finally {
  const output = path.join(directory, "receipt.json");
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({ output, sha256: hash(readFileSync(output)), status: receipt.status }),
  );
}
