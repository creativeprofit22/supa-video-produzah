// No dependencies; regenerate the gitignored same-origin quiet fixture before testing.
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const binary = fileURLToPath(
  new URL("../src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe", import.meta.url),
);
const output = fileURLToPath(new URL("./ProgramMonitorAudio.mp4", import.meta.url));
const result = spawnSync(
  binary,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000:duration=12",
    "-af",
    "volume=0.04",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    output,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
