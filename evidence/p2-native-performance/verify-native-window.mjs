// One isolated native check only. The external Job Object watchdog owns the worker and descendants.
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { launchOwned } from "./owned-run.mjs";
import { captureMediaForUnload, inspectMediaUnload, mediaIsUnloaded } from "./media-unload.mjs";
const base = fileURLToPath(new URL("./", import.meta.url));
const runs = realpathSync(path.join(base, "runs"));
const json = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const save = (dir, name, data) =>
  writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
const launcherReceipt = path.join(runs, "launcher-6bddff38882644cfb9a5ee567098e082/receipt.json");
const releasePath = path.join(runs, "release-x7bGX5/receipt.json");
const mediaReceipt = path.join(runs, "media-9f3WSn/receipt.json");
const soak = process.argv.includes("--soak");
const leaseMs = soak ? 4500000 : 420000;
const nativeLeaseMs = soak ? 4200000 : 390000;
function processes() {
  const text = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      '$p = @(Get-CimInstance Win32_Process); @($p | Where-Object { $_.Name -eq "OwnedRun.exe" -or $_.ExecutablePath -like "*p2-native-performance*" -or ($_.Name -eq "node.exe" -and $_.CommandLine -match "diagnose-browser-measurement|run-workloads|verify-native-window") } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{n="creationUtc";e={$_.CreationDate.ToUniversalTime().ToString("o")}}) | ConvertTo-Json -Compress',
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
  );
  return text.trim() ? [].concat(JSON.parse(text)) : [];
}
if (process.argv[2] === "--worker") {
  const directory = realpathSync(process.argv[3]);
  assert.equal(path.dirname(directory), runs);
  assert.match(path.basename(directory), /^native-window-/);
  const mark = (event, operation, extra = {}) =>
    appendFileSync(
      path.join(directory, "operations.jsonl"),
      `${JSON.stringify({ utc: new Date().toISOString(), event, operation, ...extra })}\n`,
    );
  const trace = async (name, operation) => {
    mark("before", name);
    try {
      const result = await operation();
      mark("after", name);
      return result;
    } catch (error) {
      mark("error", name, { error: String(error) });
      throw error;
    }
  };
  let session;
  const result = {
    scope: soak
      ? "Native 1000-item 30/1 Preview check plus 60-minute active resource soak; no physical-display or audible-output proof"
      : "One native 1000-item 30/1 Preview check; no export, matrix, soak, physical display or audible-output proof",
    status: "running",
  };
  try {
    const { nativeSession } = await trace("import.session", () => import("./native-session.mjs"));
    const { fixtureData } = await trace("import.fixture", () => import("./fixture-data.mjs"));
    const { createNativeFixture } = await trace(
      "import.project",
      () => import("./native-project.mjs"),
    );
    const { playbackSamples } = await trace("import.playback", () => import("./measure-page.mjs"));
    const { verifyMediaWindow } = await trace(
      "import.seeks",
      () => import("./verify-media-window.mjs"),
    );
    const release = json(releasePath);
    assert.equal(release.status, "passed");
    assert.equal(release.mode, "native-uninstrumented");
    const fixture = fixtureData(mediaReceipt, "timeline-1000", "30/1");
    session = await trace("session.open", () =>
      nativeSession({
        launcherReceipt,
        executable: release.executable,
        executableSha256: release.executableSha256,
        leaseMs: nativeLeaseMs,
      }),
    );
    save(directory, "native-identity.json", {
      utc: new Date().toISOString(),
      run: session.run,
      identity: session.owned.identity,
      observed: session.observed,
      env: session.env,
      version: session.page.context().browser().version(),
      releaseSha256: hash(releasePath),
    });
    session.page.setDefaultTimeout(10000);
    result.nativeData = await trace("fixture.create-real-native", () =>
      createNativeFixture(session, fixture),
    );
    save(directory, "fixture.json", result.nativeData);
    await trace("viewport", () => session.page.setViewportSize({ width: 1280, height: 720 }));
    const mute = session.page.getByRole("button", { name: "Mute audio", exact: true });
    if (await trace("mute.count", () => mute.count()))
      await trace("mute.app-only", () => mute.click());
    result.playback = await trace("playback", () =>
      playbackSamples(session.page, directory, "Preview", { profiling: false, repeats: 1, trace }),
    );
    save(directory, "playback.json", result.playback);
    assert.equal(result.playback[0].stillPlayingAtEnd, true);
    result.unloading = [];
    const seekTrace = async (name, operation) => {
      if (name.startsWith("window.seek."))
        await trace("unload.retain-bounded-nodes", () =>
          session.page.evaluate(captureMediaForUnload),
        );
      const value = await trace(name, operation);
      if (name.startsWith("window.ready.")) {
        const released = await trace("unload.inspect", () =>
          session.page.evaluate(inspectMediaUnload),
        );
        appendFileSync(
          path.join(directory, "unloading.jsonl"),
          `${JSON.stringify({ utc: new Date().toISOString(), operation: name, released })}\n`,
        );
        for (const item of released) {
          assert.equal(mediaIsUnloaded(item.settled), true, JSON.stringify(item));
          assert.equal(item.omitted, 0, "Unload event evidence must not be truncated");
          if (item.before.readyState > 0)
            assert.ok(
              item.events.some((event) => event.type === "emptied"),
              "Previously loaded media must emit emptied",
            );
        }
        result.unloading.push(...released);
      }
      return value;
    };
    result.seeks = await trace("seeks", () =>
      verifyMediaWindow(session.page, result.nativeData, seekTrace, (check) =>
        appendFileSync(
          path.join(directory, "seeks.jsonl"),
          `${JSON.stringify({ utc: new Date().toISOString(), ...check })}\n`,
        ),
      ),
    );
    assert.ok(
      result.unloading.length > 0,
      "Must observe actual released media, not only mounted counts",
    );
    if (soak) {
      const { nativeSoak } = await trace("import.soak", () => import("./native-soak.mjs"));
      result.soak = await trace("soak.complete", () =>
        nativeSoak(session, result.nativeData, directory, trace),
      );
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error);
    mark("error", "worker", { error: String(error) });
    process.exitCode = 1;
  } finally {
    try {
      if (session) result.cleanup = await trace("session.close", () => session.close());
    } catch (error) {
      result.status = "failed";
      result.cleanupError = String(error);
      process.exitCode = 1;
    }
    save(directory, "result.json", result);
    mark("after", "worker.finished", { status: result.status });
  }
} else {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--soak"),
  );
  const preflight = processes();
  assert.equal(
    preflight.filter((p) => p.ProcessId !== process.pid).length,
    0,
    "Existing diagnostic/native process found; refusing duplicate run",
  );
  const directory = mkdtempSync(path.join(runs, "native-window-"));
  save(directory, "preflight.json", { utc: new Date().toISOString(), processes: preflight });
  const snapshot = () =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(base, "snapshot.mjs")], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4194304,
      }),
    );
  save(directory, "inputs.json", {
    utc: new Date().toISOString(),
    watchdogMs: leaseMs,
    nativeLeaseMs,
    soak,
    cleanupDrainMs: 10000,
    fallbackMs: leaseMs + 15000,
    sourceSnapshot: snapshot(),
    releasePath,
    releaseSha256: hash(releasePath),
    mediaReceipt,
    mediaSha256: hash(mediaReceipt),
    files: [
      "verify-native-window.mjs",
      "native-soak.mjs",
      "media-unload.mjs",
      "native-session.mjs",
      "native-project.mjs",
      "native-picker.mjs",
      "owned-run.mjs",
      "sample-resources.ps1",
      "measure-page.mjs",
      "browser-observer.mjs",
      "verify-media-window.mjs",
    ].map((name) => ({ name, sha256: hash(path.join(base, name)) })),
  });
  save(
    directory,
    "host.json",
    JSON.parse(
      execFileSync("powershell", ["-NoProfile", "-File", path.join(base, "environment.ps1")], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1048576,
      }),
    ),
  );
  console.log(`NATIVE_CHECK_START ${directory}; external watchdog ${leaseMs}ms`);
  const owned = await launchOwned(
    launcherReceipt,
    process.execPath,
    [fileURLToPath(import.meta.url), "--worker", directory, ...(soak ? ["--soak"] : [])],
    { leaseMs },
  );
  const observation = processes();
  save(directory, "ownership.json", {
    utc: new Date().toISOString(),
    worker: owned.identity,
    launcherPid: owned.launcherPid,
    observation,
  });
  const launcher = observation.find((p) => p.ProcessId === owned.launcherPid);
  assert.ok(launcher, "Owned launcher OS identity required for sampling");
  const sampling = new Promise((resolve) =>
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-File",
        path.join(base, "sample-resources.ps1"),
        "-OwnedPid",
        String(owned.launcherPid),
        "-ExpectedExecutable",
        launcher.ExecutablePath,
        "-ExpectedCreationUtc",
        launcher.creationUtc,
        "-DurationSeconds",
        String(leaseMs / 1000),
      ],
      { encoding: "utf8", timeout: leaseMs + 15000, maxBuffer: 16777216 },
      (error, stdout, stderr) => {
        writeFileSync(path.join(directory, "resources.jsonl"), stdout, { flag: "wx" });
        const receipt = {
          utc: new Date().toISOString(),
          ok: !error,
          error: error ? String(error) : null,
          stderr,
        };
        save(directory, "sampler.json", receipt);
        resolve(receipt);
      },
    ),
  );
  const exit = await owned.exit;
  const sampler = await sampling;
  save(directory, "cleanup.json", {
    utc: new Date().toISOString(),
    exit,
    observation: processes(),
  });
  save(directory, "source-after.json", snapshot());
  let result;
  try {
    result = json(path.join(directory, "result.json"));
  } catch (error) {
    result = { status: "unavailable", error: String(error) };
  }
  const cleanupConfirmed =
    exit.code === 0 && exit.events.some((e) => e.event === "closed" && e.empty === true);
  const report = {
    directory,
    status: result.status,
    error: result.error ?? null,
    cleanupConfirmed,
    samplerOk: sampler.ok,
    resultSha256:
      result.status === "unavailable" ? null : hash(path.join(directory, "result.json")),
  };
  save(directory, "report.json", report);
  console.log(JSON.stringify(report, null, 2));
  if (result.status !== "passed" || !cleanupConfirmed || !sampler.ok) process.exitCode = 1;
}
