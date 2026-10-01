// Release smoke for the private, unsigned Windows build (P3 delivery, plan steps 13 + 14).
//
//   node scripts/release-smoke/release-smoke.mjs --msi <path.msi> --out <evidence dir>
//
// 1. Administrative MSI extraction into a fresh %TEMP%\supa-release-smoke-* dir;
//    asserts bundled notices, app license inventory and toolchain (hash-checked).
// 2. Launches the extracted app (owned, kill-on-close launcher) with WebView2 CDP,
//    records CSP violations from first paint (init script + reload) and the
//    effective CSP, and requires zero violations.
// 3. Drives Review/Deliver on an intentionally broken fixture (black opening,
//    frozen picture, clipped audio): export → findings → repair attempt →
//    Deliver blocked → accept anyway → Deliver unblocked → three presets, each
//    verified with ffprobe + manifest + thumbnail + metadata.
//
// Only paths inside the run directory are ever typed into native dialogs.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startOwned } from "../../evidence/2026-09-28-p3-transcription-audio/13-owned.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(ROOT, "apps/desktop/package.json"))(
  "@playwright/test",
);

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) throw Error(`Missing ${name}`);
  return path.resolve(value);
}

const msi = argument("--msi");
const outDir = argument("--out");
const skipScenario = process.argv.includes("--installer-only");
fs.mkdirSync(outDir, { recursive: true });
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "supa-release-smoke-"));
const logPath = path.join(outDir, "release-smoke-log.json");
const log = [];
const record = (event, data = {}) => {
  const entry = { at: new Date().toISOString(), event, ...data };
  log.push(entry);
  console.log(JSON.stringify(entry));
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
};
const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const findFile = (dir, name) => {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) hits.push(full);
    }
  };
  walk(dir);
  return hits;
};
const steps = {};
async function step(name, fn) {
  const started = Date.now();
  record(`${name}:start`);
  try {
    const result = (await fn()) ?? {};
    steps[name] = { status: "PASS", ms: Date.now() - started, ...result };
    record(`${name}:done`, steps[name]);
    return result;
  } catch (error) {
    steps[name] = {
      status: "FAIL",
      ms: Date.now() - started,
      error: String(error?.stack ?? error),
    };
    record(`${name}:fail`, steps[name]);
    throw error;
  }
}

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "apps/desktop/src-tauri/media-toolchain/manifest.v1.json"),
    "utf8",
  ),
);
const ffmpeg = path.join(
  ROOT,
  "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe",
);
const ffprobe = path.join(
  ROOT,
  "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffprobe.exe",
);
const probe = (file) =>
  JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  );

let exe;
let owned;
let browser;
try {
  await step("1-msi-extract", async () => {
    const layout = path.join(runDir, "msi-layout");
    const result = spawnSync("msiexec.exe", ["/a", msi, "/qn", `TARGETDIR=${layout}`], {
      stdio: "ignore",
    });
    if (result.status !== 0) throw Error(`msiexec /a exited ${result.status}`);
    const required = [
      "supa-video-desktop.exe",
      "THIRD_PARTY_LICENSES.md",
      "ffmpeg.exe",
      "ffprobe.exe",
      "manifest.v1.json",
      "THIRD_PARTY_NOTICES.md",
      "SOURCE_OFFER.md",
      "GPL-3.0.txt",
      "GYAN-FFMPEG-README.txt",
    ];
    const found = {};
    for (const name of required) {
      const hits = findFile(layout, name);
      if (hits.length !== 1)
        throw Error(`MSI must contain exactly one ${name}; found ${hits.length}`);
      found[name] = path.relative(layout, hits[0]);
    }
    const hashes = {};
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const actual = sha256(path.join(layout, found[`${tool}.exe`]));
      const expected = manifest.targets["x86_64-pc-windows-msvc"].binaries[tool].sha256;
      if (actual !== expected) throw Error(`${tool}.exe hash mismatch`);
      hashes[tool] = actual;
    }
    const inventory = fs.readFileSync(path.join(layout, found["THIRD_PARTY_LICENSES.md"]), "utf8");
    const repoInventory = fs.readFileSync(
      path.join(ROOT, "apps/desktop/src-tauri/licenses/THIRD_PARTY_LICENSES.md"),
      "utf8",
    );
    if (inventory !== repoInventory)
      throw Error("Bundled license inventory differs from the checked-in one");
    exe = path.join(layout, found["supa-video-desktop.exe"]);
    const signature = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath '${exe.replaceAll("'", "''")}').Status`,
      ],
      { encoding: "utf8" },
    ).trim();
    return {
      msi: path.basename(msi),
      msiSha256: sha256(msi),
      found,
      hashes,
      exeSignature: signature,
    };
  });

  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  // Isolate all app state (job store, media cache, rights receipts, crash
  // reports) in the run directory; the user's real app data is never touched.
  for (const name of ["LOCALAPPDATA", "APPDATA"]) {
    process.env[name] = path.join(runDir, name.toLowerCase());
    fs.mkdirSync(process.env[name], { recursive: true });
  }
  process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(runDir, "webview");
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  owned = startOwned(exe, ["--release-smoke"], {
    leaseMs: 1800000,
    onEvent: (event) => record("owned", { owned: event }),
  });
  const identity = await owned.wait((event) => event.event === "identity", 20000);
  const dialog = (file) => {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(ROOT, "scripts/release-smoke/native-dialog.ps1"),
        "-OwnerId",
        String(identity.pid),
        "-Creation",
        identity.creation,
        "-FilePath",
        file,
        "-AllowedRoot",
        runDir,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    record("native-dialog", { file: path.relative(runDir, file), out: out.trim() });
  };

  let page;
  const consoleCsp = [];
  await step("2-launch-and-csp", async () => {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        if ((await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw Error("CDP endpoint did not come up");
      await sleep(200);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const appPage = context.pages()[0];
    page = appPage;
    appPage.setDefaultTimeout(20000);
    const cspPattern =
      /Content Security Policy|Refused to (?:load|execute|apply|evaluate|connect|frame)/iu;
    appPage.on("console", (message) => {
      if (cspPattern.test(message.text())) consoleCsp.push(message.text());
      if (message.type() === "error" || message.type() === "warning") {
        record("page-console", { type: message.type(), text: message.text().slice(0, 2000) });
      }
    });
    appPage.on("pageerror", (error) =>
      record("page-error", { text: String(error).slice(0, 2000) }),
    );
    // Log.enable replays every entry buffered since the document loaded, so
    // violations from first paint are seen without reloading.
    const cdp = await context.newCDPSession(appPage);
    const replayed = [];
    cdp.on("Log.entryAdded", ({ entry }) => {
      if (
        entry.source === "violation" ||
        entry.source === "security" ||
        cspPattern.test(entry.text)
      ) {
        replayed.push({ source: entry.source, level: entry.level, text: entry.text.slice(0, 500) });
        if (cspPattern.test(entry.text)) consoleCsp.push(entry.text);
      }
    });
    await cdp.send("Log.enable");
    await appPage
      .getByRole("button", { name: "New project", exact: true })
      .waitFor({ timeout: 60000 });
    if (!skipScenario) {
      // Reloading breaks Tauri's IPC transport for in-flight commands, so the
      // scenario run relies on the replayed log plus live monitoring instead.
      await sleep(1500);
      await appPage.screenshot({ path: path.join(outDir, "01-launch.png") });
      if (consoleCsp.length > 0)
        throw Error(`CSP violations at launch: ${JSON.stringify(consoleCsp)}`);
      return { url: appPage.url(), cspCheck: "log-replay", replayedSecurityEntries: replayed };
    }
    await appPage.addInitScript(() => {
      globalThis.__cspViolations = [];
      globalThis.document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__cspViolations.push({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          sample: event.sample,
        });
      });
    });
    // The custom protocol can answer a reload issued during startup with a
    // transient 500; retry until the document itself loads.
    await appPage
      .getByRole("button", { name: "New project", exact: true })
      .waitFor({ timeout: 60000 });
    let response = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      response = await appPage.reload({ waitUntil: "load" });
      if (response?.ok()) break;
      record("reload-retry", { attempt, status: response?.status() ?? null });
      await sleep(1000);
    }
    if (!response?.ok()) throw Error(`App document did not load (${response?.status()})`);
    await appPage.waitForFunction(
      () => typeof globalThis.__TAURI_INTERNALS__?.invoke === "function",
    );
    await appPage.getByRole("button", { name: "New project", exact: true }).waitFor();
    const header = response?.headers()["content-security-policy"] ?? null;
    const meta = await appPage.evaluate(
      () =>
        globalThis.document.querySelector("meta[http-equiv='Content-Security-Policy']")?.content ??
        null,
    );
    const csp = header ?? meta;
    if (
      csp === null ||
      !/default-src 'self'/u.test(csp) ||
      /unsafe-inline/u.test(csp.split("style-src")[1]?.split(";")[0] ?? "")
    ) {
      throw Error(`Packaged CSP missing or weakened: ${csp}`);
    }
    await sleep(1500);
    await appPage.screenshot({ path: path.join(outDir, "01-launch.png") });
    const violations = await appPage.evaluate(() => globalThis.__cspViolations);
    if (violations.length > 0 || consoleCsp.length > 0) {
      throw Error(`CSP violations at launch: ${JSON.stringify({ violations, consoleCsp })}`);
    }
    return {
      url: appPage.url(),
      cspCheck: "reload-with-listener",
      cspSource: header === null ? "meta" : "header",
      csp,
      replayedSecurityEntries: replayed,
    };
  });

  if (!skipScenario) {
    const fixture = path.join(runDir, "broken-fixture.mp4");
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=black:s=1280x720:r=30:d=2[b];testsrc2=s=1280x720:r=30:d=3[t];testsrc2=s=1280x720:r=30:d=1,tpad=stop_mode=clone:stop_duration=3[f];[b][t][f]concat=n=3:v=1:a=0",
      "-f",
      "lavfi",
      "-i",
      // Clipped tone for 5 s, then 4 s of silence (offers a repair proposal).
      "sine=f=440:sample_rate=48000:d=5,volume=40,apad=whole_dur=9",
      "-t",
      "9",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      fixture,
    ]);
    const alerts = async () =>
      page.evaluate(() =>
        [...globalThis.document.querySelectorAll("[role=alert], .inline-error")].map(
          (n) => n.textContent,
        ),
      );
    const waitFor = async (predicate, ms, label) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > end)
          throw Error(`Timed out waiting for ${label}: ${(await alerts()).join(" | ")}`);
        await sleep(500);
      }
    };
    const review = page.locator("section.review-panel");
    const deliver = page.locator("section.deliver-panel");
    const exportPath = path.join(runDir, "review-export.mp4");

    await step("3-import-and-export", async () => {
      await page.getByRole("button", { name: "New project", exact: true }).click();
      dialog(path.join(runDir, "smoke.svpvideo"));
      await page
        .getByRole("button", { name: "Choose video", exact: true })
        .waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Choose video", exact: true }).click();
      dialog(fixture);
      const exportButton = page
        .locator("section[aria-labelledby=export-title]")
        .getByRole("button", { name: "Export MP4" });
      await waitFor(
        async () => await exportButton.isEnabled().catch(() => false),
        120000,
        "export enabled",
      );
      await exportButton.click();
      dialog(exportPath);
      await waitFor(
        async () => (await review.locator(".qc-finding").count()) > 0,
        600000,
        "review findings",
      );
      await page.screenshot({ path: path.join(outDir, "02-review-findings.png"), fullPage: true });
      const reviewManifest = JSON.parse(fs.readFileSync(`${exportPath}.manifest.json`, "utf8"));
      return {
        exportExists: fs.existsSync(exportPath),
        qcStatus: reviewManifest.qc.status,
        findings: reviewManifest.qc.findings.map((f) => `${f.kind}:${f.severity}`),
        reviewText: await review.innerText(),
      };
    });

    await step("4-deliver-blocked-then-accept", async () => {
      const deliverButton = deliver.getByRole("button", { name: "Deliver selected formats" });
      const blockedBefore = await deliverButton.isDisabled();
      const unresolvedBefore = await deliver
        .getByRole("list", { name: "Unresolved findings" })
        .locator("li")
        .count();
      // Repair loop: record an attempt where a fixer exists, then stop.
      const repairs = [];
      const suggest = review.getByRole("button", { name: /Suggest a fix/u });
      if ((await suggest.count()) > 0) {
        await suggest.first().click();
        await waitFor(
          async () => (await review.getByRole("button", { name: "Stop fixing" }).count()) > 0,
          20000,
          "repair recorded",
        );
        repairs.push(
          await review
            .getByRole("button", { name: /Suggest a fix/u })
            .first()
            .innerText()
            .catch(() => "none"),
        );
        await review.getByRole("button", { name: "Stop fixing" }).first().click();
        await waitFor(
          async () => (await review.getByRole("button", { name: "Stop fixing" }).count()) === 0,
          20000,
          "repair stopped",
        );
      }
      await page.screenshot({ path: path.join(outDir, "03-deliver-blocked.png"), fullPage: true });
      // Accept every remaining blocker/warning with a reason.
      let accepted = 0;
      for (let guard = 0; guard < 20; guard++) {
        const forms = review.locator("form.qc-accept-form");
        if ((await forms.count()) === 0) break;
        const form = forms.first();
        await form.getByLabel("Reason to accept anyway").fill("Intentional in this smoke fixture");
        await form.getByRole("button", { name: "Accept anyway" }).click();
        accepted += 1;
        await waitFor(
          async () =>
            (await review.locator("form.qc-accept-form").count()) < (await forms.count()) + 1,
          20000,
          "decision recorded",
        );
        await sleep(300);
      }
      await waitFor(async () => !(await deliverButton.isDisabled()), 20000, "deliver enabled");
      await page.screenshot({ path: path.join(outDir, "04-deliver-ready.png"), fullPage: true });
      const record = fs
        .readFileSync(`${exportPath}.review.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return {
        blockedBefore,
        unresolvedBefore,
        repairs,
        accepted,
        decisions: record.map((d) => d.type),
        releasable: !(await deliverButton.isDisabled()),
      };
    });

    await step("5-deliver-three-presets", async () => {
      for (const label of [/Landscape 16:9/u, /Vertical 9:16/u, /Square 1:1/u]) {
        const box = deliver.getByRole("checkbox", { name: label });
        if (!(await box.isChecked())) await box.check();
      }
      await deliver.getByRole("button", { name: "Deliver selected formats" }).click();
      const names = ["review-export-16x9.mp4", "review-export-9x16.mp4", "review-export-1x1.mp4"];
      for (const name of names) dialog(path.join(runDir, name));
      await waitFor(
        async () => (await deliver.innerText()).match(/Done ·/gu)?.length === 3,
        1200000,
        "three delivered outputs",
      );
      await page.screenshot({ path: path.join(outDir, "05-delivered.png"), fullPage: true });
      const reviewManifestSha = sha256(`${exportPath}.manifest.json`);
      const outputs = {};
      for (const [name, width, height] of [
        [names[0], 1920, 1080],
        [names[1], 1080, 1920],
        [names[2], 1080, 1080],
      ]) {
        const file = path.join(runDir, name);
        const info = probe(file);
        const video = info.streams.find((s) => s.codec_type === "video");
        const m = JSON.parse(fs.readFileSync(`${file}.manifest.json`, "utf8"));
        const sidecars = {
          thumbnail: fs.existsSync(`${file}.thumbnail.jpg`),
          metadata: fs.existsSync(`${file}.metadata.json`),
          credits: fs.existsSync(`${file}.credits.json`),
        };
        if (video.width !== width || video.height !== height)
          throw Error(`${name} is ${video.width}x${video.height}`);
        if (m.kind !== "delivery" || m.source.reviewManifestSha256 !== reviewManifestSha)
          throw Error(`${name} manifest not bound to review`);
        if (m.output.sha256 !== sha256(file)) throw Error(`${name} digest mismatch`);
        if (!sidecars.thumbnail || !sidecars.metadata) throw Error(`${name} sidecars missing`);
        outputs[name] = {
          codec: video.codec_name,
          width,
          height,
          duration: info.format.duration,
          qcStatus: m.qc.status,
          findingIds: m.qc.findings.map((f) => f.findingId),
          acceptedDecisionIds: m.source.acceptedDecisionIds,
          sidecars,
        };
      }
      if (consoleCsp.length > 0)
        throw Error(`CSP violations during scenario: ${JSON.stringify(consoleCsp)}`);
      return { outputs, cspViolationsDuringRun: consoleCsp.length };
    });
  }
} catch (error) {
  record("smoke-error", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
  const pages = browser?.contexts()[0]?.pages() ?? [];
  if (pages[0] !== undefined) {
    await pages[0]
      .screenshot({ path: path.join(outDir, "failure.png"), fullPage: true })
      .catch(() => {});
    record("failure-jobs", {
      jobs: await pages[0]
        .evaluate(() =>
          globalThis.__TAURI_INTERNALS__.invoke("video_list_media_jobs", {
            request: {
              limit: 20,
              includeSettled: true,
              projectId: null,
              beforeUpdatedAt: null,
              beforeJobId: null,
            },
          }),
        )
        .catch((caught) => ({ error: String(caught?.message ?? JSON.stringify(caught)) })),
    });
    record("failure-text", {
      text: (
        await pages[0]
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 4000),
    });
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (owned) record("closed", { exit: await owned.close() });
  record("steps", { steps, runDir });
}
