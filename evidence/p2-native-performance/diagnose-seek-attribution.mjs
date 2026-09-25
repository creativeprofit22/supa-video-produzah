import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { launchOwned } from "./owned-run.mjs";
const base = fileURLToPath(new URL("./", import.meta.url));
const runs = realpathSync(path.join(base, "runs"));
const json = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const save = (dir, file, value) =>
  writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2), { flag: "wx" });
const precise = process.argv.includes("--precise");
if (process.argv[2] === "--worker") {
  const dir = realpathSync(process.argv[3]);
  assert.equal(path.dirname(dir), runs);
  try {
    const trace = async (operation, action) => {
      const mark = (event, error) =>
        appendFileSync(
          path.join(dir, "operations.jsonl"),
          `${JSON.stringify({ utc: new Date().toISOString(), event, operation, error })}\n`,
        );
      mark("before");
      try {
        const value = await action();
        mark("after");
        return value;
      } catch (error) {
        mark("error", String(error));
        throw error;
      }
    };
    const { browserSession } = await import("./browser-session.mjs");
    const { installObserver } = await import("./browser-observer.mjs");
    const index = json(path.join(runs, "workloads-native-profile-OgQYqs/index.json"));
    const release = json(index.releasePath);
    const outcomes = [];
    for (const kind of ["two-layer", "timeline-1000"]) {
      const fixture = index.workloads.find((row) => row.kind === kind && row.rate === "30/1");
      let session;
      try {
        session = await trace(`${kind}.open`, () =>
          browserSession(
            path.join(runs, "browser-comparison-20260920-a"),
            fixture.nativeData,
            path.join(process.env.LOCALAPPDATA, release.identifier),
            trace,
          ),
        );
        save(dir, `${kind}-identity.json`, {
          hashes: session.hashes,
          source: fixture.nativeData.file,
          version: session.page.context().browser().version(),
        });
        const page = session.page;
        await page.evaluate(installObserver, { cap: 10000, leaseMs: 60000 });
        // Preserve each failed sample's immediate predecessor, avoiding a full matrix rerun.
        const samples = fixture.modes[0].seeks.samples;
        const failures = samples.filter((sample) => sample.status === "timeout").slice(0, 2);
        for (const failure of failures) {
          for (const frame of [samples[failure.index - 1].frame, failure.frame]) {
            const sequence = fixture.nativeData.projection.state.sequences[0];
            const expectedClip = sequence.tracks
              .filter((track) => track.kind === "video" && !track.hidden)
              .flatMap((track) => track.clips)
              .find(
                (clip) =>
                  frame >= clip.timelineStart.value &&
                  frame < clip.timelineStart.value + clip.sourceOut.value - clip.sourceIn.value,
              );
            if (!expectedClip) {
              await trace("gap.seek", () =>
                page.evaluate((frame) => globalThis.__p2SeekTo(frame), frame),
              );
              continue;
            }
            const rate = sequence.rate.numerator / sequence.rate.denominator;
            const target = {
              seconds:
                (frame - expectedClip.timelineStart.value + expectedClip.sourceIn.value) / rate,
              frameSeconds: 1 / rate,
            };
            const selector = precise
              ? `.monitor-stage video[data-clip-id="${expectedClip.id}"]`
              : 'video[aria-label^="Canonical video layer"]';
            await trace(`seek.${frame}`, () =>
              page.evaluate(
                ({ frame, target, selector, clipId }) => {
                  globalThis.__p2Observer.armSeek(
                    selector,
                    target.seconds,
                    target.frameSeconds,
                    5000,
                    { clipId },
                  );
                  globalThis.__p2Observer.markRequest();
                  globalThis.__p2SeekTo(frame);
                },
                { frame, target, selector, clipId: expectedClip.id },
              ),
            );
            await trace(`settle.${frame}`, () =>
              page.waitForFunction(
                () => globalThis.__p2Observer.snapshot().pendingSeeks === 0,
                undefined,
                { timeout: 6000 },
              ),
            );
            const observation = await page.evaluate(() => ({
              seek: globalThis.__p2Observer
                .snapshot()
                .events.filter((event) => event.type === "seek")
                .at(-1),
              media: [...globalThis.document.querySelectorAll(".monitor-stage video")].map(
                (video) => ({
                  clipId: video.dataset.clipId,
                  active: video.dataset.active,
                  currentTime: video.currentTime,
                  readyState: video.readyState,
                  seeking: video.seeking,
                }),
              ),
            }));
            const entry = { kind, frame, expectedClipId: expectedClip.id, ...observation };
            outcomes.push(entry);
            appendFileSync(path.join(dir, "seeks.jsonl"), `${JSON.stringify(entry)}\n`);
          }
        }
      } finally {
        if (session) {
          await trace(`${kind}.close`, () => session.close());
          save(dir, `${kind}-cleanup.json`, { completed: true, utc: new Date().toISOString() });
        }
      }
    }
    save(dir, "result.json", { precise, outcomes });
    assert.ok(
      outcomes.every(
        (row) => row.seek.status === "ok" || row.seek.status === "same-frame-no-new-frame",
      ),
      "Seek reproduction failed; preserve attribution evidence",
    );
  } catch (error) {
    save(dir, "error.json", { error: String(error), stack: error.stack });
    throw error;
  }
} else {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && precise));
  const active = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      '@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "OwnedRun.exe" }) | Select-Object ProcessId | ConvertTo-Json -Compress',
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(active.trim(), "", "Do not overlap owned diagnostics");
  const dir = mkdtempSync(path.join(runs, "seek-attribution-"));
  save(dir, "inputs.json", {
    utc: new Date().toISOString(),
    precise,
    watchdogMs: 180000,
    files: [
      "diagnose-seek-attribution.mjs",
      "browser-observer.mjs",
      "measure-page.mjs",
      "metrics.mjs",
    ].map((file) => ({
      file,
      sha256: createHash("sha256")
        .update(readFileSync(path.join(base, file)))
        .digest("hex"),
    })),
  });
  console.log(`SEEK_DIAGNOSTIC ${dir}`);
  const owned = await launchOwned(
    path.join(runs, "launcher-6bddff38882644cfb9a5ee567098e082/receipt.json"),
    process.execPath,
    [fileURLToPath(import.meta.url), "--worker", dir, ...(precise ? ["--precise"] : [])],
    { leaseMs: 180000 },
  );
  try {
    const exit = await owned.exit;
    save(dir, "cleanup.json", exit);
    const closed = exit.events.find((event) => event.event === "closed");
    assert.ok(exit.code === 0 && closed?.empty === true);
    process.exitCode = closed.rootExitBeforeCleanup === 0 ? 0 : 1;
    console.log(
      JSON.stringify({ dir, workerExit: closed.rootExitBeforeCleanup, cleanup: closed.empty }),
    );
  } finally {
    await owned.close();
  }
}
