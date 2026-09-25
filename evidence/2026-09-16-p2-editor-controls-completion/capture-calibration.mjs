import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { playQpcBounds } from "./capture-protocol.mjs";
import { validateTargetNames } from "./capture-targets.mjs";
import { prepareTargetForCapture } from "./target-readiness.mjs";
import {
  launchOwnedBrowser,
  launcher,
} from "../2026-09-14-p2-speed/output-capture/owned-browser.mjs";
import { nativeReady } from "../2026-09-14-p2-speed/output-capture/native-readiness.mjs";
import { roiObservations } from "../2026-09-14-p2-speed/output-capture/roi-observations.mjs";
const { chromium } = createRequire(path.resolve("apps/desktop/package.json"))("@playwright/test");
// Whole reader-process lifetime, not recording duration: three sequential readiness
// waits, the existing recording/stop-ack budget, then bounded visual/guard teardown.
// The native reader still records at most three seconds; all acceptance gates stay unchanged.
export const calibrationReaderLifetimeMs = 3 * 1800 + 4000 + 4000;

// Shared bounded process protocol; browser behavior is unchanged.
export function createBoundedCaptureProcesses() {
  const children = [];
  let invalid;
  function launch(command, args, marker, directory, watchdogMs) {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const observations = marker === "WGC_READY" ? roiObservations(child) : null;
    let text = "",
      ready = false,
      ended = false,
      resolveReady,
      rejectReady;
    const readiness = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readiness.catch(() => {});
    const readyTimer = setTimeout(() => {
      invalid = Error("Readiness acknowledgement timeout");
      rejectReady(invalid);
      child.kill();
    }, 1800);
    const watchdog = setTimeout(() => {
      invalid = Error("Owned capture watchdog");
      child.kill();
    }, watchdogMs);
    const receive = (bytes) => {
      text += bytes;
      if (Buffer.byteLength(text) > 2e6) {
        invalid = Error("Child log bound");
        child.kill();
        return;
      }
      if (text.includes("ISOLATION_INVALID") || text.includes("ISOLATION_REJECTED")) {
        invalid = Error("Isolation invalidated; capture unusable");
        for (const entry of children) if (!entry.ended()) entry.child.kill();
      }
      if (!ready && text.includes(marker)) {
        ready = true;
        clearTimeout(readyTimer);
        resolveReady();
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    const exit = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        ended = true;
        clearTimeout(readyTimer);
        clearTimeout(watchdog);
        fs.writeFileSync(path.join(directory, path.basename(command) + ".log"), text);
        if (code !== 0 || !ready) {
          const error = Error(`Owned process failed (${code}): ${text}`);
          invalid ??= error;
          rejectReady(error);
          reject(error);
        } else resolve(text);
      });
    });
    exit.catch(() => {});
    const waitFor = (marker, acknowledgementMs = 1800) =>
      new Promise((resolve, reject) => {
        if (text.includes(marker)) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          cleanup();
          reject(Error("Missing acknowledgement " + marker));
        }, acknowledgementMs);
        const onData = () => {
          if (text.includes(marker)) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => {
          cleanup();
          reject(Error("Exited before " + marker));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
      });
    const entry = {
      child,
      readiness,
      exit,
      observations,
      ended: () => ended,
      text: () => text,
      waitFor,
    };
    children.push(entry);
    return entry;
  }
  return {
    children,
    launch,
    get invalid() {
      return invalid;
    },
  };
}
export async function captureCalibration({
  mode = process.argv[2],
  targets = [],
  reviewCalibration,
} = {}) {
  const names = validateTargetNames(targets.map((target) => target.name));
  // No directory, server, helper, browser, or audio session is opened in this mode.
  if (mode === "--validate-only") return { validated: true, targets: names };
  const record = mode === "--record-authorized";
  if (!record && mode !== "--preflight")
    throw Error("Choose explicit read-only preflight or separately authorized recording");
  const root = path.dirname(fileURLToPath(import.meta.url));
  const old = path.resolve("evidence/2026-09-14-p2-speed/output-capture");
  const run = fs.mkdtempSync(path.join(root, "capture-"));
  console.log(run);
  const save = (name, value) =>
    fs.writeFileSync(path.join(run, name), JSON.stringify(value, null, 2));
  const exec = (command, args, timeout = 30000) =>
    execFileSync(command, args, { timeout, maxBuffer: 30e6 });
  const tools = path.resolve("apps/desktop/src-tauri/media-toolchain");
  const manifest = JSON.parse(fs.readFileSync(path.join(tools, "manifest.v1.json"), "utf8"));
  const binaries = manifest.targets["x86_64-pc-windows-msvc"].binaries;
  for (const name of ["ffmpeg", "ffprobe"]) {
    const bytes = fs.readFileSync(path.join(tools, "bin/x86_64-pc-windows-msvc", name + ".exe"));
    if (
      bytes.length !== binaries[name].byteLength ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== binaries[name].sha256
    )
      throw Error("Unverified bundled media tool");
  }
  const ffmpeg = path.join(tools, "bin/x86_64-pc-windows-msvc/ffmpeg.exe");
  const ffprobe = path.join(tools, "bin/x86_64-pc-windows-msvc/ffprobe.exe");
  // A decoded-zero owned stream keeps the endpoint clock producing packets before
  // the test click. It does not reroute the measured media through Web Audio.
  const silence = path.join(run, "silence.wav");
  exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    "1",
    "-c:a",
    "pcm_f32le",
    silence,
  ]);
  const conditions = [
    ["sync", 0],
    ["late", 0.1],
    ["early", -0.1],
  ];
  const controls = [];
  for (const [name, offset] of conditions) {
    const asset = path.join(run, name + ".mp4"),
      onset = 0.8 + offset;
    exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=30:d=2,drawbox=c=white:t=fill:enable='gte(t,0.8)*lt(t,0.9)'",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='if(between(t,${onset},${onset + 0.1}),0.25*sin(2*PI*1000*(t-${onset})),0)':s=48000:d=2`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      "2",
      asset,
    ]);
    const probe = JSON.parse(exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", asset]));
    const frames = JSON.parse(
      exec(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        asset,
      ]),
    ).frames;
    const video = exec(ffmpeg, [
      "-v",
      "error",
      "-i",
      asset,
      "-vf",
      "scale=1:1",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    const audio = exec(ffmpeg, [
      "-v",
      "error",
      "-i",
      asset,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const flashes = [],
      sounds = [];
    let last = -Infinity;
    for (let i = 1; i < video.length; i++)
      if (video[i] > 200 && video[i - 1] < 50)
        flashes.push(Number(frames[i].best_effort_timestamp_time));
    for (let i = 0; i < audio.length / 4; i++)
      if (Math.abs(audio.readFloatLE(i * 4)) > 0.005) {
        if (i - last > 4800) sounds.push(i / 48000);
        last = i;
      }
    const deltaMs = (sounds[0] - flashes[0]) * 1000;
    controls.push({
      name,
      offset,
      flashes,
      sounds,
      deltaMs,
      frames: video.length,
      valid:
        probe.streams.every((s) => Number(s.start_time) === 0) &&
        video.length === 60 &&
        flashes.length === 1 &&
        sounds.length === 1 &&
        [...video].filter((v) => v > 200).length === 3 &&
        Math.abs(deltaMs - offset * 1000) < 2,
    });
  }
  save("controls.json", controls);
  if (controls.some((control) => !control.valid))
    throw Error("Decoded calibration source controls failed");
  const processes = createBoundedCaptureProcesses();
  const { children, launch } = processes;
  let owner, server, guard;
  const lifecycle = [];
  try {
    server = http.createServer((request, response) => {
      const name = request.url?.slice(1);
      if (
        name !== "silence.wav" &&
        !conditions.some(([condition]) => name === condition + ".mp4")
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const bytes = fs.readFileSync(path.join(run, name));
      response.writeHead(200, {
        "Content-Type": name === "silence.wav" ? "audio/wav" : "video/mp4",
        "Content-Length": bytes.length,
      });
      response.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    owner = await launchOwnedBrowser(chromium, {
      leaseMs: 60000,
      onEvent: (event) => {
        lifecycle.push(event);
        save("lifecycle.json", lifecycle);
      },
    });
    const page = owner.browser.contexts()[0].pages()[0];
    await page.setViewportSize({ width: 850, height: 580 });
    page.setDefaultTimeout(5000);
    await page.setContent(
      '<title>SUPA_LOOPBACK_PRIVATE_TEST</title><body style="margin:0;background:black"><div id="roi" style="width:640px;height:360px;background:black"></div></body>',
    );
    const found = await nativeReady(owner, page);
    if (found.handle === "0") throw Error("No owned window");
    save("window.json", { ...owner.identity, handle: found.handle });
    guard = launch(
      path.join(root, "ReadOnlyGuard.exe"),
      [String(owner.identity.pid), String(owner.identity.creation), chromium.executablePath()],
      "ISOLATION_READY",
      run,
      60000,
    );
    await guard.readiness;
    const pre = path.join(run, "roi-preflight");
    fs.mkdirSync(pre);
    const preStop = path.join(pre, "stop.marker");
    const roi = launch(
      path.join(old, "WgcRoi.exe"),
      [
        String(found.handle),
        String(owner.identity.pid),
        path.join(pre, "visual"),
        "100",
        "200",
        "8",
        preStop,
      ],
      "WGC_READY",
      pre,
      4000,
    );
    await roi.readiness;
    const black = await roi.observations.wait("black");
    await page.evaluate(() => {
      globalThis.document.querySelector("#roi").style.background = "white";
    });
    const white = await roi.observations.wait("white", black.timestamp100ns);
    if (white.timestamp100ns <= black.timestamp100ns) throw Error("Stale ROI");
    save("roi-readiness.json", { black, white });
    fs.writeFileSync(preStop, "owned preflight complete");
    await roi.exit;
    guard.child.stdin.end("stop\n");
    await guard.exit;
    for (const [name, target] of record
      ? [
          ...conditions.map(([name]) => [name, null]),
          ...targets.map((target) => [target.name, target]),
        ]
      : []) {
      if (target === targets[0] && target) {
        exec(process.execPath, [path.join(old, "analyze-bounded.mjs"), run]);
        const calibration = JSON.parse(fs.readFileSync(path.join(run, "results.json"), "utf8"));
        if (calibration.calibration !== "candidate-pass-parent-review-required")
          throw Error("Current controls inconclusive; production capture refused");
        // Caller must confirm a previously parent-reviewed profile; fresh controls
        // remain candidate-only and are retained for subsequent parent review.
        if (!reviewCalibration || !(await reviewCalibration(run, calibration)))
          throw Error("Parent calibration review required before production capture");
      }
      if (processes.invalid) throw processes.invalid;
      const directory = path.join(run, name);
      fs.mkdirSync(directory);
      const stop = path.join(directory, "stop.marker");
      if (target) {
        const predicates = [];
        const ready = await prepareTargetForCapture(target, page, owner, found, {
          onPredicate(predicate) {
            predicates.push(predicate);
            fs.writeFileSync(
              path.join(directory, "native-readiness-predicates.json"),
              JSON.stringify(predicates, null, 2),
            );
          },
        });
        fs.writeFileSync(
          path.join(directory, "native-readiness.json"),
          JSON.stringify(ready, null, 2),
        );
      } else
        await page.setContent(
          `<title>SUPA_LOOPBACK_PRIVATE_TEST</title><body style="margin:0;background:black"><video width="640" height="360" src="http://127.0.0.1:${server.address().port}/${name}.mp4" preload="auto"></video><button onclick="document.querySelector('video').play()">Play calibration</button></body>`,
        );
      await page.waitForFunction(() => globalThis.document.querySelector("video").readyState >= 2);
      await page.evaluate(async (url) => {
        const silent = globalThis.document.createElement("audio");
        silent.src = url;
        silent.loop = true;
        globalThis.document.body.append(silent);
        await silent.play();
      }, `http://127.0.0.1:${server.address().port}/silence.wav`);
      const readerExecutable = path.join(root, "CompletionLoopback.exe");
      const audio = launch(
        readerExecutable,
        [path.join(directory, "audio"), "3"],
        "READER_WAITING",
        directory,
        calibrationReaderLifetimeMs,
      );
      await audio.readiness;
      const identity = audio.text().match(/READER_WAITING (\d+) (\d+)/);
      if (!identity) throw Error("Reader identity missing");
      guard = launch(
        path.join(root, "ReadOnlyGuard.exe"),
        [
          String(owner.identity.pid),
          String(owner.identity.creation),
          chromium.executablePath(),
          identity[1],
          identity[2],
          readerExecutable,
        ],
        "ISOLATION_READY",
        directory,
        60000,
      );
      await guard.readiness;
      const visual = launch(
        path.join(old, "WgcRoi.exe"),
        [
          String(found.handle),
          String(owner.identity.pid),
          path.join(directory, "visual"),
          "100",
          "200",
          "8",
          stop,
        ],
        "WGC_READY",
        directory,
        4000,
      );
      await visual.readiness;
      if (target) await visual.observations.wait("black");
      if (processes.invalid) throw processes.invalid;
      audio.child.stdin.write("BEGIN_AUTHORIZED_CAPTURE\n");
      await audio.waitFor("LOOPBACK_READY");
      await audio.waitFor("AUDIO_PACKETS_READY");
      fs.writeFileSync(
        path.join(directory, "packet-readiness.json"),
        JSON.stringify({ acknowledged: "AUDIO_PACKETS_READY" }),
      );
      const before = exec(launcher, ["--qpc"], 500).toString().trim();
      await page
        .getByRole("button", { name: target ? "Play" : "Play calibration", exact: true })
        .click();
      const after = exec(launcher, ["--qpc"], 500).toString().trim();
      fs.writeFileSync(
        path.join(directory, "play-qpc.json"),
        JSON.stringify(playQpcBounds(before, after)),
      );
      await audio.waitFor("READER_CAPTURE_STOPPED", 4000);
      if (!audio.text().includes("AUDIO_STOP_ACK"))
        throw Error("No normal audio stop acknowledgement");
      fs.writeFileSync(stop, "normal audio stop acknowledged");
      await visual.exit;
      guard.child.stdin.end("stop\n");
      await guard.exit;
      audio.child.stdin.end("EXIT_OWNED_READER\n");
      await audio.exit;
      if (processes.invalid) throw processes.invalid;
    }
    if (record) {
      console.log(exec(process.execPath, [path.join(old, "analyze-bounded.mjs"), run]).toString());
      const result = JSON.parse(fs.readFileSync(path.join(run, "results.json"), "utf8"));
      save("capture-status.json", {
        isolated: !processes.invalid,
        mutationCalls: 0,
        result: result.calibration,
      });
      if (result.calibration !== "candidate-pass-parent-review-required")
        throw Error("Capture calibration did not qualify; no production matrix authorized");
    } else
      save("capture-status.json", {
        isolated: !processes.invalid,
        mutationCalls: 0,
        result: "readonly-preflight-pass",
        audioRecorded: false,
      });
  } catch (error) {
    save("failure.json", { error: String(error), isolated: !processes.invalid });
    throw error;
  } finally {
    for (const entry of children) if (!entry.ended()) entry.child.kill();
    await Promise.allSettled(children.map((entry) => entry.exit));
    if (owner) await owner.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  return run;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await captureCalibration();
