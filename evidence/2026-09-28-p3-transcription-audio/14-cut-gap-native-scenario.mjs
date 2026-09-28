// Step 14: rerun import -> transcribe -> delete one sentence -> preview -> apply -> undo in the
// real Tauri v2 + WebView2 app, after the fix that removes the pauses inside a deleted sentence.
// Reuses the step-13 isolated build, owned launcher and native dialog answerer.
// Run from repo root: node evidence/2026-09-28-p3-transcription-audio/14-cut-gap-native-scenario.mjs
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
const runDir = "E:\\nemo-runtime\\proof\\hwhap-436\\scenario\\run3-cutgap";
const project = path.join(runDir, "scenario.svpvideo");
const expectedHash = "050f0b0958e2d56638d58e21e99b35d708d91acc81226b90c510c2926a2f0e51";
const logFile = path.join(root, "14-scenario-log.json");

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

const owned = startOwned(exe, ["--p3-cut-gap-scenario"], {
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
      screenshot: await shot("14-01-imported.png"),
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
      screenshot: await shot("14-02-transcribed.png", panel),
    };
  });

  // Steps 3-6: delete one sentence -> preview -> apply -> undo
  await step("3-cut-preview-apply-undo", async () => {
    const words = panel.locator("button.transcript-word");
    const texts = await words.allInnerTexts();
    // Same rule as step 13: the first complete 4-21 word sentence after the first third.
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
    const wordsBefore = texts.length;

    const before = (await inspect()).revision;
    const revBefore = await revision();
    const timelineBefore = await timelineState();

    for (let i = start; i <= end; i++) {
      await words.nth(i).scrollIntoViewIfNeeded();
      await words.nth(i).click();
    }
    const n = end - start + 1;
    await panel.getByRole("button", { name: `Remove ${n} selected words` }).click();
    const cutDialog = page.locator("dialog.transcript-cut-dialog");
    await cutDialog.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Apply cut" }).waitFor();
    const dialogText = await cutDialog.innerText();
    const previewShot = await shot("14-03a-review-cut.png");
    const revDuringPreview = await revision();
    const timelineDuringPreview = await timelineState();
    const duringPreview = (await inspect()).revision;

    await page.getByRole("button", { name: "Apply cut" }).click();
    await waitFor(async () => (await revision()) > revBefore, 30000, "cut revision");
    await sleep(1000);
    const revAfterCut = await revision();
    const timelineAfterCut = await timelineState();
    const cutShot = await shot("14-03b-after-cut.png");
    const cut = (await inspect()).revision;

    await page
      .getByRole("group", { name: "Edit history" })
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await waitFor(async () => (await revision()) !== revAfterCut, 30000, "undo revision");
    await sleep(1000);
    const revAfterUndo = await revision();
    const timelineAfterUndo = await timelineState();
    const undoShot = await shot("14-03c-after-undo.png");
    const undo = await inspect();
    const wordsAfterUndo = await words.count();

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const clipsAfterCut = timelineAfterCut.clips.length;
    const checks = {
      previewChangedNothing:
        revDuringPreview === revBefore &&
        same(timelineDuringPreview, timelineBefore) &&
        duringPreview.id === before.id &&
        duringPreview.stateHash === before.stateHash,
      cutIncrementedRevision: revAfterCut === revBefore + 1 && cut.stateHash !== before.stateHash,
      // A sentence inside one clip becomes exactly two clips: before it and after it.
      noGapClipsLeft: timelineBefore.clips.length === 1 && clipsAfterCut === 2,
      undoMovedOffCutRevision: undo.revision.id !== cut.id && undo.revision.stateHash !== cut.stateHash,
      undoStateHashIdentical: undo.revision.stateHash === before.stateHash,
      undoTimelineIdentical: same(timelineAfterUndo, timelineBefore),
      undoWordCountIdentical: wordsAfterUndo === wordsBefore,
    };
    const result = {
      sentence,
      n,
      dialogText,
      revBefore,
      revDuringPreview,
      revAfterCut,
      revAfterUndo,
      revisionBefore: before,
      revisionAfterCut: cut,
      revisionAfterUndo: undo.revision,
      lastCommandAfterUndo: undo.lastCommand,
      timelineBefore,
      timelineAfterCut,
      timelineAfterUndo,
      wordsBefore,
      wordsAfterUndo,
      checks,
      screenshots: [previewShot, cutShot, undoShot],
    };
    if (!Object.values(checks).every(Boolean)) {
      record("cut-checks-failed", result);
      throw Error(`Cut checks failed: ${JSON.stringify(checks)}`);
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
