import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { mediaProbeSchema } from "../../packages/video-contracts/dist/index.js";
import { nativeSession } from "./native-session.mjs";
import { browserSession } from "./browser-session.mjs";
import { fixtureData } from "./fixture-data.mjs";
import { createNativeFixture } from "./native-project.mjs";
import { submitOwnedPicker } from "./native-picker.mjs";
import { playbackSamples, seekSamples } from "./measure-page.mjs";
const [target, releasePath, launcherReceipt, mediaReceipt, nativeIndexPath] = process.argv.slice(2);
if (!["native-profile", "native-uninstrumented", "browser-profile"].includes(target))
  throw new Error("Explicit measurement target required");
const ALL_WORKLOAD_KINDS = ["export-reference", "timeline-1000", "two-layer"];
// Optional comma-separated subset (P2_WORKLOADS); unknown or duplicate names are refused.
const workloadKinds = process.env.P2_WORKLOADS
  ? process.env.P2_WORKLOADS.split(",").map((kind) => kind.trim())
  : ALL_WORKLOAD_KINDS;
assert.ok(
  workloadKinds.length > 0 &&
    new Set(workloadKinds).size === workloadKinds.length &&
    workloadKinds.every((kind) => ALL_WORKLOAD_KINDS.includes(kind)),
  `Invalid P2_WORKLOADS: ${process.env.P2_WORKLOADS}`,
);
const base = fileURLToPath(new URL("./", import.meta.url));
const release = JSON.parse(readFileSync(releasePath, "utf8"));
assert.equal(release.status, "passed");
if (target !== "browser-profile") assert.equal(release.mode, target);
const nativeIndex = nativeIndexPath ? JSON.parse(readFileSync(nativeIndexPath, "utf8")) : null;
if (target === "browser-profile") assert.equal(nativeIndex.status, "passed");
const directory = mkdtempSync(path.join(base, "runs", `workloads-${target}-`));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const trace = async (operation, action) => {
  const mark = (event, error) =>
    appendFileSync(
      path.join(directory, "operations.jsonl"),
      `${JSON.stringify({ utc: new Date().toISOString(), event, operation, error })}\n`,
    );
  mark("before");
  try {
    const result = await action();
    mark("after");
    return result;
  } catch (error) {
    mark("error", String(error));
    throw error;
  }
};
const ledger = {
  utc: new Date().toISOString(),
  target,
  releasePath,
  releaseSha256: sha(releasePath),
  mediaReceipt,
  mediaSha256: sha(mediaReceipt),
  sourceSnapshot: JSON.parse(
    execFileSync(process.execPath, [path.join(base, "snapshot.mjs")], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ),
  protocol: {
    samples: 3,
    warmupSeconds: 5,
    sampleSeconds: 60,
    seeks: 100,
    seed: 0x5052,
    viewport: { width: 1280, height: 720 },
    browserMockIpc: target === "browser-profile",
    sourceDisplayCadencesSeparate: true,
    finalScope:
      "supported single-clip reference only; original multi-clip exports remain unsupported",
    workloadKinds,
  },
  workloads: [],
  status: "running",
};
ledger.host = JSON.parse(
  execFileSync("powershell", ["-NoProfile", "-File", path.join(base, "environment.ps1")], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1048576,
  }),
);
const indexPath = path.join(directory, "index.json");
function checkpoint() {
  writeFileSync(indexPath, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(
    JSON.stringify({
      indexPath,
      sha256: sha(indexPath),
      completed: ledger.workloads.length,
      status: ledger.status,
    }),
  );
}
async function renderFinal(session, project, fixture) {
  const output = path.join(session.run, "comparison-final.mp4"),
    started = Date.now();
  await session.page.getByRole("button", { name: "Export MP4", exact: true }).click();
  submitOwnedPicker(session, output);
  await session.page
    .getByRole("button", { name: "Export another", exact: true })
    .waitFor({ state: "visible", timeout: 240000 });
  const probeExe = path.join(path.dirname(release.executable), "media-tools", "ffprobe.exe");
  assert.equal(
    sha(probeExe),
    release.resources.find((r) => r.path === "media-tools/ffprobe.exe").sha256,
  );
  const args = [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ];
  const probe = JSON.parse(
    execFileSync(probeExe, args, { encoding: "utf8", timeout: 180000, maxBuffer: 1048576 }),
  );
  const video = probe.streams.find((s) => s.codec_type === "video"),
    audio = probe.streams.find((s) => s.codec_type === "audio");
  assert.equal(Number(video.nb_read_frames), fixture.durationFrames);
  assert.equal(
    video.avg_frame_rate,
    `${fixture.sequence.rate.numerator}/${fixture.sequence.rate.denominator}`,
  );
  const normalized = mediaProbeSchema.parse({
    durationMicroseconds: Math.round(Number(probe.format.duration) * 1000000),
    averageFrameRate: fixture.sequence.rate,
    realFrameRate: fixture.sequence.rate,
    variableFrameRate: false,
    width: video.width,
    height: video.height,
    videoCodecName: video.codec_name,
    audio: audio
      ? {
          codecName: audio.codec_name,
          channels: audio.channels,
          sampleRate: Number(audio.sample_rate),
        }
      : null,
    fileSizeBytes: statSync(output).size,
  });
  return {
    ...project,
    finalOutput: { outputPath: output, previewPath: output, probe: normalized },
    finalOutputSha256: sha(output),
    exportElapsedMs: Date.now() - started,
    exportProbe: probe,
    exportArgv: [probeExe, ...args],
  };
}
try {
  for (const kind of workloadKinds)
    for (const rate of ["30/1", "30000/1001"]) {
      const fixture = fixtureData(mediaReceipt, kind, rate),
        label = `${kind}-${rate.replace("/", "-")}`;
      const output = path.join(directory, label);
      mkdirSync(output);
      const result = {
        kind,
        rate,
        fixtureSha256: fixture.fixtureSha256,
        modes: [],
        status: "running",
      };
      ledger.workloads.push(result);
      checkpoint();
      let session;
      try {
        if (target === "browser-profile") {
          const native = nativeIndex.workloads.find((w) => w.kind === kind && w.rate === rate);
          assert.equal(native.status, "passed");
          assert.equal(native.fixtureSha256, fixture.fixtureSha256);
          result.nativeData = native.nativeData;
          session = await trace("browser.open", () =>
            browserSession(
              process.env.P2_BROWSER_FRONTEND || path.join(base, "runs/browser-profile"),
              native.nativeData,
              path.join(process.env.LOCALAPPDATA, release.identifier),
            ),
          );
          result.mediaAndFrontendHashes = session.hashes;
          result.browserVersion = session.version;
        } else {
          session = await trace("native.open", () =>
            nativeSession({
              launcherReceipt,
              executable: release.executable,
              executableSha256: release.executableSha256,
              leaseMs: 2700000,
            }),
          );
          result.identity = session.owned.identity;
          result.osObservation = session.observed;
          result.environmentOverrides = session.env;
          result.webviewVersion = session.page.context().browser().version();
          result.nativeData = await trace("native.fixture", () =>
            createNativeFixture(session, fixture),
          );
        }
        await session.page.setViewportSize({ width: 1280, height: 720 });
        let gpuSession;
        try {
          gpuSession = await session.page.context().browser().newBrowserCDPSession();
          result.gpu = await gpuSession.send("SystemInfo.getInfo");
        } catch (error) {
          result.gpuUnavailable = String(error);
        } finally {
          await gpuSession?.detach();
        }
        // Mute only this app's monitor; decoding continues. No other application is touched.
        const mute = session.page.getByRole("button", { name: "Mute audio", exact: true });
        if (await mute.count()) await mute.click();
        for (const mode of kind === "export-reference" ? ["Preview", "Final"] : ["Preview"]) {
          if (mode === "Final") {
            if (target === "browser-profile") {
              await session.page.getByRole("button", { name: "Export MP4", exact: true }).click();
              await session.page
                .getByRole("button", { name: "Export another", exact: true })
                .waitFor({ state: "visible", timeout: 15000 });
            } else result.nativeData = await renderFinal(session, result.nativeData, fixture);
            await session.page.getByRole("button", { name: "Final", exact: true }).click();
          }
          const entry = { mode };
          result.modes.push(entry);
          entry.playback = await playbackSamples(session.page, output, mode, {
            profiling: target.endsWith("profile") && target !== "native-uninstrumented",
            trace,
          });
          entry.seeks = await trace("seeks.100", () =>
            seekSamples(session.page, output, mode, fixture, mode),
          );
          if (target === "native-uninstrumented")
            entry.observerFreeControl = await playbackSamples(
              session.page,
              output,
              `${mode}-observer-free`,
              { profiling: false, observer: false, trace },
            );
          checkpoint();
        }
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error);
        if (session) {
          try {
            result.visibleText = (await session.page.locator("body").innerText()).slice(0, 20000);
            await session.page.screenshot({ path: path.join(output, "failure.png") });
          } catch {
            result.pageUnavailable = true;
          }
        }
        throw error;
      } finally {
        if (session) result.cleanup = await trace("session.close", () => session.close());
        checkpoint();
      }
    }
  // A filtered run is a spot check, never a complete matrix that downstream runs may consume.
  ledger.status = workloadKinds.length === ALL_WORKLOAD_KINDS.length ? "passed" : "partial";
} catch (error) {
  ledger.status = "failed";
  ledger.error = String(error);
  throw error;
} finally {
  checkpoint();
  if (process.env.P2_COMPARISON_RECEIPT) {
    const pointer = path.resolve(process.env.P2_COMPARISON_RECEIPT);
    const relative = path.relative(path.join(base, "runs"), pointer);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    writeFileSync(
      pointer,
      JSON.stringify({ indexPath, sha256: sha(indexPath), status: ledger.status }),
      { flag: "wx" },
    );
  }
}
