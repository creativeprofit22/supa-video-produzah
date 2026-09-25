// One-variable OFFLINE filter probe, NOT production-compiled acceptance.
// Uses unchanged retained source bytes and original native measurement gates.
import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tools, hash } from "./step8-media.mjs";
const { ffmpeg, ffprobe } = tools();
const root = fs.mkdtempSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-smooth-"),
);
const silentRoot = "C:/Users/SPARTA~1/AppData/Local/Temp/slow-audio-onset-1oRIhg";
const continuousRoot = "C:/Users/SPARTA~1/AppData/Local/Temp/.tmpFok7YA";
const exec = (binary, args) => execFileSync(binary, args, { maxBuffer: 30e6 });
fs.writeFileSync(
  path.join(root, "filter-help.txt"),
  exec(ffmpeg, ["-hide_banner", "-h", "filter=rubberband"]),
);
const results = [];
for (const [rn, rd] of [
  [30, 1],
  [30000, 1001],
]) {
  for (const [sn, sd] of [
    [1, 2],
    [3, 4],
  ]) {
    const frame = rd / rn,
      speed = sn / sd;
    for (const kind of ["continuous", "silent"]) {
      const source = path.join(
        kind === "continuous" ? continuousRoot : silentRoot,
        kind === "continuous" ? `speed-parity-${rn}-${rd}.mp4` : `source-${rn}-${rd}.mp4`,
      );
      const sourceSha256 = hash(fs.readFileSync(source));
      const template = JSON.parse(
        fs.readFileSync(path.join(silentRoot, `${rn}-${rd}-${sn}-${sd}-plan.json`)),
      );
      for (const smooth of [false, true]) {
        const label = `${kind}-${rn}-${rd}-${sn}-${sd}-${smooth ? "smooth" : "default"}`;
        const output = path.join(root, `${label}.mp4`);
        const argv = [...template.argv];
        argv[argv.indexOf("-i") + 1] = source;
        argv[argv.length - 1] = output;
        const fi = argv.indexOf("-filter_complex") + 1;
        const exact = `rubberband=tempo=${speed.toFixed(2)}:window=short`;
        if (argv[fi].split(exact).length !== 2) throw Error("unexpected candidate filter");
        if (smooth) argv[fi] = argv[fi].replace(exact, exact + ":transients=smooth");
        fs.writeFileSync(path.join(root, `${label}-argv.json`), JSON.stringify(argv, null, 2));
        fs.writeFileSync(path.join(root, `${label}-encode.txt`), exec(ffmpeg, argv));
        const probe = JSON.parse(
          exec(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", output]),
        );
        const video = probe.streams.find((s) => s.codec_type === "video");
        const audio = probe.streams.find((s) => s.codec_type === "audio");
        const bytes = exec(ffmpeg, [
          "-v",
          "error",
          "-i",
          output,
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
        fs.writeFileSync(path.join(root, `${label}.f32`), bytes);
        const pcm = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
        let onset, end, hz;
        if (kind === "continuous") {
          let window = -1;
          for (let i = 0; i + 96 <= pcm.length; i += 96) {
            if (pcm.slice(i, i + 96).reduce((sum, v) => sum + v * v, 0) / 96 > 0.04) {
              window = i / 96;
              break;
            }
          }
          if (window < 0) throw Error("missing transient");
          onset = window * 0.002;
          const middle = pcm.slice(12000, -12000);
          let crossings = 0;
          for (let i = 1; i < middle.length; i++)
            if (middle[i - 1] <= 0 && middle[i] > 0) crossings++;
          hz = (crossings * 48000) / (middle.length - 1);
        } else {
          const first = pcm.findIndex((s) => Math.abs(s) > 0.005),
            last = pcm.findLastIndex((s) => Math.abs(s) > 0.005);
          if (first < 0) throw Error("missing tone");
          onset = first / 48000;
          end = last / 48000;
          const interior = pcm.slice(first + 960, last - 960),
            crossings = [];
          for (let i = 1; i < interior.length; i++)
            if (interior[i - 1] <= 0 && interior[i] > 0) crossings.push(i - 1);
          hz = ((crossings.length - 1) * 48000) / (crossings.at(-1) - crossings[0]);
        }
        const frames = exec(ffmpeg, [
          "-v",
          "error",
          "-i",
          output,
          "-map",
          "0:v:0",
          "-vf",
          "format=gray",
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
        const ids = [];
        for (let offset = 0; offset < frames.length; offset += 320 * 180) {
          let id = 0;
          for (let bit = 0; bit < 8; bit++)
            id |= Number(frames[offset + 90 * 320 + bit * 40 + 20] > 128) << bit;
          ids.push(id);
        }
        const cadence = Math.max(...ids.map((id, i) => Math.abs((id - 30) / speed - i)));
        const visualOnset = ids.findIndex((id) => id >= 42) * frame;
        const onsetError = onset - (12 * frame) / speed;
        const endError = end === undefined ? null : end - (18 * frame) / speed;
        const durationError = Number(audio.duration) - 60 * frame;
        const pass =
          Number(video.nb_read_frames) === 60 &&
          video.avg_frame_rate === `${rn}/${rd}` &&
          ids.length === 60 &&
          cadence <= 1 &&
          Math.abs(onsetError) <= frame &&
          (kind !== "continuous" || Math.abs(onset - visualOnset) <= frame) &&
          (endError === null || Math.abs(endError) <= frame) &&
          Math.abs(durationError) <= frame &&
          Number.isFinite(hz) &&
          Math.abs(hz / 1000 - 1) <= 0.01;
        const row = {
          label,
          smooth,
          source,
          sourceSha256,
          output,
          outputSha256: hash(fs.readFileSync(output)),
          hz,
          onsetError,
          endError,
          durationError,
          cadence,
          pass,
        };
        results.push(row);
        fs.writeFileSync(
          path.join(root, "results.json"),
          JSON.stringify(
            { productionAcceptance: false, recordingPerformed: false, results },
            null,
            2,
          ),
        );
        console.log(row);
      }
      if (hash(fs.readFileSync(source)) !== sourceSha256) throw Error("source changed");
    }
  }
}
console.log(
  JSON.stringify({ root, smoothPass: results.filter((r) => r.smooth).every((r) => r.pass) }),
);
if (!results.filter((r) => r.smooth).every((r) => r.pass)) process.exitCode = 1;
