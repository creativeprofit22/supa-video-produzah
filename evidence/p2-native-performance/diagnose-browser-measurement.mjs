// One diagnostic only: an external Windows Job Object lease owns the worker and Chromium.
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { launchOwned } from "./owned-run.mjs";
import { summarizeTrace } from "./diagnostic-report.mjs";

globalThis.__p2BootstrapMark?.("after", "worker.module-body");
const base = fileURLToPath(new URL("./", import.meta.url));
globalThis.__p2BootstrapMark?.("before", "worker.realpath-runs");
const runs = realpathSync(path.join(base, "runs"));
const responsiveness = process.env.P2_RESPONSIVENESS === "1";
const mediaLoadControl = process.env.P2_MEDIA_LOAD_CONTROL ?? null;
const verifyWindow = process.env.P2_VERIFY_WINDOW === "1";
assert.ok(
  !verifyWindow || !responsiveness,
  "Window verification follows a real playback sample, not the idle control",
);
assert.ok([null, "idle-normal", "idle-held"].includes(mediaLoadControl));
assert.ok(
  mediaLoadControl === null || (responsiveness && process.env.P2_DEBUG_SNAPSHOT !== "1"),
  "Media controls require isolated responsiveness mode without debugger attachment",
);
const leaseMs = responsiveness ? 40000 : 120000;
const frontend = realpathSync(
  process.env.P2_DIAGNOSTIC_FRONTEND ?? path.join(runs, "browser-profile"),
);
const frontendRelative = path.relative(runs, frontend);
assert.ok(
  frontendRelative && !frontendRelative.startsWith("..") && !path.isAbsolute(frontendRelative),
  "Diagnostic frontend must be an isolated run artifact",
);
globalThis.__p2BootstrapMark?.("after", "worker.realpath-runs");
const json = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const save = (dir, name, value) =>
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function processes() {
  const text = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      '$p = @(Get-CimInstance Win32_Process); @($p | Where-Object { $_.Name -eq "node.exe" -or $_.Name -eq "OwnedRun.exe" -or $_.ExecutablePath -like "*ms-playwright*" -or $_.ExecutablePath -like "*p2-native-performance*" } | Select-Object ProcessId,ParentProcessId,Name,@{n="creationUtc";e={$_.CreationDate.ToUniversalTime().ToString("o")}},ExecutablePath,@{n="p2Diagnostic";e={$_.CommandLine -match "diagnose-browser-measurement|run-workloads\\.mjs|browser-diagnostic|browserSession"}}) | ConvertTo-Json -Compress',
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  return {
    utc: new Date().toISOString(),
    processes: text.trim() ? [].concat(JSON.parse(text)) : [],
  };
}

if (process.argv[2] === "--worker") {
  globalThis.__p2BootstrapMark?.("before", "worker.realpath-output");
  const directory = realpathSync(process.argv[3]);
  globalThis.__p2BootstrapMark?.("after", "worker.realpath-output");
  assert.equal(path.dirname(directory), runs);
  assert.match(path.basename(directory), /^browser-watchdog-/);
  const start = performance.now();
  let sequence = 0;
  const mark = (event, operation, extra = {}) =>
    appendFileSync(
      path.join(directory, "operations.jsonl"),
      `${JSON.stringify({ sequence: sequence++, utc: new Date().toISOString(), elapsedMs: performance.now() - start, event, operation, ...extra })}\n`,
    );
  const trace = async (name, operation) => {
    mark("before", name);
    try {
      const result = await operation();
      mark("after", name);
      if (["sample.before.evaluate", "sample.snapshot.evaluate"].includes(name))
        save(directory, `${name}.json`, result);
      return result;
    } catch (error) {
      mark("error", name, { error: String(error) });
      throw error;
    }
  };
  mark("after", "worker.bootstrap");
  let session, debuggerSession, pauseTimer;
  try {
    const { browserSession } = await trace(
      "import.browser-session",
      () => import("./browser-session.mjs"),
    );
    const { playbackSamples } = await trace(
      "import.measure-page",
      () => import("./measure-page.mjs"),
    );
    mark("before", "fixture.read");
    const index = json(path.join(runs, "workloads-native-profile-MtMVq0/index.json"));
    const release = json(path.join(runs, "release-M3ec0Y/receipt.json"));
    const workload = index.workloads.find((w) => w.kind === "timeline-1000" && w.rate === "30/1");
    assert.equal(workload.status, "passed");
    mark("after", "fixture.read");
    session = await trace("session.open", () =>
      browserSession(
        frontend,
        workload.nativeData,
        path.join(process.env.LOCALAPPDATA, release.identifier),
        trace,
        { mediaLoadControl },
      ),
    );
    // Debugger attachment perturbs execution; never enable it for ordinary measurements.
    if (process.env.P2_DEBUG_SNAPSHOT === "1") {
      debuggerSession = await trace("debugger.attach", () =>
        session.page.context().newCDPSession(session.page),
      );
      const scripts = new Map();
      debuggerSession.on("Debugger.scriptParsed", ({ scriptId, url }) => {
        if (scripts.size < 1000) scripts.set(scriptId, url);
      });
      debuggerSession.once("Debugger.paused", (event) => {
        save(directory, "debugger-paused.json", {
          utc: new Date().toISOString(),
          reason: event.reason,
          frames: event.callFrames.map(({ functionName, location, url }) => ({
            functionName,
            location,
            url: url || scripts.get(location.scriptId) || null,
          })),
        });
        mark("after", "debugger.paused");
        void debuggerSession.send("Debugger.resume").then(
          () => mark("after", "debugger.resumed"),
          (error) => mark("error", "debugger.resume", { error: String(error) }),
        );
      });
      await trace("debugger.enable", () => debuggerSession.send("Debugger.enable"));
      pauseTimer = setTimeout(() => {
        mark("before", "debugger.pause");
        void debuggerSession.send("Debugger.pause").then(
          () => mark("after", "debugger.pause"),
          (error) => mark("error", "debugger.pause", { error: String(error) }),
        );
      }, 75000);
    }
    session.page.on("console", (message) => {
      const text = message.text();
      if (/^P2-SNAPSHOT:[a-z.]+$/.test(text)) mark("after", text);
    });
    save(directory, "fixture.json", {
      scope: "browser mock IPC; single 1000-item Preview sample; not matrix acceptance",
      browser: session.version,
      hashes: session.hashes,
    });
    const mute = session.page.getByRole("button", { name: "Mute audio", exact: true });
    if (mediaLoadControl === null && (await trace("mute.count", () => mute.count())))
      await trace("mute.click", () => mute.click());
    if (responsiveness) {
      const { probeResponsiveness } = await trace(
        "import.probe",
        () => import("./probe-responsiveness.mjs"),
      );
      const result = await trace("responsiveness", () =>
        probeResponsiveness(
          session.page,
          trace,
          (sample) =>
            appendFileSync(
              path.join(directory, "responsiveness.jsonl"),
              `${JSON.stringify(sample)}\n`,
            ),
          { idle: mediaLoadControl !== null },
        ),
      );
      save(directory, "responsiveness.json", {
        ...result,
        mediaLoadControl: session.mediaLoadControlEvidence,
      });
      if (!result.allResponsive) process.exitCode = 1;
    } else {
      const samples = await trace("measurement", () =>
        playbackSamples(session.page, directory, "Preview", { profiling: true, repeats: 1, trace }),
      );
      save(directory, "measurement.json", samples);
      if (verifyWindow) {
        const { verifyMediaWindow } = await trace(
          "import.window-verification",
          () => import("./verify-media-window.mjs"),
        );
        const result = await trace("window-verification", () =>
          verifyMediaWindow(session.page, workload.nativeData, trace, (check) =>
            appendFileSync(
              path.join(directory, "window-verification.jsonl"),
              `${JSON.stringify(check)}\n`,
            ),
          ),
        );
        save(directory, "window-verification.json", result);
      }
    }
  } catch (error) {
    mark("error", "worker", { error: String(error) });
    process.exitCode = 1;
  } finally {
    clearTimeout(pauseTimer);
    try {
      if (session) await trace("session.close", () => session.close());
    } catch (error) {
      mark("error", "worker.cleanup", { error: String(error) });
      process.exitCode = 1;
    }
    mark("after", "worker.finished");
  }
} else {
  assert.equal(process.argv.length, 2, "No matrix or soak mode is supported");
  const directory = mkdtempSync(path.join(runs, "browser-watchdog-"));
  const previous = path.join(runs, "browser-diagnostic-q3moNB");
  const preflight = processes();
  save(directory, "preflight.json", {
    ...preflight,
    interruptedDiagnostic: {
      directory: previous,
      files: readdirSync(previous).map((name) => {
        const file = path.join(previous, name);
        return { name, bytes: statSync(file).size, sha256: hash(file) };
      }),
    },
  });
  assert.ok(
    !preflight.processes.some(
      (p) => p.p2Diagnostic && p.Name === "node.exe" && p.ProcessId !== process.pid,
    ),
    "An existing diagnostic is active; refusing duplicate run",
  );
  save(directory, "inputs.json", {
    utc: new Date().toISOString(),
    watchdogMs: leaseMs,
    frontend,
    verifyWindow,
    responsivenessProbe: responsiveness,
    mediaLoadControl,
    debuggerEnabled: process.env.P2_DEBUG_SNAPSHOT === "1",
    cleanupDrainMs: 10000,
    launcherFallbackMs: leaseMs + 15000,
    node: { executable: process.execPath, sha256: hash(process.execPath) },
    files: [
      "diagnose-browser-measurement.mjs",
      "worker-bootstrap.cjs",
      "probe-responsiveness.mjs",
      "verify-media-window.mjs",
      "sample-resources.ps1",
      "diagnostic-report.mjs",
      "browser-session.mjs",
      "measure-page.mjs",
      "browser-observer.mjs",
      "runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json",
      "runs/workloads-native-profile-MtMVq0/index.json",
      "runs/release-M3ec0Y/receipt.json",
      "../../apps/desktop/src/video/ProgramMonitor.tsx",
      "../../apps/desktop/src/video/preview-media-window.ts",
    ].map((name) => ({ name, sha256: hash(path.join(base, name)) })),
  });
  console.log(`Single diagnostic: ${directory}; external watchdog ${leaseMs / 1000} seconds`);
  const start = performance.now();
  const owned = await launchOwned(
    path.join(runs, "launcher-6bddff38882644cfb9a5ee567098e082/receipt.json"),
    process.execPath,
    [
      "-e",
      readFileSync(path.join(base, "worker-bootstrap.cjs"), "utf8"),
      fileURLToPath(import.meta.url),
      "--worker",
      directory,
    ],
    { leaseMs },
  );
  const observation = processes();
  save(directory, "ownership.json", {
    utc: new Date().toISOString(),
    launcherPid: owned.launcherPid,
    root: owned.identity,
    observation,
    mechanism:
      "Created suspended, assigned to kill-on-close job before resume; descendants inherit job; only this job is terminated.",
  });
  const launcherIdentity = observation.processes.find((p) => p.ProcessId === owned.launcherPid);
  const sampler =
    responsiveness && launcherIdentity
      ? new Promise((resolve) => {
          execFile(
            "powershell",
            [
              "-NoProfile",
              "-File",
              path.join(base, "sample-resources.ps1"),
              "-OwnedPid",
              String(owned.launcherPid),
              "-ExpectedExecutable",
              launcherIdentity.ExecutablePath,
              "-ExpectedCreationUtc",
              launcherIdentity.creationUtc,
              "-DurationSeconds",
              "20",
            ],
            { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              writeFileSync(path.join(directory, "resources.jsonl"), stdout, { flag: "wx" });
              save(directory, "resource-sampler.json", {
                utc: new Date().toISOString(),
                ok: !error,
                error: error ? String(error) : null,
                stderr,
              });
              resolve({ ok: !error });
            },
          );
        })
      : Promise.resolve(null);
  const result = await owned.exit;
  const samplerResult = await sampler;
  save(directory, "cleanup.json", {
    utc: new Date().toISOString(),
    elapsedMs: performance.now() - start,
    result,
    observation: processes(),
  });
  let text = null;
  try {
    text = readFileSync(path.join(directory, "operations.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let bootstrap = null;
  try {
    bootstrap = readFileSync(path.join(directory, "bootstrap.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let probeResult = null;
  if (responsiveness) {
    try {
      probeResult = json(path.join(directory, "responsiveness.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const report = {
    directory,
    resourceSampler: samplerResult,
    responsivenessProbe: probeResult,
    elapsedMs: performance.now() - start,
    bootstrap: summarizeTrace(bootstrap),
    ...summarizeTrace(text),
    cleanupConfirmed:
      result.code === 0 && result.events.some((e) => e.event === "closed" && e.empty === true),
    launcher: result,
  };
  save(directory, "report.json", report);
  console.log(JSON.stringify(report, null, 2));
  if (
    (responsiveness && !samplerResult?.ok) ||
    !report.cleanupConfirmed ||
    !report.workerFinished ||
    !(responsiveness ? probeResult?.allResponsive : report.measurementCompleted) ||
    report.errors.length ||
    report.parseErrors.length ||
    report.pending.length
  )
    process.exitCode = 1;
}
