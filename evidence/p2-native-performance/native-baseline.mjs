import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import assert from "node:assert/strict";
import { submitOwnedPicker } from "./native-picker.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { nativeSession } from "./native-session.mjs";
import { fixtureData } from "./fixture-data.mjs";
import { createNativeFixture } from "./native-project.mjs";
const [releasePath, launcherReceipt, mediaReceipt] = process.argv.slice(2);
if (!releasePath || !launcherReceipt || !mediaReceipt)
  throw new Error("Release, launcher and media receipts required");
const release = JSON.parse(readFileSync(releasePath, "utf8"));
if (release.status !== "passed") throw new Error("Release prerequisite not passed");
const fixture = fixtureData(mediaReceipt, "export-reference", "30/1");
const result = {
  utc: new Date().toISOString(),
  releaseReceipt: releasePath,
  releaseReceiptSha256: createHash("sha256").update(readFileSync(releasePath)).digest("hex"),
  fixtureSha256: fixture.fixtureSha256,
  scope: "assembled release executable, not installer",
};
let session;
try {
  const start = Date.now();
  session = await nativeSession({
    launcherReceipt,
    executable: release.executable,
    executableSha256: release.executableSha256,
    leaseMs: 600000,
  });
  result.launchMs = Date.now() - start;
  result.launchCondition =
    "new isolated WebView profile; isolated identifier/cache may be warm; OS caches not purged; launchMs includes ownership inspection and CDP attachment";
  result.identity = session.owned.identity;
  result.processObservation = session.observed;
  result.environmentOverrides = session.env;
  result.webviewVersion = session.page.context().browser().version();
  const project = await createNativeFixture(session, fixture);
  result.project = project;
  await session.page.evaluate(() => globalThis.__p2SeekTo(15));
  await session.page.locator(".transport-play").click();
  await session.page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll("video")].some(
        (v) => !v.paused && v.currentTime > 1,
      ),
    undefined,
    { timeout: 15000 },
  );
  await session.page.locator(".transport-play").click();
  result.previewPlayback = await session.page.evaluate(() =>
    [...globalThis.document.querySelectorAll("video")].map((v) => ({
      label: v.getAttribute("aria-label"),
      currentTime: v.currentTime,
      readyState: v.readyState,
      error: v.error?.code ?? null,
    })),
  );
  const outputPath = path.join(session.run, "final.mp4");
  const exportStart = Date.now();
  await session.page.getByRole("button", { name: "Export MP4", exact: true }).click();
  submitOwnedPicker(session, outputPath);
  await session.page
    .getByRole("button", { name: "Export another", exact: true })
    .waitFor({ state: "visible", timeout: 240000 });
  result.exportElapsedMs = Date.now() - exportStart;
  const ffprobe = path.join(path.dirname(release.executable), "media-tools", "ffprobe.exe");
  const probeArgs = [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,avg_frame_rate,nb_read_frames,duration,sample_rate:format=duration",
    "-of",
    "json",
    outputPath,
  ];
  result.exportProbe = JSON.parse(
    execFileSync(ffprobe, probeArgs, { encoding: "utf8", maxBuffer: 1048576, timeout: 180000 }),
  );
  result.exportProbeArgv = [ffprobe, ...probeArgs];
  result.exportSha256 = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
  assert.equal(
    Number(result.exportProbe.streams.find((s) => s.codec_type === "video").nb_read_frames),
    fixture.durationFrames,
  );
  assert.ok(
    Math.abs(Number(result.exportProbe.format.duration) - fixture.durationFrames / 30) <= 1 / 30,
  );
  await session.page.getByRole("button", { name: "Final", exact: true }).click();
  await session.page.locator(".transport-play").click();
  await session.page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll("video")].some(
        (v) =>
          v.getAttribute("aria-label") === "Verified final video preview" &&
          !v.paused &&
          v.currentTime > 1,
      ),
    undefined,
    { timeout: 15000 },
  );
  await session.page.locator(".transport-play").click();
  result.finalPlayback = true;
  const cancelPath = path.join(session.run, "cancelled.mp4");
  await session.page.getByRole("button", { name: "Export another", exact: true }).click();
  submitOwnedPicker(session, cancelPath);
  await session.page
    .getByRole("button", { name: "Cancel export", exact: true })
    .click({ timeout: 30000 });
  await session.page
    .getByRole("button", { name: "Export MP4", exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
  assert.equal(existsSync(cancelPath), false);
  assert.equal(
    readdirSync(session.run).some((p) => p.includes("partial")),
    false,
  );
  result.cancellation = { outputAbsent: true, partialAbsent: true };
  result.normalClose = JSON.parse(
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./close-owned-window.ps1", import.meta.url)),
        "-OwnedPid",
        String(session.owned.identity.pid),
        "-Creation",
        session.owned.identity.creation,
      ],
      { encoding: "utf8", timeout: 20000 },
    ),
  );
  result.firstCleanup = await session.close();
  session = await nativeSession({
    launcherReceipt,
    executable: release.executable,
    executableSha256: release.executableSha256,
    leaseMs: 120000,
  });
  await session.page.getByRole("button", { name: "Open project", exact: true }).click();
  submitOwnedPicker(session, project.file);
  await session.page.locator(".transport-play").waitFor({ state: "visible", timeout: 30000 });
  result.reopened = true;
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = String(error);
  if (session) {
    try {
      result.visibleText = (await session.page.locator("body").innerText()).slice(0, 20000);
      await session.page.screenshot({ path: path.join(session.run, "failure.png") });
    } catch {
      result.pageUnavailable = true;
    }
  }
  throw error;
} finally {
  if (session) {
    try {
      result.cleanup = await session.close();
    } catch (error) {
      result.cleanupError = String(error);
      result.status = "failed";
    }
    const output = path.join(session.run, "baseline.json");
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    console.log(
      JSON.stringify({
        output,
        sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
        status: result.status,
      }),
    );
  } else console.log(JSON.stringify(result));
}
if (result.status === "failed") process.exitCode = 1;
