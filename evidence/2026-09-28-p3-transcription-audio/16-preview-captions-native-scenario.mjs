// Step 16: prove captions show in the live preview (not only the export) at 16:9, 1:1 and 9:16,
// in the real Tauri v2 + WebView2 app. Fresh project: import -> transcribe -> generate captions ->
// seek onto a spoken word -> read the monitor overlay and screenshot the stage per frame shape.
// Run from repo root: node evidence/2026-09-28-p3-transcription-audio/16-preview-captions-native-scenario.mjs
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
const runDir = "E:\\nemo-runtime\\proof\\hwhap-436\\scenario\\run4-preview-captions";
const project = path.join(runDir, "scenario.svpvideo");
const expectedHash = "050f0b0958e2d56638d58e21e99b35d708d91acc81226b90c510c2926a2f0e51";
const logFile = path.join(root, "16-scenario-log.json");

const log = [];
const t0 = Date.now();
const record = (event, data = {}) => {
  const entry = { t: Date.now() - t0, at: new Date().toISOString(), event, ...data };
  log.push(entry);
  console.log(JSON.stringify(entry));
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
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

const owned = startOwned(exe, ["--p3-preview-captions-scenario"], {
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
  // Exact project state, read-only: the app's own inspector command returns the head revision,
  // whose stateHash is the SHA-256 of the canonical serialized project state (project/hash.rs).
  // (Wrapping invoke to observe the app's calls does not see them in this build; step 13 logged 0.)
  const inspect = async () => {
    const projectId = JSON.parse(fs.readFileSync(project, "utf8")).id;
    const inspector = await page.evaluate(
      (id) => globalThis.__TAURI_INTERNALS__.invoke("video_project_inspector", { projectId: id }),
      projectId,
    );
    record("inspector", { projectId, revision: inspector.revision });
    return inspector;
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
        clips: [...globalThis.document.querySelectorAll(".multitrack-clip-body")].map((node) =>
          node.getAttribute("aria-label"),
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
    await waitFor(
      async () => (await page.getByRole("button", { name: "Transcribe", exact: true }).count()) > 0,
      60000,
      "Transcribe button",
    );
    return {
      revision: await revision(),
      timeline: await timelineState(),
      screenshot: await shot("16-01-imported.png"),
    };
  });

  // Step 2: consent + runtime + transcribe (cold: fresh app data, no cached transcript)
  const panel = page.locator("section.transcript-panel");
  await step("2-transcribe", async () => {
    await waitFor(async () => !(await panel.innerText()).includes("Checking the speech"), 30000, "asr status");
    if ((await panel.getByRole("button", { name: "Choose runtime folder" }).count()) > 0) {
      await panel.getByRole("button", { name: "Choose runtime folder" }).click();
      dialog(runtimeFolder);
      await waitFor(
        async () => (await panel.getByRole("button", { name: "Choose runtime folder" }).count()) === 0,
        600000,
        "runtime ready",
      );
    }
    if ((await panel.getByRole("button", { name: "Review license" }).count()) > 0) {
      await panel.getByRole("button", { name: "Review license" }).click();
      await page.getByRole("button", { name: "Accept license" }).click();
      await panel.getByRole("button", { name: "Withdraw license acceptance" }).waitFor();
    }
    const started = Date.now();
    await panel.getByRole("button", { name: "Transcribe", exact: true }).click();
    await waitFor(
      async () => {
        const errors = await panel.locator("[role=alert]").allInnerTexts();
        if (errors.length) throw Error(`Transcription alert: ${errors.join(" | ")}`);
        return (await panel.locator("h3.transcript-speaker").count()) > 0;
      },
      600000,
      "speaker headings",
    );
    const speakers = [...new Set(await panel.locator("h3.transcript-speaker").allInnerTexts())];
    if (!speakers.includes("Speaker 1") || !speakers.includes("Speaker 2"))
      throw Error(`Speaker headings missing: ${speakers.join(",")}`);
    return {
      transcribeMs: Date.now() - started,
      speakers,
      wordCount: await panel.locator("button.transcript-word").count(),
      help: await panel.locator("#transcript-help").innerText(),
      revision: await revision(),
      screenshot: await shot("16-02-transcribed.png", panel),
    };
  });


  // Step 3: generate captions, seek onto a spoken word, check the live preview overlay per frame shape
  await step("3-preview-captions", async () => {
    const revBefore = await revision();
    await panel.getByRole("button", { name: "Generate captions" }).click();
    await waitFor(async () => (await revision()) > revBefore, 60000, "captions revision");
    const captions = page.locator("section.captions-panel");
    await captions.waitFor();
    const cueCount = await captions.locator(".captions-cues > li").count();
    const firstCues = (await captions.locator(".captions-cues > li").allInnerTexts()).slice(0, 3);

    const items = panel.locator("li.transcript-word-item");
    const item = items.nth(Math.floor((await items.count()) / 2));
    const seekLabel = await item.locator("button.transcript-seek").getAttribute("aria-label");
    await item.locator("button.transcript-seek").scrollIntoViewIfNeeded();
    await item.locator("button.transcript-seek").click();
    await waitFor(
      async () => (await item.locator("button.transcript-word").getAttribute("aria-current")) === "true",
      10000,
      "aria-current",
    );
    const frameReadout = await page.locator(".frame-readout").innerText();

    const shapes = [];
    for (const [name, file] of [
      ["Widescreen 16:9", "16-03a-preview-16x9.png"],
      ["Square 1:1", "16-03b-preview-1x1.png"],
      ["Vertical 9:16", "16-03c-preview-9x16.png"],
    ]) {
      const radio = captions.getByRole("radio", { name });
      const rev = await revision();
      if (!(await radio.isChecked())) {
        await radio.click();
        await waitFor(async () => (await revision()) > rev, 30000, `${name} revision`);
        await waitFor(async () => radio.isChecked(), 10000, `${name} checked`);
      }
      const stage = page.locator(".monitor-stage");
      let overlay = [];
      try {
        await waitFor(
          async () => (overlay = await page.locator(".monitor-caption-overlay").allInnerTexts()).length > 0,
          10000,
          `${name} caption overlay`,
        );
      } catch {
        /* recorded as empty below */
      }
      const stageBox = await stage.boundingBox();
      const overlayBox = overlay.length ? await page.locator(".monitor-caption-overlay").boundingBox() : null;
      await stage.scrollIntoViewIfNeeded();
      shapes.push({
        name,
        revision: await revision(),
        frameText: /\d+ x \d+/.exec(await captions.locator("fieldset").first().innerText())?.[0],
        orientation: await stage.getAttribute("data-frame-orientation"),
        frameReadout: await page.locator(".frame-readout").innerText(),
        stageBox,
        overlay,
        overlayBox,
        overlayInsideStage:
          overlayBox !== null &&
          stageBox !== null &&
          overlayBox.x >= stageBox.x - 1 &&
          overlayBox.y >= stageBox.y - 1 &&
          overlayBox.x + overlayBox.width <= stageBox.x + stageBox.width + 1 &&
          overlayBox.y + overlayBox.height <= stageBox.y + stageBox.height + 1,
        screenshot: await shot(file, stage),
      });
    }
    const result = { cueCount, firstCues, seekLabel, frameReadout, shapes };
    const ok = cueCount > 0 && shapes.every((s) => s.overlay.join("").trim().length > 0 && s.overlayInsideStage);
    if (!ok) {
      // Read the monitor's live React props (read-only) to see why no overlay rendered.
      result.monitorProps = await page.evaluate(() => {
        const stage = globalThis.document.querySelector(".monitor-stage");
        const key = Object.keys(stage ?? {}).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? stage[key] : null; f; f = f.return) {
          const p = f.memoizedProps;
          if (p && "activeCaptions" in p)
            return {
              previewMode: p.previewMode ?? null,
              activeCaptions: p.activeCaptions,
              compositionPlayhead: p.compositionPlayhead ?? null,
              layers: (p.sourceLayers ?? p.layers ?? []).map((l) => ({
                clipId: l.clipId,
                start: l.timelineStartFrame,
                dur: l.timelineDurationFrames,
                in: l.sourceInFrame,
                out: l.sourceOutFrame,
                hidden: l.hidden,
                audioOnly: l.audioOnly,
              })),
              propKeys: Object.keys(p).sort(),
            };
        }
        return null;
      });
      const state = (await inspect()).state ?? {};
      const seq = (state.sequences ?? []).find((s) => s.id === state.activeSequenceId);
      result.savedSequence = seq
        ? {
            rate: seq.rate,
            tracks: seq.tracks.map((t) => ({
              kind: t.kind,
              id: t.id,
              hidden: t.hidden ?? null,
              flags: Object.keys(t).sort(),
              captionCount: t.captions?.length ?? null,
              firstCaptions: t.captions?.slice(0, 2) ?? null,
            })),
          }
        : { inspectorKeys: Object.keys(state) };
      record("preview-caption-checks-failed", result);
      throw Error("Live preview caption overlay missing or outside the frame");
    }
    return result;
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
