import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import console from "node:console";
import { browserSession } from "./browser-session.mjs";
import { pausePlayback } from "./measure-page.mjs";
const [baselinePath, releasePath] = process.argv.slice(2);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")),
  release = JSON.parse(readFileSync(releasePath, "utf8"));
assert.equal(baseline.status, "passed");
const output = baseline.exportProbeArgv.at(-1);
const probe = {
  ...baseline.project.projection.state.assets[0].probe,
  durationMicroseconds: Math.round(Number(baseline.exportProbe.format.duration) * 1000000),
  fileSizeBytes: statSync(output).size,
};
const data = {
  ...baseline.project,
  finalOutput: { outputPath: output, previewPath: output, probe },
};
const session = await browserSession(
  fileURLToPath(new URL("./runs/browser-profile/", import.meta.url)),
  data,
  path.join(process.env.LOCALAPPDATA, release.identifier),
);
try {
  for (let repeat = 0; repeat < 3; repeat++) {
    await pausePlayback(session.page);
    await pausePlayback(session.page);
    await session.page.evaluate(() => globalThis.__p2SeekTo(0));
    await session.page.locator(".transport-play").click();
    await session.page.waitForFunction(
      () =>
        [...globalThis.document.querySelectorAll("video")].some(
          (v) => !v.paused && v.currentTime > 0.3,
        ),
      undefined,
      { timeout: 15000 },
    );
    await pausePlayback(session.page);
    assert.ok(
      (await session.page.locator(".transport-play").innerText()).trim().startsWith("Play"),
    );
  }
  await session.page.getByRole("button", { name: "Export MP4", exact: true }).click();
  await session.page.getByRole("button", { name: "Final", exact: true }).click();
  await session.page.locator(".transport-play").click();
  await session.page.waitForFunction(
    () =>
      globalThis.document.querySelector('video[aria-label="Verified final video preview"]')
        ?.currentTime > 1,
    undefined,
    { timeout: 15000 },
  );
  const counts = await session.page.evaluate(() =>
    ["VideoWorkspace", "MultitrackTimeline"].map((id) => ({
      id,
      callbacks: globalThis.__p2Commits.samples.filter((s) => s.id === id).length,
    })),
  );
  assert.ok(counts.every((c) => c.callbacks > 0));
  console.log(
    JSON.stringify({
      scope:
        "browser mock-IPC plumbing only; native-produced proxy/Final media; not fixed-duration measurement",
      browser: session.version,
      counts,
      files: session.hashes,
    }),
  );
} finally {
  await session.close();
}
