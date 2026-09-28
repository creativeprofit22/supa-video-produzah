// One continuous native scenario in the real Tauri v2 + WebView2 app (isolated identifier build).
// Run from repo root: node evidence/2026-09-28-p3-transcription-audio/13-continuous-native-scenario.mjs
import fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startOwned } from "./13-owned.mjs";

const { chromium } = createRequire(path.resolve("apps/desktop/package.json"))("@playwright/test");
const root = path.resolve("evidence/2026-09-28-p3-transcription-audio");
const exe = "E:/nemo-runtime/proof/hwhap-436/scenario/target/debug/supa-video-desktop.exe";
const identifier = "com.supavideo.p3-continuous-scenario-20260928";
const source = "E:\\nemo-runtime\\proof\\hwhap-436\\interview-102-400.mp4";
const runtimeFolder = "E:\\nemo-runtime\\runtime";
const runDir = "E:\\nemo-runtime\\proof\\hwhap-436\\scenario\\run2";
const project = path.join(runDir, "scenario.svpvideo");
const exportPath = path.join(runDir, "export.mp4");
const expectedHash = "050f0b0958e2d56638d58e21e99b35d708d91acc81226b90c510c2926a2f0e51";

const log = [];
const t0 = Date.now();
const record = (event, data = {}) => {
  const entry = { t: Date.now() - t0, at: new Date().toISOString(), event, ...data };
  log.push(entry);
  console.log(JSON.stringify(entry));
  fs.writeFileSync(path.join(root, "13-scenario-log.json"), JSON.stringify(log, null, 2));
};
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

if (!fs.readFileSync(exe).includes(Buffer.from(identifier)))
  throw Error("Refusing to launch: binary is not the isolated-identifier build");
const hashBefore = sha256(source);
record("source-hash-before", { hashBefore, matches: hashBefore === expectedHash });
if (hashBefore !== expectedHash) throw Error("Source hash mismatch before scenario");
if (fs.existsSync(runDir)) throw Error(`Run dir must be fresh: ${runDir}`);
fs.mkdirSync(runDir, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(runDir, "webview");
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
record("launch", { exe, port, project });

const owned = startOwned(exe, ["--p3-continuous-scenario"], {
  leaseMs: 1800000,
  onEvent: (event) => record("owned", { owned: event }),
});
let browser;
const steps = {};
const step = async (name, fn) => {
  const started = Date.now();
  record(`${name}:start`);
  try {
    const result = await fn();
    steps[name] = { status: "PASS", ms: Date.now() - started, ...result };
    record(`${name}:done`, steps[name]);
    return result;
  } catch (error) {
    steps[name] = { status: "FAIL", ms: Date.now() - started, error: String(error?.stack ?? error) };
    record(`${name}:fail`, steps[name]);
    throw error;
  }
};

try {
  const identity = await owned.wait((event) => event.event === "identity", 15000);
  const cdpDeadline = Date.now() + 30000;
  for (;;) {
    try {
      if ((await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > cdpDeadline) throw Error("CDP endpoint did not come up");
    await sleep(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  for (let i = 0; i < 100 && page.url() !== "http://localhost:1420/"; i++) await sleep(100);
  record("page", { url: page.url(), pid: identity.pid });
  await page.waitForFunction(() => typeof globalThis.__TAURI_INTERNALS__?.invoke === "function");
  // Observation only: log every IPC command name + summarized result from the real app.
  const wrapped = await page.evaluate(() => {
    const internals = globalThis.__TAURI_INTERNALS__;
    const original = internals.invoke.bind(internals);
    globalThis.__scenarioIpc = [];
    const summarize = (value) => {
      try {
        return JSON.stringify(value)?.slice(0, 1500);
      } catch {
        return "<unserializable>";
      }
    };
    try {
      internals.invoke = async (cmd, args, options) => {
        const entry = { cmd, t: Date.now(), args: summarize(args)?.slice(0, 600) };
        globalThis.__scenarioIpc.push(entry);
        try {
          const result = await original(cmd, args, options);
          entry.result = summarize(result);
          return result;
        } catch (error) {
          entry.error = summarize(error);
          throw error;
        }
      };
      return internals.invoke !== original;
    } catch {
      return false;
    }
  });
  record("ipc-observer", { wrapped });
  const drainIpc = async (label) => {
    const entries = await page.evaluate(() => globalThis.__scenarioIpc.splice(0));
    record("ipc", { label, entries });
    return entries;
  };

  const dialog = (file) => {
    let out;
    try {
      out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(root, "13-native-dialog.ps1"),
        "-OwnerId",
        String(identity.pid),
        "-Creation",
        identity.creation,
        "-FilePath",
        file,
      ],
      { encoding: "utf8", timeout: 30000 },
      );
    } catch (error) {
      record("native-dialog-error", { file, stdout: error.stdout, stderr: error.stderr });
      throw error;
    }
    record("native-dialog", { file, out: out.trim() });
  };
  const shot = async (name, locator) => {
    const file = path.join(root, name);
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
    record("screenshot", { file: name });
    return name;
  };
  const revision = async () =>
    Number(/Revision (\d+)/.exec(await page.locator(".project-status").innerText())?.[1]);
  const timelineState = async () =>
    page.evaluate(() => {
      const q = (s) => globalThis.document.querySelector(s);
      return {
        visibleClips: q("[aria-label$='visible clips']")?.getAttribute("aria-label") ?? null,
        range: q(".timeline-range")?.textContent ?? null,
        clips: [...globalThis.document.querySelectorAll(".multitrack-clip-body")].map(
          (node) => node.getAttribute("aria-label"),
        ),
        transcriptHelp: q("#transcript-help")?.textContent ?? null,
      };
    });
  const waitFor = async (predicate, ms, label) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > end) throw Error(`Timed out waiting for ${label}`);
      await sleep(500);
    }
  };
  const alerts = async () =>
    page.evaluate(() =>
      [...globalThis.document.querySelectorAll("[role=alert], .inline-error")].map((n) => n.textContent),
    );

  const toolStatus = await page.evaluate(() =>
    globalThis.__TAURI_INTERNALS__.invoke("video_ffmpeg_status"),
  );
  record("tool-status", { toolStatus });

  // Step 1: new project + import
  await step("1-import", async () => {
    await page.getByRole("button", { name: "New project", exact: true }).click();
    dialog(project);
    await waitFor(async () => (await revision()) === 0, 20000, "project");
    await page.getByRole("button", { name: "Choose video", exact: true }).click();
    dialog(source);
    await waitFor(
      async () => {
        const errors = await alerts();
        if (errors.some((text) => /could not|failed/i.test(text ?? "")))
          throw Error(`Import error: ${errors.join(" | ")}`);
        return (await revision()) >= 1;
      },
      600000,
      "import revision 1",
    );
    // wait for the transcript target to exist (a clip with audio on the timeline)
    await waitFor(
      async () => (await page.getByRole("button", { name: "Transcribe", exact: true }).count()) > 0,
      60000,
      "Transcribe button",
    );
    const rev = await revision();
    const timeline = await timelineState();
    const screenshot = await shot("13-01-imported.png");
    await drainIpc("import");
    return { revision: rev, timeline, screenshot, projectExists: fs.existsSync(project) };
  });

  // Step 2: consent + runtime + transcribe
  const transcript = await step("2-transcribe", async () => {
    const panel = page.locator("section.transcript-panel");
    await waitFor(async () => !(await panel.innerText()).includes("Checking the speech"), 30000, "asr status");
    if ((await panel.getByRole("button", { name: "Choose runtime folder" }).count()) > 0) {
      await panel.getByRole("button", { name: "Choose runtime folder" }).click();
      dialog(runtimeFolder);
      try {
        await waitFor(
          async () =>
            (await panel.getByRole("button", { name: "Choose runtime folder" }).count()) === 0,
          600000,
          "runtime ready",
        );
      } catch (error) {
        record("runtime-not-ready", { panelText: await panel.innerText() });
        await shot("13-02-runtime-not-ready.png", panel);
        throw error;
      }
    }
    if ((await panel.getByRole("button", { name: "Review license" }).count()) > 0) {
      await panel.getByRole("button", { name: "Review license" }).click();
      await shot("13-02a-license.png");
      await page.getByRole("button", { name: "Accept license" }).click();
      await panel.getByRole("button", { name: "Withdraw license acceptance" }).waitFor();
    }
    await shot("13-02b-ready.png", panel);
    const transcribe = panel.getByRole("button", { name: "Transcribe", exact: true });
    const started = Date.now();
    await transcribe.click();
    await waitFor(
      async () => {
        const errors = await panel.locator("[role=alert]").allInnerTexts();
        if (errors.length) throw Error(`Transcription alert: ${errors.join(" | ")}`);
        return (await panel.locator("h3.transcript-speaker").count()) > 0;
      },
      600000,
      "speaker headings",
    );
    const transcribeMs = Date.now() - started;
    const speakers = [...new Set(await panel.locator("h3.transcript-speaker").allInnerTexts())];
    if (!speakers.includes("Speaker 1") || !speakers.includes("Speaker 2"))
      throw Error(`Speaker headings missing: ${speakers.join(",")}`);
    const ipc = await drainIpc("transcribe");
    const jobIds = [
      ...new Set(
        ipc
          .flatMap((e) => [e.result ?? "", e.args ?? ""])
          .flatMap((text) => [...text.matchAll(/"(?:jobId|id)":"([^"]*job[^"]*|[0-9a-f-]{36})"/gi)].map((m) => m[1])),
      ),
    ];
    const jobStatus = await panel.locator(".linked-job-status").innerText().catch(() => null);
    const help = await panel.locator("#transcript-help").innerText();
    await shot("13-02c-transcribed.png", panel);
    return {
      transcribeMs,
      speakers,
      headingCount: await panel.locator("h3.transcript-speaker").count(),
      jobStatus,
      help,
      ipcCommands: ipc.map((e) => e.cmd),
      jobIdCandidates: jobIds,
      revision: await revision(),
    };
  });
  record("transcript", transcript);

  const panel = page.locator("section.transcript-panel");
  // Step 3: seek to a mid-transcript word
  await step("3-seek", async () => {
    const items = panel.locator("li.transcript-word-item");
    const count = await items.count();
    // One word item = one word button + its seek button; address both through the item.
    const item = items.nth(Math.floor(count / 2));
    const target = item.locator("button.transcript-seek");
    const label = await target.getAttribute("aria-label");
    const before = await page.locator(".frame-readout").innerText();
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await waitFor(
      async () => (await item.locator("button.transcript-word").getAttribute("aria-current")) === "true",
      10000,
      "aria-current",
    );
    await sleep(500);
    const after = await page.locator(".frame-readout").innerText();
    const at = /at (.+)$/.exec(label)?.[1];
    const screenshot = await shot("13-03-seek.png");
    return {
      label,
      wordCount: count,
      readoutBefore: before,
      readoutAfter: after,
      expectedTime: at,
      readoutContainsTime: at ? after.includes(at) : false,
      screenshot,
      ariaCurrent: await item.locator("button.transcript-word").getAttribute("aria-current"),
    };
  });

  // Step 4: cut with preview, apply, undo
  await step("4-cut", async () => {
    const words = panel.locator("button.transcript-word");
    const texts = await words.allInnerTexts();
    // pick a complete sentence in the middle: starts after a word ending in . ? ! and ends at the next one
    let start = -1;
    let end = -1;
    for (let i = Math.floor(texts.length / 3); i < texts.length - 1; i++) {
      if (/[.?!]$/.test(texts[i])) {
        for (let j = i + 1; j < texts.length; j++) {
          if (/[.?!]$/.test(texts[j])) {
            if (j - i >= 3 && j - i <= 20) {
              start = i + 1;
              end = j;
            }
            break;
          }
        }
        if (start >= 0) break;
      }
    }
    if (start < 0) throw Error("No sentence found");
    const sentence = texts.slice(start, end + 1).join(" ");
    const revBefore = await revision();
    const timelineBefore = await timelineState();
    for (let i = start; i <= end; i++) {
      await words.nth(i).scrollIntoViewIfNeeded();
      await words.nth(i).click();
    }
    const n = end - start + 1;
    const pressed = await panel.locator("button.transcript-word[aria-pressed=true]").count();
    await panel.getByRole("button", { name: `Remove ${n} selected words` }).click();
    const cutDialog = page.locator("dialog.transcript-cut-dialog");
    await cutDialog.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Apply cut" }).waitFor();
    const dialogText = await cutDialog.innerText();
    const previewShot = await shot("13-04a-review-cut.png");
    const revDuringPreview = await revision();
    const timelineDuringPreview = await timelineState();
    await page.getByRole("button", { name: "Apply cut" }).click();
    await waitFor(async () => (await revision()) > revBefore, 30000, "cut revision");
    await sleep(1000);
    const revAfterCut = await revision();
    const timelineAfterCut = await timelineState();
    const cutShot = await shot("13-04b-after-cut.png");
    await page
      .getByRole("group", { name: "Edit history" })
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await waitFor(async () => (await revision()) !== revAfterCut, 30000, "undo revision");
    await sleep(1000);
    const revAfterUndo = await revision();
    const timelineAfterUndo = await timelineState();
    const undoShot = await shot("13-04c-after-undo.png");
    const ipc = await drainIpc("cut");
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const checks = {
      previewUnchanged: revDuringPreview === revBefore && same(timelineDuringPreview, timelineBefore),
      cutIncremented: revAfterCut === revBefore + 1,
      cutChangedTimeline: !same(timelineAfterCut.clips, timelineBefore.clips),
      undoRestoredTimeline: same(timelineAfterUndo.clips, timelineBefore.clips),
      undoRestoredWordCount: timelineAfterUndo.transcriptHelp === timelineBefore.transcriptHelp,
    };
    if (!Object.values(checks).every(Boolean)) throw Error(`Cut checks failed: ${JSON.stringify(checks)}`);
    return {
      sentence,
      n,
      pressed,
      dialogText,
      revBefore,
      revDuringPreview,
      revAfterCut,
      revAfterUndo,
      timelineBefore,
      timelineAfterCut,
      timelineAfterUndo,
      checks,
      ipcCommands: ipc.map((e) => `${e.cmd}${e.error ? " (error)" : ""}`),
      screenshots: [previewShot, cutShot, undoShot],
    };
  });

  // Step 5: captions + frame shapes
  await step("5-captions", async () => {
    const revBefore = await revision();
    const generate = panel.getByRole("button", { name: "Generate captions" });
    record("captions-button", { disabled: await generate.isDisabled() });
    await generate.click();
    try {
      await waitFor(async () => (await revision()) > revBefore, 60000, "captions revision");
    } catch (error) {
      record("captions-not-applied", {
        alerts: await alerts(),
        statusText: await page.locator("[role=status]").allInnerTexts(),
      });
      await shot("13-05-captions-failed.png");
      throw error;
    }
    const captions = page.locator("section.captions-panel");
    await captions.waitFor();
    const cueCount = await captions.locator(".captions-cues > li").count();
    // seek to a spoken word so a caption is on screen
    const seek = panel.locator("button.transcript-seek").nth(20);
    await seek.scrollIntoViewIfNeeded();
    await seek.click();
    const shapes = [];
    for (const [name, file] of [
      ["Widescreen 16:9", "13-05a-frame-16x9.png"],
      ["Square 1:1", "13-05b-frame-1x1.png"],
      ["Vertical 9:16", "13-05c-frame-9x16.png"],
    ]) {
      const radio = captions.getByRole("radio", { name });
      const rev = await revision();
      if (!(await radio.isChecked())) {
        // The radio is controlled by the saved frame, so it only turns on once
        // the frame change is committed: click, then wait for the new revision.
        await radio.click();
        try {
          await waitFor(async () => (await revision()) > rev, 30000, `${name} revision`);
        } catch (error) {
          record("frame-not-applied", {
            name,
            alerts: await alerts(),
            panelText: (await captions.innerText()).slice(0, 600),
          });
          throw error;
        }
        await waitFor(async () => radio.isChecked(), 10000, `${name} checked`);
      }
      await sleep(1500);
      const frameText = await captions.locator("fieldset").first().innerText();
      const stage = page.locator(".monitor-stage");
      const box = await stage.boundingBox();
      const orientation = await stage.getAttribute("data-frame-orientation");
      const style = await stage.getAttribute("style");
      const overlay = await page.locator(".monitor-caption-overlay").allInnerTexts();
      await stage.scrollIntoViewIfNeeded();
      const screenshot = await shot(file, stage);
      shapes.push({
        name,
        revision: await revision(),
        frameText: /\d+ x \d+/.exec(frameText)?.[0],
        box,
        orientation,
        style,
        overlay,
        screenshot,
      });
    }
    await drainIpc("captions");
    return { revBefore, cueCount, shapes, exportShape: "Vertical 9:16" };
  });

  // Step 6: clip fades + loudness target
  await step("6-audio", async () => {
    const fps = 30;
    // Start from an empty selection so the click selects exactly one clip
    // (clicking an already-selected clip would deselect it).
    await page.getByRole("button", { name: "Clear selection" }).click();
    const selects = page.getByRole("button", { name: /^Select / });
    const count = await selects.count();
    let found = false;
    for (let i = 0; i < count && !found; i++) {
      await page.getByRole("button", { name: "Clear selection" }).click();
      await selects.nth(i).click();
      await sleep(300);
      found = (await page.locator("section.clip-audio-inspector").count()) > 0;
    }
    if (!found) {
      record("audio-inspector-missing", {
        selectButtons: count,
        selectionStatus: await page.getByText(/clips selected/u).allInnerTexts(),
      });
      throw Error("Clip audio inspector did not appear for any timeline clip");
    }
    const inspector = page.locator("section.clip-audio-inspector");
    await inspector.getByLabel("Fade in (sequence frames)").fill(String(fps));
    await inspector.getByLabel("Fade out (sequence frames)").fill(String(fps));
    const revBeforeFade = await revision();
    await inspector.getByRole("button", { name: "Apply audio" }).click();
    await waitFor(async () => (await revision()) > revBeforeFade, 30000, "fade revision");
    await sleep(800);
    const fadeValues = {
      in: await inspector.getByLabel("Fade in (sequence frames)").inputValue(),
      out: await inspector.getByLabel("Fade out (sequence frames)").inputValue(),
    };
    const audio = page.locator("section.audio-panel");
    const revBeforeTarget = await revision();
    await audio.locator("select").last().selectOption("-16");
    await waitFor(async () => (await revision()) > revBeforeTarget, 30000, "loudness revision");
    await sleep(800);
    const target = await audio.locator("select").last().inputValue();
    const screenshot = await shot("13-06-audio.png");
    await drainIpc("audio");
    return {
      clipLabel: await inspector.locator("p").first().innerText(),
      fadeValues,
      revBeforeFade,
      revAfterFade: revBeforeTarget,
      target,
      revAfterTarget: await revision(),
      screenshot,
    };
  });

  // Step 7: export
  await step("7-export", async () => {
    const exportPanel = page.locator("section[aria-labelledby=export-title]");
    const button = exportPanel.getByRole("button", { name: "Export MP4" });
    await button.scrollIntoViewIfNeeded();
    const started = Date.now();
    await button.click();
    dialog(exportPath);
    const audio = page.locator("section.audio-panel");
    await waitFor(
      async () => {
        const errors = (await alerts()).filter((text) => /export|render|fail/i.test(text ?? ""));
        if (errors.length) throw Error(`Export alert: ${errors.join(" | ")}`);
        return (await audio.locator(".audio-report-list").count()) > 0;
      },
      1500000,
      "export loudness report",
    );
    const exportMs = Date.now() - started;
    const report = await audio.locator("section.audio-report").innerText();
    const exportText = await exportPanel.innerText().catch(() => null);
    await shot("13-07-export-done.png");
    const ipc = await drainIpc("export");
    return {
      exportMs,
      report,
      exportText,
      revision: await revision(),
      exists: fs.existsSync(exportPath),
      ipcCommands: ipc.map((e) => e.cmd),
      renderResults: ipc.filter((e) => /render|export/i.test(e.cmd)).map((e) => ({ cmd: e.cmd, result: e.result, error: e.error })),
    };
  });
} catch (error) {
  record("scenario-error", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  record("steps", { steps });
  if (browser) await browser.close().catch(() => {});
  const exit = await owned.close();
  record("closed", { exit });
  const hashAfter = sha256(source);
  record("source-hash-after", { hashAfter, unchanged: hashAfter === hashBefore });
}
