// Actual native HWND + existing read-only endpoint protocol. No browser launch or audio shim.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBoundedCaptureProcesses } from "./capture-calibration.mjs";
import { playQpcBounds } from "./capture-protocol.mjs";
import { classify } from "./step8-analysis.mjs";
import { hash, pitch, tools } from "./step8-media.mjs";
import { nativeReady } from "../2026-09-14-p2-speed/output-capture/native-readiness.mjs";
import { launcher } from "../2026-09-14-p2-speed/output-capture/owned-browser.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const old = path.resolve(root, "../2026-09-14-p2-speed/output-capture");
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: "wx" });
const run = (exe, args, timeout = 1000) =>
  execFileSync(exe, args, { timeout, maxBuffer: 2e6, windowsHide: true }).toString();

export function reviewedProfile(file) {
  if (!file || !path.isAbsolute(file) || path.basename(file) !== "results.json")
    throw Error("Explicit absolute parent-reviewed calibration results.json required");
  const bytes = fs.readFileSync(file);
  const result = JSON.parse(bytes);
  if (
    result.calibration !== "candidate-pass-parent-review-required" ||
    result.results?.length !== 3 ||
    !result.noOffsetSubtraction ||
    !result.strictSixSecondBoundMet ||
    result.results.some(
      (r, i) => r.name !== ["sync", "late", "early"][i] || r.classification !== "pass",
    )
  )
    throw Error("Reviewed calibration not qualified");
  return { file, sha256: hash(bytes), result };
}

export function physicalRoi(geometry, viewport) {
  const { frame, client, dpi } = geometry;
  const dpr = viewport.dpr;
  if (
    ![
      dpr,
      dpi,
      viewport.width,
      viewport.height,
      frame.width,
      frame.height,
      client.width,
      client.height,
    ].every((v) => Number.isFinite(v) && v > 0) ||
    Math.abs(dpr - dpi / 96) > 0.001 ||
    Math.abs(viewport.width * dpr - client.width) > 1 ||
    Math.abs(viewport.height * dpr - client.height) > 1 ||
    viewport.width < 680 ||
    viewport.height < 440
  )
    throw Error("WebView viewport is not the measured native physical client; no guessed ROI");
  // Synthetic full-frame flash is uniform. Sample well inside the CSS-positioned video.
  const x = Math.round(client.left - frame.left + 352 * dpr);
  const y = Math.round(client.top - frame.top + 212 * dpr);
  if (
    ![x, y].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    x + 8 > frame.width ||
    y + 8 > frame.height
  )
    throw Error("Physical ROI outside exact owned window");
  return { x, y, side: 8 };
}

export function packetReadiness(text) {
  const match = text.match(/AUDIO_PACKETS_READY frames=(\d+) peak=([^\s]+)/);
  if (!match || Number(match[1]) < 2400 || Number(match[2]) !== 0)
    throw Error(
      "Existing native graph did not acknowledge decoded-zero packets; no audio shim authorized",
    );
  return { frames: Number(match[1]), peak: Number(match[2]) };
}
export function sameGeometry(a, b) {
  return (
    ["handle", "pid", "creation", "title", "dpi"].every((key) => a[key] === b[key]) &&
    ["frame", "client"].every((part) =>
      ["left", "top", "width", "height"].every((key) => a[part][key] === b[part][key]),
    )
  );
}
function geometry(found, identity, executable) {
  return JSON.parse(
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(root, "native-window-geometry.ps1"),
        "-Handle",
        found.handle,
        "-OwnerId",
        String(identity.pid),
        "-Creation",
        String(identity.creation),
        "-Executable",
        executable,
      ],
      5000,
    ),
  );
}
function assertWgcSize(directory, measured) {
  const text = fs.readFileSync(path.join(directory, "visual/first-frame.txt"), "utf8");
  const size = `${measured.frame.width},${measured.frame.height}`;
  if (!text.includes(`itemSize=${size}\n`) || !text.includes(`frameContentSize=${size}\n`))
    throw Error("WGC/DWM physical bounds disagree; no remapping or retry");
}
function guardOkay(entry) {
  const text = entry.text();
  if (
    !text.includes("ISOLATION_READY mutationCalls=0") ||
    !text.includes("ISOLATION_STOPPED mutationCalls=0") ||
    /ISOLATION_(INVALID|REJECTED)/.test(text)
  )
    throw Error("Read-only isolation proof incomplete");
}

export function createNativeTiming({ profilePath, directory }) {
  const profile = reviewedProfile(profilePath);
  const output = path.join(directory, "native-timing");
  fs.mkdirSync(output);
  // Preserve the exact reviewed raw controls, not fabricated acceptance booleans.
  const controls = path.join(output, "reviewed-controls");
  fs.mkdirSync(controls);
  for (const name of ["sync", "late", "early"])
    fs.cpSync(path.join(path.dirname(profile.file), name), path.join(controls, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  const provenance = {
    profile: profile.file,
    profileSha256: profile.sha256,
    scope: "Native WebView digital endpoint/WGC only; not physical speaker/display timing",
    parentReviewRequired: true,
  };
  save(path.join(output, "provenance.json"), provenance);
  const completed = [];
  return {
    async capture({ name, page, owned, identity, executable }) {
      if (name !== ["preview", "final"][completed.length])
        throw Error("Only one preview/final capture pair permitted");
      const directory = path.join(output, name);
      fs.mkdirSync(directory);
      const processes = createBoundedCaptureProcesses();
      const { launch, children } = processes;
      let style;
      try {
        // Existing real playback checks warm the production graph. No new audio element/context.
        for (let i = 0; i < 12; i++) {
          if ((await page.locator(".frame-readout").innerText()) === "Frame 0") break;
          await page
            .getByRole("button", { name: "Step backward five frames", exact: true })
            .click({ timeout: 1000 });
        }
        if ((await page.locator(".frame-readout").innerText()) !== "Frame 0")
          throw Error("Real UI rewind failed");
        const selector =
          name === "preview"
            ? 'video[aria-label="Canonical video layer 1"]'
            : 'video[aria-label="Verified final video preview"]';
        const video = page.locator(selector);
        await page.waitForFunction(
          (selector) => {
            const v = globalThis.document.querySelector(selector);
            return v && v.readyState >= 2 && v.paused && !v.seeking;
          },
          selector,
          { timeout: 1500 },
        );
        const media = await video.evaluate((v) => ({
          src: v.currentSrc,
          rate: v.playbackRate,
          time: v.currentTime,
          preservesPitch: v.preservesPitch,
        }));
        if (
          media.rate !== (name === "preview" ? 1.5 : 1) ||
          !media.preservesPitch ||
          Math.abs(media.time - (name === "preview" ? 1 : 0)) > 1 / 30
        )
          throw Error("Native production media start/rate not ready");
        style = await page.addStyleTag({
          content:
            ".monitor-stage {position:fixed!important;left:32px!important;top:32px!important;width:640px!important;height:360px!important;z-index:10000!important;background:black!important} .transport-play {position:fixed!important;left:32px!important;top:404px!important;z-index:10001!important}",
        });
        const videoBox = await video.evaluate((v) => {
          const r = v.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        if (
          videoBox.width < 32 ||
          videoBox.height < 32 ||
          Math.abs(videoBox.x + videoBox.width / 2 - 352) > 1 ||
          Math.abs(videoBox.y + videoBox.height / 2 - 212) > 1
        )
          throw Error("Actual production video center does not match bounded stage ROI");
        const found = await nativeReady(
          { identity, findWindow: () => owned.findWindow(identity) },
          page,
        );
        const measured = geometry(found, identity, executable);
        const viewport = await page.evaluate(() => ({
          dpr: globalThis.devicePixelRatio,
          width: globalThis.innerWidth,
          height: globalThis.innerHeight,
        }));
        const roi = physicalRoi(measured, viewport);
        save(path.join(directory, "geometry.json"), {
          measured,
          viewport,
          videoBox,
          roi,
          identity,
          executable,
          media,
        });
        const args = [String(identity.pid), String(identity.creation), executable];
        const startVisual = (dir, watchdog) =>
          launch(
            path.join(old, "WgcRoi.exe"),
            [
              found.handle,
              String(identity.pid),
              path.join(dir, "visual"),
              String(roi.x),
              String(roi.y),
              "8",
              path.join(dir, "stop.marker"),
            ],
            "WGC_READY",
            dir,
            watchdog,
          );
        // Separate non-audio probe so its deliberate transition cannot contaminate measured frames.
        const pre = path.join(directory, "roi-preflight");
        fs.mkdirSync(pre);
        const preGuard = launch(
          path.join(root, "ReadOnlyGuard.exe"),
          args,
          "ISOLATION_READY",
          pre,
          10000,
        );
        await preGuard.readiness;
        await page.evaluate(() => {
          const marker = globalThis.document.createElement("div");
          marker.id = "native-timing-roi-probe";
          marker.style.cssText =
            "position:fixed;left:344px;top:204px;width:32px;height:32px;background:black;z-index:2147483647;pointer-events:none";
          globalThis.document.body.append(marker);
        });
        const probe = startVisual(pre, 6000);
        await probe.readiness;
        assertWgcSize(pre, measured);
        const black = await probe.observations.wait("black");
        await page.evaluate(() => {
          globalThis.document.querySelector("#native-timing-roi-probe").style.background = "white";
        });
        const white = await probe.observations.wait("white", black.timestamp100ns);
        save(path.join(pre, "readiness.json"), { black, white });
        fs.writeFileSync(path.join(pre, "stop.marker"), "owned ROI preflight complete");
        await probe.exit;
        preGuard.child.stdin.end("stop\n");
        await preGuard.exit;
        guardOkay(preGuard);
        await page.evaluate(() =>
          globalThis.document.querySelector("#native-timing-roi-probe").remove(),
        );
        if (processes.invalid) throw processes.invalid;
        const readerExe = path.join(root, "CompletionLoopback.exe");
        const audio = launch(
          readerExe,
          [path.join(directory, "audio"), "2"],
          "READER_WAITING",
          directory,
          6000,
        );
        await audio.readiness;
        const reader = audio.text().match(/READER_WAITING (\d+) (\d+)/);
        if (!reader) throw Error("Retained audio-reader identity missing");
        const guard = launch(
          path.join(root, "ReadOnlyGuard.exe"),
          [...args, reader[1], reader[2], readerExe],
          "ISOLATION_READY",
          directory,
          10000,
        );
        await guard.readiness;
        const visual = startVisual(directory, 6000);
        await visual.readiness;
        assertWgcSize(directory, measured);
        await visual.observations.wait("black");
        if (processes.invalid) throw processes.invalid;
        audio.child.stdin.write("BEGIN_AUTHORIZED_CAPTURE\n");
        await audio.waitFor("LOOPBACK_READY");
        await audio.waitFor("AUDIO_PACKETS_READY"); // No packet readiness => fail closed, no silence shim.
        save(path.join(directory, "packet-readiness.json"), {
          acknowledged: "AUDIO_PACKETS_READY",
          ...packetReadiness(audio.text()),
        });
        const before = run(launcher, ["--qpc"], 500).trim();
        await page.getByRole("button", { name: "Play", exact: true }).click({ timeout: 1000 });
        const after = run(launcher, ["--qpc"], 500).trim();
        save(path.join(directory, "play-qpc.json"), playQpcBounds(before, after));
        await audio.waitFor("READER_CAPTURE_STOPPED", 4000);
        if (!audio.text().includes("AUDIO_STOP_ACK"))
          throw Error("Missing normal audio stop acknowledgement");
        fs.writeFileSync(path.join(directory, "stop.marker"), "normal audio stop acknowledged");
        await visual.exit;
        guard.child.stdin.end("stop\n");
        await guard.exit;
        guardOkay(guard);
        audio.child.stdin.end("EXIT_OWNED_READER\n");
        await audio.exit;
        if (processes.invalid) throw processes.invalid;
        if (!sameGeometry(measured, geometry(found, identity, executable)))
          throw Error("Native geometry changed during capture");
        await page.waitForFunction(
          (selector) => {
            const video = globalThis.document.querySelector(selector);
            return (
              video?.paused &&
              globalThis.document.querySelector(".frame-readout")?.textContent === "Frame 59"
            );
          },
          selector,
          { timeout: 1500 },
        );
        completed.push(name);
      } catch (error) {
        save(path.join(directory, "failure.json"), { error: String(error) });
        throw error;
      } finally {
        for (const child of children) if (!child.ended()) child.child.kill();
        await Promise.allSettled(children.map((child) => child.exit));
        await page
          .evaluate(() => globalThis.document.querySelector("#native-timing-roi-probe")?.remove())
          .catch(() => {});
        if (style) await style.evaluate((node) => node.remove()).catch(() => {});
      }
    },
    finish() {
      if (completed.join() !== "preview,final") throw Error("Native timing pair incomplete");
      run(process.execPath, [path.join(old, "analyze-bounded.mjs"), controls], 30000);
      const freshAnalysis = JSON.parse(fs.readFileSync(path.join(controls, "results.json")));
      if (freshAnalysis.calibration !== "candidate-pass-parent-review-required")
        throw Error("Retained reviewed raw controls do not requalify");
      const results = {};
      for (const name of completed) {
        const derived = path.join(output, `analysis-${name}`);
        fs.mkdirSync(derived);
        for (const [from, to] of [
          [path.join(output, name), "sync"],
          [path.join(controls, "late"), "late"],
          [path.join(controls, "early"), "early"],
        ])
          fs.cpSync(from, path.join(derived, to), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        run(process.execPath, [path.join(old, "analyze-bounded.mjs"), derived], 30000);
        const observation = JSON.parse(fs.readFileSync(path.join(derived, "results.json")))
          .results[0];
        if (!(observation.audioDurationSeconds <= 3))
          throw Error("Native audio three-second scope exceeded");
        const pcm = execFileSync(
          tools().ffmpeg,
          [
            "-v",
            "error",
            "-i",
            path.join(output, name, "audio/loopback.wav"),
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
          ],
          { timeout: 30000, maxBuffer: 2e6 },
        );
        const hz = pitch(Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4)));
        results[name] = classify(observation, { rn: 30, rd: 1 }, hz, true);
      }
      const report = { ...provenance, results, step9Done: false };
      save(path.join(output, "native-timing-results.json"), report);
      if (
        Object.values(results).some(
          (r) => r.classification !== "candidate-pass-parent-review-required",
        )
      )
        throw Error("Native timing failed or inconclusive; all samples retained");
      return report;
    },
  };
}
