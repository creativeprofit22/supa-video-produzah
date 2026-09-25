// Preparation only: explicit opt-in required. Real editor UI/native IPC, never a fixture.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { startOwned } from "../2026-09-14-p2-speed/output-capture/owned-browser.mjs";
import { decode, hash, tools } from "./step8-media.mjs";
import { nativeTestRoot } from "../../apps/desktop/test-port.mjs";

export const identifier = "com.supavideo.native-playback-step9-20260916";
export const title = "SUPA_LOOPBACK_PRIVATE_TEST Native editor step 9";
export const isolatedConfig = {
  identifier,
  build: { devUrl: nativeTestRoot.slice(0, -1) },
  app: { windows: [{ title, width: 1280, height: 800, minWidth: 480, minHeight: 360 }] },
};
const root = path.dirname(fileURLToPath(import.meta.url));

// Read native commit evidence, not the intentionally lagging checkpoint snapshot.
// This is not a replacement journal replay/cryptographic validator.
export function committedProjection(journal, projectId, revision) {
  const record = journal
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .at(-1);
  const projection = record?.idempotencyResult?.projection;
  if (
    record?.kind !== "commit" ||
    record.resultingRevision?.number !== revision ||
    projection?.projectId !== projectId ||
    projection.revision?.number !== revision
  )
    throw Error("Expected native journal commit is missing or mismatched");
  return projection;
}

export function keyboardBudget(started, now) {
  const remainingMs = Math.max(0, Math.floor(120000 - (now - started)));
  return { remainingMs, holdMs: Math.max(0, remainingMs - 8000), sufficient: remainingMs >= 38000 };
}

// DONE acknowledges only that the parent is finished collecting the user's answer.
// It is never interpreted as a human pass. No browser input is synthesized here.
export function holdForHuman({ input, holdMs, ownedExit, ready }) {
  if (!Number.isFinite(holdMs) || holdMs <= 0 || holdMs > 112000)
    throw Error("Invalid bounded human hold");
  return new Promise((resolve) => {
    let buffer = "",
      settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", error);
      input.pause();
      resolve({ toolStatus: reason, humanResult: "unverified", humanPass: null });
    };
    const data = (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 256) {
        finish("input-limit");
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "DONE") {
          finish("parent-finished");
          return;
        }
      }
    };
    const end = () => finish("stdin-closed");
    const error = () => finish("stdin-error");
    const timer = setTimeout(() => finish("deadline"), holdMs);
    input.on("data", data);
    input.once("end", end);
    input.once("error", error);
    ownedExit.then(
      () => finish("owned-exited"),
      () => finish("owned-exited"),
    );
    input.resume();
    ready();
  });
}

export function keyboardCli(args) {
  if (args[0] !== "--run-native-keyboard-check-authorized") return false;
  if (args.length !== 1) throw Error("Keyboard mode accepts no timing profile or extra arguments");
  return true;
}

export async function runNativePlayback({
  timingProfile,
  keyboardCheck = false,
  automatedKeyboardCheck = false,
} = {}) {
  if ((keyboardCheck || automatedKeyboardCheck) && timingProfile)
    throw Error("Keyboard mode cannot enable recording");
  if (keyboardCheck && automatedKeyboardCheck)
    throw Error("Human and automated modes are separate");
  // Only the explicit timing entry point imports/constructs the recording harness.
  const timingModule = timingProfile ? await import("./capture-native.mjs") : null;
  if (timingModule) timingModule.reviewedProfile(timingProfile);
  const { chromium, expect } = createRequire(path.resolve("apps/desktop/package.json"))(
    "@playwright/test",
  );
  const executable = path.resolve(
    "apps/desktop/src-tauri/target/step9-native/debug/supa-video-desktop.exe",
  );
  const bytes = fs.readFileSync(executable);
  if (!bytes.includes(Buffer.from(identifier)) || !bytes.includes(Buffer.from(title)))
    throw Error("Fresh isolated identifier/title build required");
  // Raw cargo builds do not stage Tauri resources. Never overwrite a mismatched resource.
  const resourceRoot = path.join(path.dirname(executable), "media-tools");
  fs.mkdirSync(resourceRoot, { recursive: true });
  for (const [name, input] of Object.entries(tools())) {
    const target = path.join(resourceRoot, `${name}.exe`);
    if (!fs.existsSync(target)) fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL);
    if (hash(fs.readFileSync(target)) !== hash(fs.readFileSync(input)))
      throw Error("Native resource hash mismatch");
  }
  const source = path.resolve("apps/desktop/browser-tests/completion-media/single-flash-30-1.mp4");
  const sourceProof = decode(source, 180, { rn: 30, rd: 1 });
  if (!sourceProof.valid) throw Error("Single-flash/tone source failed decoded gate");
  const port = net.createServer();
  await new Promise((resolve, reject) => {
    port.once("error", reject);
    port.listen(9226, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => port.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-controls-native-"));
  const timing = timingModule?.createNativeTiming({ profilePath: timingProfile, directory });
  // Existing picker authorizes this disposable prefix only. Preserve original media.
  const importedSource = path.join(directory, "single-flash-30-1.mp4");
  fs.copyFileSync(source, importedSource, fs.constants.COPYFILE_EXCL);
  if (hash(fs.readFileSync(importedSource)) !== sourceProof.sha256)
    throw Error("Fixture copy mismatch");
  const project = path.join(directory, "playback.svpvideo");
  const output = path.join(directory, "final.mp4");
  process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(directory, "webview");
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9226";
  const events = [],
    observations = [];
  const ownedStarted = performance.now();
  const owned = startOwned(executable, ["--editor-controls-proof"], {
    leaseMs: 120000,
    onEvent: (event) => events.push(event),
  });
  let browser, page;
  const messages = [];
  const note = (kind, text) => {
    if (messages.length < 100) messages.push({ kind, text: String(text).slice(0, 2000) });
  };
  const diagnose = async (phase) => {
    if (!page) return;
    let timer;
    try {
      const diagnostics = await Promise.race([
        page.evaluate(async () => ({
          body: globalThis.document.body.innerText.slice(0, 24000),
          jobs: await globalThis.__TAURI_INTERNALS__
            .invoke("video_list_media_jobs", {
              request: {
                limit: 20,
                includeSettled: true,
                projectId: null,
                beforeUpdatedAt: null,
                beforeJobId: null,
              },
            })
            .catch((error) => ({ error: String(error) })),
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Diagnostic deadline")), 2000);
        }),
      ]);
      fs.writeFileSync(
        path.join(directory, `${phase}-diagnostics.json`),
        JSON.stringify({ ...diagnostics, messages }, null, 2).slice(0, 100000),
      );
    } catch (error) {
      note("diagnostic-error", error);
    } finally {
      clearTimeout(timer);
    }
  };
  const errors = [];
  try {
    const identity = await owned.wait((event) => event.event === "identity", 10000);
    await expect
      .poll(
        async () => {
          try {
            return (await globalThis.fetch("http://127.0.0.1:9226/json/version")).ok;
          } catch {
            return false;
          }
        },
        { timeout: 10000 },
      )
      .toBe(true);
    browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
    const pages = browser.contexts()[0].pages();
    expect(pages).toHaveLength(1);
    page = pages[0];
    page.on("console", (message) => note(message.type(), message.text()));
    page.on("pageerror", (error) => note("pageerror", error));
    page.setDefaultTimeout(10000);
    await expect.poll(() => page.url()).toBe(nativeTestRoot);
    expect(await page.evaluate(() => typeof globalThis.__TAURI_INTERNALS__?.invoke)).toBe(
      "function",
    );
    await expect
      .poll(
        async () => {
          const tools = await page.evaluate(() =>
            globalThis.__TAURI_INTERNALS__.invoke("video_ffmpeg_status"),
          );
          return tools.ready;
        },
        { timeout: 45000 },
      )
      .toBe(true);
    const choose = async (button, file) => {
      await page.getByRole("button", { name: button, exact: true }).click();
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          path.join(root, "native-file-dialog.ps1"),
          "-OwnerId",
          String(identity.pid),
          "-Creation",
          identity.creation,
          "-FilePath",
          file,
        ],
        { timeout: 10000, encoding: "utf8" },
      );
    };
    const revision = (number) =>
      expect(page.locator(".project-status")).toContainText(`Revision ${number}`);
    await choose("New project", project);
    await revision(0);
    await choose("Choose video", importedSource);
    await diagnose("after-picker");
    // Preparation and native import commit are separate phases. The observed preparation
    // completed in 37.7s; commit then re-verifies FFprobe and probes the granted object.
    // Keep preparation at 45s and bound the subsequent revision adoption separately.
    const projectId = JSON.parse(fs.readFileSync(project, "utf8")).id;
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(
            (projectId) =>
              globalThis.__TAURI_INTERNALS__.invoke("video_list_media_jobs", {
                request: {
                  limit: 20,
                  includeSettled: true,
                  projectId,
                  beforeUpdatedAt: null,
                  beforeJobId: null,
                },
              }),
            projectId,
          );
          return result.jobs.find(
            (job) => job.kind === "asset_preparation" && job.parentId === null,
          )?.state;
        },
        { timeout: 45000 },
      )
      .toBe("complete");
    await diagnose("prepared");
    await expect(page.locator(".project-status")).toContainText("Revision 1", { timeout: 20000 });
    const fill = (name, value) =>
      page.getByRole("spinbutton", { name, exact: typeof name === "string" }).fill(value);
    const click = (name) => page.getByRole("button", { name, exact: true }).click();
    await fill("Speed (%)", "150");
    await click("Apply speed");
    await revision(2);
    await fill("Volume (dB)", "-6");
    await fill("Fade in (sequence frames)", "5");
    await fill("Fade out (sequence frames)", "7");
    await click("Apply audio");
    await revision(3);
    await fill(/^Source in/, "30");
    await fill(/^Source out/, "120");
    await click("Apply source range");
    await revision(4);
    const document = committedProjection(
      fs.readFileSync(`${project}.data/journal.ndjson`, "utf8"),
      projectId,
      4,
    );
    fs.writeFileSync(
      path.join(directory, "committed-projection.json"),
      JSON.stringify(document, null, 2),
      { flag: "wx" },
    );
    const clips = document.state.sequences[0].tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(1);
    expect([
      clips[0].sourceIn.value,
      clips[0].sourceOut.value,
      clips[0].speed.numerator,
      clips[0].speed.denominator,
      clips[0].gainMilliDecibels,
      clips[0].fades.inFrames,
      clips[0].fades.outFrames,
    ]).toEqual([30, 120, 3, 2, -6000, 5, 7]);

    if (automatedKeyboardCheck) {
      if (!keyboardBudget(ownedStarted, performance.now()).sufficient)
        throw Error("Insufficient remaining owned lease for automated keyboard checks");
      for (let step = 0; step < 4; step++) await click("Step forward five frames");
      await expect(page.locator(".frame-readout")).toHaveText("Frame 20");
      await click("Split at playhead");
      await revision(5);
      await expect(page.locator(".multitrack-clip-body")).toHaveCount(2);
      await expect(page.locator(".multitrack-clip-body").first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("spinbutton", { name: "Speed (%)", exact: true }).focus();
      const { exerciseNativeKeyboard } = await import("./native-keyboard-automated.mjs");
      await exerciseNativeKeyboard({
        page,
        expect,
        revision,
        record: (check, result) => observations.push({ check, ...result }),
      });
      await page.screenshot({ path: path.join(directory, "automated-keyboard.png") });
      fs.writeFileSync(
        path.join(directory, "automated-keyboard.json"),
        JSON.stringify(
          {
            mode: "tool-driven-keyboard",
            humanResult: "unverified",
            humanPass: null,
            assistiveTechnology: "unverified",
            observations,
            project,
            identity,
            executableSha256: hash(bytes),
            runtime: await browser.version(),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    } else if (keyboardCheck) {
      const humanFile = path.join(directory, "keyboard-check.json");
      const record = {
        mode: "human-keyboard-preparation",
        humanResult: "unverified",
        humanPass: null,
        project,
        identity,
        executableSha256: hash(bytes),
        sourceProof,
        leaseMs: 120000,
      };
      const insufficient = () => {
        fs.writeFileSync(
          humanFile,
          JSON.stringify(
            {
              ...record,
              toolStatus: "insufficient-time",
              ...keyboardBudget(ownedStarted, performance.now()),
            },
            null,
            2,
          ),
        );
        throw Error("Insufficient remaining lease for a 30-second human check; not performed");
      };
      if (!keyboardBudget(ownedStarted, performance.now()).sufficient) insufficient();
      // Real UI split creates two native clips, solely in this disposable project.
      for (let step = 0; step < 4; step++) await click("Step forward five frames");
      await expect(page.locator(".frame-readout")).toHaveText("Frame 20");
      await click("Split at playhead");
      await revision(5);
      await expect(page.locator(".multitrack-clip-body")).toHaveCount(2);
      await expect(page.locator(".multitrack-clip-body").first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.bringToFront();
      await page.getByRole("spinbutton", { name: "Speed (%)", exact: true }).focus();
      const budget = keyboardBudget(ownedStarted, performance.now());
      if (!budget.sufficient) insufficient();
      const status = {
        ...record,
        toolStatus: "human-ready",
        ...budget,
        focusedControl: "Speed (%)",
        baselineRevision: 5,
        handoff:
          "Automated setup only. Parent must obtain the user's four observations; DONE is not a pass.",
      };
      fs.writeFileSync(humanFile, JSON.stringify(status, null, 2));
      const result = await holdForHuman({
        input: process.stdin,
        holdMs: budget.holdMs,
        ownedExit: owned.exit,
        ready: () =>
          console.log(
            "KEYBOARD_READY " +
              JSON.stringify({
                directory,
                remainingLeaseMs: budget.remainingMs,
                humanWindowMs: budget.holdMs,
                humanResult: "unverified",
              }),
          ),
      });
      fs.writeFileSync(humanFile, JSON.stringify({ ...status, ...result }, null, 2));
    } else {
      const playback = async (label, selector, rate) => {
        const video = page.locator(selector);
        await expect(video).toHaveCount(1);
        await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(2);
        await expect(page.locator(".frame-readout")).toHaveText("Frame 0");
        await click("Play");
        await expect.poll(() => video.evaluate((v) => v.playbackRate)).toBe(rate);
        await expect.poll(() => page.locator(".frame-readout").innerText()).not.toBe("Frame 0");
        await click("Pause");
        await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
        const paused = await video.evaluate((v) => ({ time: v.currentTime, rate: v.playbackRate }));
        // Two animation frames are a bounded stability observation, not A/V timing proof.
        const stable = await video.evaluate(
          (v) =>
            new Promise((resolve) => {
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(() => resolve(v.currentTime)),
              );
            }),
        );
        expect(stable).toBe(paused.time);
        await click("Play");
        await expect(page.locator(".frame-readout")).toHaveText("Frame 59", { timeout: 5000 });
        await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
        await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
        observations.push({
          label,
          paused,
          end: await video.evaluate((v) => ({
            time: v.currentTime,
            rate: v.playbackRate,
            paused: v.paused,
          })),
          lastFrame: 59,
        });
      };
      await playback("native preview", 'video[aria-label="Canonical video layer 1"]', 1.5);
      if (timing) await timing.capture({ name: "preview", page, owned, identity, executable });
      await choose("Export MP4", output);
      await expect(page.locator(".output-report")).toContainText("Export complete", {
        timeout: 45000,
      });
      const finalProof = decode(output, 60, { rn: 30, rd: 1 });
      fs.writeFileSync(
        path.join(directory, "decoded-final.json"),
        JSON.stringify(finalProof, null, 2),
        { flag: "wx" },
      );
      expect(finalProof.valid).toBe(true);
      await click("Final");
      // Final intentionally retains the canonical playhead; rewind through real transport commands.
      for (let step = 0; step < 12; step++) await click("Step backward five frames");
      await expect(page.locator(".frame-readout")).toHaveText("Frame 0");
      await playback("native final", 'video[aria-label="Verified final video preview"]', 1);
      if (timing) await timing.capture({ name: "final", page, owned, identity, executable });
      fs.writeFileSync(
        path.join(directory, "playback.json"),
        JSON.stringify(
          {
            status: "tool-driven-playback-only-pass",
            timingAccepted: false,
            identity,
            executable,
            executableSha256: hash(bytes),
            sourceProof,
            finalProof,
            observations,
            project,
            output,
            runtime: await browser.version(),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    }
  } catch (error) {
    await diagnose("failure");
    fs.writeFileSync(
      path.join(directory, "failure.json"),
      JSON.stringify({ error: String(error), observations }, null, 2),
    );
    errors.push(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    let result;
    try {
      result = await owned.close();
    } catch (error) {
      errors.push(error);
    }
    fs.writeFileSync(path.join(directory, "owned.json"), JSON.stringify(events, null, 2));
    console.log(JSON.stringify({ directory }));
    if (result?.code !== 0 || !events.some((event) => event.event === "closed" && event.empty))
      errors.push(Error("Owned cleanup not confirmed"));
  }
  if (errors.length) throw new AggregateError(errors, "Native playback or owned cleanup failed");
  // Offline extraction occurs only after actual owned-tree cleanup, outside the lease.
  if (timing) timing.finish();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--print-isolated-config") console.log(JSON.stringify(isolatedConfig));
  else if (process.argv[2] === "--run-native-automated-keyboard-authorized") {
    if (process.argv.length !== 3)
      throw Error("Automated keyboard mode accepts no extra arguments");
    await runNativePlayback({ automatedKeyboardCheck: true });
  } else if (keyboardCli(process.argv.slice(2))) await runNativePlayback({ keyboardCheck: true });
  else if (process.argv[2] === "--run-native-playback-authorized") await runNativePlayback();
  else if (process.argv[2] === "--run-native-timing-authorized") {
    if (!process.argv[3] || process.argv.length !== 4)
      throw Error("Explicit absolute parent-reviewed results.json required");
    await runNativePlayback({ timingProfile: process.argv[3] });
  } else
    throw Error(
      "Explicit --print-isolated-config, --run-native-playback-authorized, --run-native-keyboard-check-authorized or --run-native-timing-authorized required",
    );
}
