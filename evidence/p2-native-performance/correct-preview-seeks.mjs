import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { nativeSession } from "./native-session.mjs";
import { submitOwnedPicker, pickNative } from "./native-picker.mjs";
import { fixtureData } from "./fixture-data.mjs";
import { seekSamples } from "./measure-page.mjs";
const [indexPath, launcherReceipt] = process.argv.slice(2);
const index = JSON.parse(readFileSync(indexPath, "utf8")),
  release = JSON.parse(readFileSync(index.releasePath, "utf8"));
assert.equal(index.target, "native-profile");
assert.equal(index.status, "passed");
const directory = mkdtempSync(
  path.join(fileURLToPath(new URL("./runs/", import.meta.url)), "preview-seek-correction-"),
);
const result = {
  utc: new Date().toISOString(),
  priorIndex: indexPath,
  priorIndexSha256: createHash("sha256").update(readFileSync(indexPath)).digest("hex"),
  reason: "Original Preview selector matched no video nodes; playback and Final evidence unchanged",
  results: [],
  status: "running",
};
let session;
try {
  for (const item of index.workloads) {
    if (session) result.results.at(-1).cleanup = await session.close();
    session = await nativeSession({
      launcherReceipt,
      executable: release.executable,
      executableSha256: release.executableSha256,
      leaseMs: 600000,
    });
    await session.page.setViewportSize({ width: 1280, height: 720 });
    const fixture = fixtureData(index.mediaReceipt, item.kind, item.rate),
      label = `${item.kind}-${item.rate.replace("/", "-")}`;
    for (const asset of fixture.projection.state.assets)
      await pickNative(session, "video_pick_source", {}, asset.locator.absolutePath);
    await session.page.getByRole("button", { name: "Open project", exact: true }).click();
    submitOwnedPicker(session, item.nativeData.file);
    await session.page.waitForFunction(
      () =>
        globalThis.__p2SeekTo && !globalThis.document.querySelector(".transport-play")?.disabled,
      undefined,
      { timeout: 30000 },
    );
    const dir = path.join(directory, label);
    mkdirSync(dir);
    result.results.push({
      kind: item.kind,
      rate: item.rate,
      identity: session.owned.identity,
      environmentOverrides: session.env,
      fixtureSha256: fixture.fixtureSha256,
      seeks: await seekSamples(session.page, dir, "Preview", fixture, "Preview"),
    });
    console.log(
      JSON.stringify({ completed: label, failures: result.results.at(-1).seeks.failures }),
    );
  }
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = String(error);
  if (session) {
    try {
      result.visibleText = (await session.page.locator("body").innerText()).slice(0, 20000);
    } catch {
      result.pageUnavailable = true;
    }
  }
  throw error;
} finally {
  if (session) result.cleanup = await session.close();
  const out = path.join(directory, "index.json");
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({
      out,
      sha256: createHash("sha256").update(readFileSync(out)).digest("hex"),
      status: result.status,
    }),
  );
}
