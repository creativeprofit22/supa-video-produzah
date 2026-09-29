// P3 agent proposals, real Tauri v2 + WebView2 app with SUPA_VIDEO_AGENT_PROPOSALS=1 (read at
// runtime by AgentProposalsSwitch::from_env, apps/desktop/src-tauri/src/lib.rs:86).
// Adapted from ../2026-09-28-p3-transcription-audio/16-preview-captions-native-scenario.mjs.
// One fresh project: import -> transcribe -> find filler words -> partial apply -> restore ->
// stale proposal -> clean close + relaunch with a proposal pending -> reject.
// Run from repo root: node evidence/2026-09-29-p3-agent-proposals/01-proposals-native-scenario.mjs [runDirName] [prefix]
import fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startOwned } from "../2026-09-28-p3-transcription-audio/13-owned.mjs";

const { chromium } = createRequire(path.resolve("apps/desktop/package.json"))("@playwright/test");
const root = path.resolve("evidence/2026-09-29-p3-agent-proposals");
const helpers = path.resolve("evidence/2026-09-28-p3-transcription-audio");
const exe = "E:/nemo-runtime/proof/hwhap-436/scenario/target/debug/supa-video-desktop.exe";
const identifier = "com.supavideo.p3-continuous-scenario-20260928";
const source = "E:\\nemo-runtime\\proof\\hwhap-436\\interview-102-400.mp4";
const runtimeFolder = "E:\\nemo-runtime\\runtime";
const runDir = `E:\\nemo-runtime\\proof\\hwhap-436\\scenario\\${process.argv[2] ?? "run5-agent-proposals"}`;
const prefix = process.argv[3] ?? "01-";
const project = path.join(runDir, "scenario.svpvideo");
const expectedHash = "050f0b0958e2d56638d58e21e99b35d708d91acc81226b90c510c2926a2f0e51";
const logFile = path.join(root, `${prefix}scenario-log.json`);

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(runDir, "webview");
process.env.SUPA_VIDEO_AGENT_PROPOSALS = "1";

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
const waitFor = async (predicate, ms, label) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${label}`);
    await sleep(500);
  }
};

// One app session: launch, CDP connect, helpers bound to that page.
async function launch(tag) {
  const port = await freePort();
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  record("launch", { tag, exe, port, project, agentProposalsEnv: process.env.SUPA_VIDEO_AGENT_PROPOSALS });
  const owned = startOwned(exe, [`--p3-agent-proposals-scenario-${tag}`], {
    leaseMs: 1800000,
    onEvent: (event) => record("owned", { tag, owned: event }),
  });
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
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  for (let i = 0; i < 100 && page.url() !== "http://localhost:1420/"; i++) await sleep(100);
  record("page", { tag, url: page.url(), pid: identity.pid });
  await page.waitForFunction(() => typeof globalThis.__TAURI_INTERNALS__?.invoke === "function");
  return { owned, identity, browser, page };
}

let session;
try {
  session = await launch("a");
  let { page, identity } = session;

  const invoke = (cmd, args) =>
    page.evaluate(([c, a]) => globalThis.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const projectId = () => JSON.parse(fs.readFileSync(project, "utf8")).id;
  // Read-only native views: head revision (inspector) and the stored proposals (list command).
  const inspectRevision = async () => (await invoke("video_project_inspector", { projectId: projectId() })).revision;
  const nativeProposals = async () => {
    const listing = await invoke("video_list_proposals", { projectId: projectId() });
    return listing.proposals.map((p) => ({
      id: p.proposalId,
      status: p.status,
      reason: p.statusReason ?? null,
      base: p.baseRevision?.number ?? p.baseRevision ?? null,
      ranges: p.proposal?.deletedRanges?.length ?? null,
    }));
  };
  const dialog = (file) => {
    let out;
    try {
      out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          path.join(helpers, "13-native-dialog.ps1"),
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
    const file = path.join(root, `${prefix}${name}`);
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
    record("screenshot", { file: `${prefix}${name}` });
    return `${prefix}${name}`;
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
        bands: [...globalThis.document.querySelectorAll(".multitrack-proposal-range")].map((node) => ({
          start: Number(node.getAttribute("data-proposal-start")),
          end: Number(node.getAttribute("data-proposal-end")),
          accepted: node.classList.contains("is-accepted"),
        })),
      };
    });
  const alerts = async () =>
    page.evaluate(() =>
      [...globalThis.document.querySelectorAll("[role=alert], .inline-error")].map((n) => n.textContent),
    );
  const bind = () => {
    panel = page.locator("section.transcript-panel");
    proposals = page.locator("section.proposals-panel");
  };
  let panel;
  let proposals;
  bind();
  const panelState = async () => ({
    present: (await proposals.count()) > 0,
    heading: (await proposals.count()) ? await proposals.locator("h2").innerText() : null,
    pending: await proposals.locator("fieldset.proposals-fieldset legend").allInnerTexts(),
    ranges: await proposals.locator(".proposals-range").allInnerTexts(),
    checked: await proposals.locator(".proposals-range input:checked").count(),
    history: await proposals.locator(".proposals-history-item").allInnerTexts(),
    message: (await proposals.locator("[role=status], [role=alert]").allInnerTexts()).join(" | ") || null,
    applyButtons: await proposals.getByRole("button", { name: /^Apply \d+ of \d+$/ }).allInnerTexts(),
  });
  const wordCount = async () => panel.locator("button.transcript-word").count();
  const snapshot = async () => ({
    revision: await revision(),
    wordCount: await wordCount(),
    timeline: await timelineState(),
    panel: await panelState(),
  });
  const findFillers = async () => {
    const before = (await panelState()).pending.length;
    await proposals.getByRole("button", { name: "Find filler words", exact: true }).click();
    await waitFor(
      async () => {
        const s = await panelState();
        if ((await proposals.locator("[role=alert]").count()) > 0) throw Error(`Proposal alert: ${s.message}`);
        if (/Nothing to suggest/.test(s.message ?? "")) throw Error(`No proposals: ${s.message}`);
        return s.pending.length > before && /suggested cuts ready/.test(s.message ?? "");
      },
      30000,
      "filler proposal",
    );
    await sleep(500);
  };
  const ensureTranscript = async () => {
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
    const button = panel.getByRole("button", { name: /^Transcribe( again)?$/ });
    if ((await wordCount()) === 0) {
      await button.click();
      await waitFor(
        async () => {
          const errors = await panel.locator("[role=alert]").allInnerTexts();
          if (errors.length) throw Error(`Transcription alert: ${errors.join(" | ")}`);
          return (await panel.locator("h3.transcript-speaker").count()) > 0;
        },
        600000,
        "speaker headings",
      );
    }
    return { transcribeMs: Date.now() - started };
  };

  // Step 1: new project + import + transcribe; proposals panel present with the switch on.
  await step("1-import-transcribe", async () => {
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
    const t = await ensureTranscript();
    const status = await invoke("video_agent_proposals_status", {});
    await proposals.waitFor();
    await proposals.getByRole("button", { name: "Find filler words", exact: true }).waitFor();
    const s = await snapshot();
    if (!status.enabled || !s.panel.present) throw Error("Proposals panel not present with switch on");
    return {
      ...t,
      switchStatus: status,
      speakers: [...new Set(await panel.locator("h3.transcript-speaker").allInnerTexts())],
      findFillerEnabled: await proposals.getByRole("button", { name: "Find filler words" }).isEnabled(),
      ...s,
      screenshot: await shot("01-transcribed-panel.png"),
    };
  });

  // Step 2: find filler words; nothing is applied while only proposed.
  let base;
  await step("2-find-fillers", async () => {
    base = await snapshot();
    const inspectorBefore = await inspectRevision();
    await findFillers();
    const s = await snapshot();
    const inspectorAfter = await inspectRevision();
    const checks = {
      oneProposal: s.panel.pending.length === 1,
      hasCuts: s.panel.ranges.length > 0,
      bandsShown: s.timeline.bands.length === s.panel.ranges.length,
      revisionUnchanged: s.revision === base.revision,
      stateUnchanged: JSON.stringify(inspectorBefore) === JSON.stringify(inspectorAfter),
      clipsUnchanged: JSON.stringify(s.timeline.clips) === JSON.stringify(base.timeline.clips),
    };
    const result = {
      groupName: s.panel.pending[0],
      cuts: s.panel.ranges.length,
      ranges: s.panel.ranges,
      bands: s.timeline.bands,
      revisionBefore: base.revision,
      revisionAfter: s.revision,
      inspectorRevisionBefore: inspectorBefore,
      inspectorRevisionAfter: inspectorAfter,
      message: s.panel.message,
      native: await nativeProposals(),
      checks,
      screenshot: await shot("02-proposed.png", proposals),
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step2-checks-failed", result);
      throw Error(`Proposal checks failed: ${JSON.stringify(checks)}`);
    }
    return result;
  });

  // Step 3: untick one cut, Apply the rest.
  let preApply;
  let postApply;
  await step("3-partial-apply", async () => {
    preApply = await snapshot();
    const boxes = proposals.locator(".proposals-range input[type=checkbox]");
    const total = await boxes.count();
    if (total < 2) throw Error(`Need at least 2 cuts for partial approval, got ${total}`);
    await boxes.nth(0).uncheck();
    const untickedLabel = await proposals.locator(".proposals-range").nth(0).innerText();
    const applyName = `Apply ${total - 1} of ${total}`;
    const apply = proposals.getByRole("button", { name: applyName, exact: true });
    await apply.waitFor();
    const bandsBeforeApply = (await timelineState()).bands;
    const shotBefore = await shot("03a-unticked.png", proposals);
    await apply.click();
    await waitFor(
      async () => {
        const s = await panelState();
        if ((await proposals.locator("[role=alert]").count()) > 0) throw Error(`Apply alert: ${s.message}`);
        return /Proposal applied/.test(s.message ?? "") && (await revision()) > preApply.revision;
      },
      60000,
      "Proposal applied",
    );
    await sleep(1000);
    postApply = await snapshot();
    const native = await nativeProposals();
    const checks = {
      revisionAdvancedByOne: postApply.revision === preApply.revision + 1,
      noPending: postApply.panel.pending.length === 0,
      historyApplied: postApply.panel.history.some((h) => /Applied/.test(h)),
      restoreOffered: (await proposals.getByRole("button", { name: "Restore to before" }).count()) === 1,
      bandsCleared: postApply.timeline.bands.length === 0,
      wordsRemoved: postApply.wordCount === preApply.wordCount - (total - 1),
    };
    const result = {
      offered: total,
      untickedLabel,
      appliedCuts: total - 1,
      bandsBeforeApply,
      revisionBefore: preApply.revision,
      revisionAfter: postApply.revision,
      visibleClipsBefore: preApply.timeline.visibleClips,
      visibleClipsAfter: postApply.timeline.visibleClips,
      clipCountAfter: postApply.timeline.clips.length,
      wordCountBefore: preApply.wordCount,
      wordCountAfter: postApply.wordCount,
      message: postApply.panel.message,
      history: postApply.panel.history,
      native,
      checks,
      screenshots: [shotBefore, await shot("03b-applied.png", proposals)],
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step3-checks-failed", result);
      throw Error(`Apply checks failed: ${JSON.stringify(checks)}`);
    }
    return result;
  });

  // Step 4: Restore to before.
  await step("4-restore", async () => {
    await proposals.getByRole("button", { name: "Restore to before" }).click();
    await waitFor(
      async () => {
        const s = await panelState();
        if ((await proposals.locator("[role=alert]").count()) > 0) throw Error(`Restore alert: ${s.message}`);
        return /Restored to before/.test(s.message ?? "") && (await revision()) > postApply.revision;
      },
      60000,
      "Restored",
    );
    await sleep(1000);
    const s = await snapshot();
    const checks = {
      revisionAdvanced: s.revision > postApply.revision,
      clipsMatchPreApply: JSON.stringify(s.timeline.clips) === JSON.stringify(preApply.timeline.clips),
      visibleClipsMatchPreApply: s.timeline.visibleClips === preApply.timeline.visibleClips,
      wordCountMatchesPreApply: s.wordCount === preApply.wordCount,
      historyRestored: s.panel.history.some((h) => /Restored to before/.test(h)),
    };
    const result = {
      revisionBefore: postApply.revision,
      revisionAfter: s.revision,
      visibleClips: s.timeline.visibleClips,
      clipCount: s.timeline.clips.length,
      wordCount: s.wordCount,
      message: s.panel.message,
      history: s.panel.history,
      native: await nativeProposals(),
      checks,
      screenshot: await shot("04-restored.png", proposals),
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step4-checks-failed", result);
      throw Error(`Restore checks failed: ${JSON.stringify(checks)}`);
    }
    return result;
  });

  // Step 5: fresh proposal, then an ordinary transcript cut that removes a proposed filler word,
  // so the base revision moves and the proposal can no longer be placed. Then try Apply.
  await step("5-stale", async () => {
    await findFillers();
    const proposed = await snapshot();
    const firstRange = await proposals.locator(".proposals-range").nth(0).innerText();
    const at = /^(\S+) to /.exec(firstRange)?.[1];
    // Cut the transcript word at the first proposed filler's start time, plus its neighbour.
    const items = panel.locator("li.transcript-word-item");
    const labels = await items.locator("button.transcript-seek").evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("aria-label")),
    );
    const index = labels.findIndex((label) => label?.endsWith(` at ${at}`));
    if (index < 0) throw Error(`No transcript word at ${at}`);
    const words = panel.locator("button.transcript-word");
    const picked = [index, index + 1];
    for (const i of picked) {
      await words.nth(i).scrollIntoViewIfNeeded();
      await words.nth(i).click();
    }
    const cutWords = (await words.allInnerTexts()).slice(index, index + 2);
    await panel.getByRole("button", { name: "Remove 2 selected words" }).click();
    await page.getByRole("button", { name: "Apply cut" }).click();
    await waitFor(async () => (await revision()) > proposed.revision, 30000, "cut revision");
    await sleep(2000);
    const afterEdit = await snapshot();
    const applyButton = proposals.getByRole("button", { name: /^Apply \d+ of \d+$/ });
    const applyEnabledBeforeClick = (await applyButton.count()) > 0 && (await applyButton.isEnabled());
    if (applyEnabledBeforeClick) {
      await applyButton.click();
      await sleep(3000);
    }
    const after = await snapshot();
    const staleText = (await proposals.locator(".proposals-fieldset [role=alert]").allInnerTexts()).join(" | ");
    const checks = {
      editMovedRevision: afterEdit.revision === proposed.revision + 1,
      staleShown: /changed too much|out of date/i.test(`${staleText} ${after.panel.message ?? ""}`),
      nothingApplied: after.revision === afterEdit.revision,
      wordsUnchangedByApply: after.wordCount === afterEdit.wordCount,
      noAppliedInHistory: !after.panel.history.slice(0, 1).some((h) => /: Applied/.test(h)),
    };
    const result = {
      proposalRevision: proposed.revision,
      proposalCuts: proposed.panel.ranges.length,
      firstRange,
      cutWords,
      revisionAfterEdit: afterEdit.revision,
      applyEnabledBeforeClick,
      revisionAfterApplyAttempt: after.revision,
      wordCountAfterEdit: afterEdit.wordCount,
      wordCountAfterApplyAttempt: after.wordCount,
      staleText,
      message: after.panel.message,
      history: after.panel.history,
      pending: after.panel.pending,
      native: await nativeProposals(),
      checks,
      screenshot: await shot("05-stale.png", proposals),
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step5-checks-failed", result);
      throw Error(`Stale checks failed: ${JSON.stringify(checks)}`);
    }
    // Clear the out-of-date proposal so step 6 starts with exactly one open one.
    if ((await proposals.getByRole("button", { name: "Reject all" }).count()) > 0) {
      await proposals.getByRole("button", { name: "Reject all" }).first().click();
      await sleep(1500);
    }
    return result;
  });

  // Step 6: fresh proposal left open, clean window close (WM_CLOSE), relaunch, reopen project.
  let reopened;
  await step("6-restart", async () => {
    await findFillers();
    const before = await snapshot();
    const inspectorBefore = await inspectRevision();
    const nativeBefore = await nativeProposals();
    const shotBefore = await shot("06a-before-close.png", proposals);
    // Diagnose: does a request routed through the native event loop still work before closing?
    const preClose = await page
      .evaluate(async () => {
        const invoke = globalThis.__TAURI_INTERNALS__.invoke;
        const timeout = () => new Promise((r) => globalThis.setTimeout(() => r("timeout"), 3000));
        const visible = await Promise.race([
          invoke("plugin:window|is_visible", { label: "main" }).then((v) => `ok ${v}`, (e) => `err ${e}`),
          timeout(),
        ]);
        const listeners = Object.keys(globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__?.listeners ?? {});
        return { visible, listeners };
      })
      .catch((error) => ({ pageError: String(error) }));
    record("pre-close-probe", { preClose });
    const { handle } = await session.owned.findWindow(identity);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'; [W.U]::PostMessage([System.IntPtr]${handle}, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero)`,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    record("wm-close-sent", { handle });
    let exit = await Promise.race([session.owned.exit, sleep(5000).then(() => null)]);
    if (exit === null) {
      // Still running: capture what the window is showing instead of the close.
      const held = await page
        .evaluate(() => ({
          dialogs: [...globalThis.document.querySelectorAll("dialog[open], [role=alertdialog]")].map((d) =>
            d.innerText.slice(0, 400),
          ),
          focused: globalThis.document.activeElement?.outerHTML.slice(0, 200) ?? null,
        }))
        .catch((error) => ({ pageError: String(error) }));
      record("close-held", { held, screenshot: await shot("06x-close-held.png", proposals).catch(() => null) });
      // Diagnose: can the webview still reach native, and does an explicit destroy work?
      const probe = await page
        .evaluate(async () => {
          const invoke = globalThis.__TAURI_INTERNALS__.invoke;
          const timeout = () => new Promise((r) => globalThis.setTimeout(() => r("timeout"), 3000));
          const started = Date.now();
          const status = await Promise.race([
            invoke("video_agent_proposals_status").then(() => "ok", (e) => `err ${e}`),
            timeout(),
          ]);
          const pingMs = Date.now() - started;
          const destroy = await Promise.race([
            invoke("plugin:window|destroy", { label: "main" }).then(() => "ok", (e) => `err ${e}`),
            timeout(),
          ]);
          return { status, pingMs, destroy };
        })
        .catch((error) => ({ pageError: String(error) }));
      record("close-held-probe", { probe });
      exit = await Promise.race([session.owned.exit, sleep(25000).then(() => null)]);
    }
    await session.browser.close().catch(() => {});
    if (exit === null) throw Error("App did not exit after WM_CLOSE");
    const closedEvent = session.owned.events.find((e) => e.event === "closed");
    session = await launch("b");
    ({ page, identity } = session);
    bind();
    await page.getByRole("button", { name: "Open project", exact: true }).click();
    dialog(project);
    await waitFor(async () => (await revision()) === before.revision, 30000, "reopened project");
    await proposals.waitFor();
    await sleep(3000);
    reopened = await snapshot();
    const inspectorAfter = await inspectRevision();
    const nativeAfter = await nativeProposals();
    const checks = {
      cleanExit: closedEvent?.rootExit === 0,
      revisionUnchanged: reopened.revision === before.revision,
      inspectorUnchanged: JSON.stringify(inspectorAfter) === JSON.stringify(inspectorBefore),
      proposalAccountedFor:
        reopened.panel.pending.length === 1 ||
        reopened.panel.history.some((h) => /Expired|Out of date/.test(h)),
    };
    const result = {
      closedEvent,
      revisionBefore: before.revision,
      revisionAfter: reopened.revision,
      inspectorBefore,
      inspectorAfter,
      pendingBefore: before.panel.pending,
      pendingAfter: reopened.panel.pending,
      rangesAfter: reopened.panel.ranges.length,
      checkedAfter: reopened.panel.checked,
      bandsAfter: reopened.timeline.bands.length,
      historyAfter: reopened.panel.history,
      messageAfter: reopened.panel.message,
      transcriptWordsAfterReopen: reopened.wordCount,
      nativeBefore,
      nativeAfter,
      checks,
      screenshots: [shotBefore, await shot("06b-after-relaunch.png", proposals)],
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step6-checks-failed", result);
      throw Error(`Restart checks failed: ${JSON.stringify(checks)}`);
    }
    return result;
  });

  // Step 7: reject the open proposal (the one restored across the restart, else a fresh one).
  await step("7-reject", async () => {
    if ((await panelState()).pending.length === 0) {
      await ensureTranscript();
      await findFillers();
    }
    const before = await snapshot();
    const inspectorBefore = await inspectRevision();
    await proposals.getByRole("button", { name: "Reject all" }).click();
    await waitFor(async () => /Proposal rejected/.test((await panelState()).message ?? ""), 20000, "rejected");
    await sleep(1000);
    const after = await snapshot();
    const inspectorAfter = await inspectRevision();
    const native = await nativeProposals();
    const checks = {
      noPending: after.panel.pending.length === 0,
      historyRejected: /Rejected/.test(after.panel.history[0] ?? ""),
      revisionUnchanged: after.revision === before.revision,
      stateUnchanged: JSON.stringify(inspectorAfter) === JSON.stringify(inspectorBefore),
      clipsUnchanged: JSON.stringify(after.timeline.clips) === JSON.stringify(before.timeline.clips),
      bandsCleared: after.timeline.bands.length === 0,
      nativeRejected: native.some((p) => p.status === "rejected"),
    };
    const result = {
      rejectedGroup: before.panel.pending[0],
      revisionBefore: before.revision,
      revisionAfter: after.revision,
      message: after.panel.message,
      history: after.panel.history,
      native,
      checks,
      screenshot: await shot("07-rejected.png", proposals),
    };
    if (!Object.values(checks).every(Boolean)) {
      record("step7-checks-failed", result);
      throw Error(`Reject checks failed: ${JSON.stringify(checks)}`);
    }
    return result;
  });
} catch (error) {
  record("scenario-error", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  record("steps", { steps });
  if (session) {
    await session.browser.close().catch(() => {});
    const exit = await session.owned.close();
    record("closed", { exit });
  }
  const hashAfter = sha256(source);
  record("source-hash-after", { hashAfter, unchanged: hashAfter === hashBefore });
}
