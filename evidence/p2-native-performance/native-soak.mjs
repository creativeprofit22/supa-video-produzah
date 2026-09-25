import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { invokeNative, submitOwnedPicker } from "./native-picker.mjs";
import { pausePlayback } from "./measure-page.mjs";

export async function nativeSoak(session, project, directory, trace) {
  const mark = (event, data = {}) =>
    appendFileSync(
      path.join(directory, "soak.jsonl"),
      `${JSON.stringify({ utc: new Date().toISOString(), event, ...data })}\n`,
    );
  const page = session.page;
  const clips = project.projection.state.sequences[0].tracks.find(
    (track) => track.kind === "video",
  ).clips;
  const inspect = () =>
    page.evaluate(() => ({
      observerInstalled: !!globalThis.__p2Observer,
      playing: globalThis.document
        .querySelector(".transport-play")
        ?.textContent.trim()
        .startsWith("Pause"),
      media: [...globalThis.document.querySelectorAll(".monitor-stage video")].map((video) => ({
        id: video.dataset.clipId,
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
      })),
      nodes: globalThis.document.getElementsByTagName("*").length,
    }));
  await pausePlayback(page, trace);
  mark("initial-idle-start");
  await trace("soak.initial-idle.60s", () => delay(60000));
  mark("initial-idle-end", await inspect());
  await page.evaluate(() => globalThis.__p2SeekTo(0));
  await page.locator(".transport-play").click();
  await page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll("video")].some(
        (video) => !video.paused && video.currentTime > 0,
      ),
    undefined,
    { timeout: 15000 },
  );
  mark("warmup-start");
  await trace("soak.warmup.60s", () => delay(60000));
  await pausePlayback(page, trace);
  mark("warmup-end");
  const started = Date.now();
  mark("active-start");
  for (let cycle = 0; cycle < 60; cycle++) {
    const clip = clips[Math.floor(((cycle % 6) * (clips.length - 30)) / 6)];
    mark("cycle-start", { cycle, clipId: clip.id });
    await trace(`soak.${cycle}.seek`, () =>
      page.evaluate((frame) => globalThis.__p2SeekTo(frame), clip.timelineStart.value + 2),
    );
    await page.locator(".transport-play").click();
    await page.waitForFunction(
      () =>
        [...globalThis.document.querySelectorAll("video")].some(
          (video) => !video.paused && video.readyState >= 2,
        ),
      undefined,
      { timeout: 15000 },
    );
    await trace(`soak.${cycle}.play.45s`, () => delay(45000));
    const sample = await trace(`soak.${cycle}.inspect`, inspect);
    assert.equal(sample.observerInstalled, false);
    assert.ok(sample.media.length <= 7);
    assert.equal(sample.playing, true);
    mark("cycle-playback-end", { cycle, ...sample });
    await pausePlayback(page, trace);
    if (cycle % 10 === 9) {
      mark("project-close-start", { cycle });
      await trace(`soak.${cycle}.project-close`, () =>
        invokeNative(page, "video_close_project", { projectId: project.projection.projectId }),
      );
      // Reload only this isolated frontend to clear its old project state after the real native close.
      await trace(`soak.${cycle}.frontend-reload`, () =>
        page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }),
      );
      await page.getByRole("button", { name: "Open project", exact: true }).click();
      submitOwnedPicker(session, project.file);
      await page.waitForFunction(
        () =>
          globalThis.__p2SeekTo && !globalThis.document.querySelector(".transport-play")?.disabled,
        undefined,
        { timeout: 30000 },
      );
      const mute = page.getByRole("button", { name: "Mute audio", exact: true });
      if (await mute.count()) await mute.click();
      mark("project-reopened", { cycle });
    }
    const remaining = started + (cycle + 1) * 60000 - Date.now();
    if (remaining > 0) await trace(`soak.${cycle}.pause-dwell`, () => delay(remaining));
    mark("cycle-end", { cycle });
  }
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs >= 3600000);
  mark("active-end", { elapsedMs });
  mark("final-idle-start");
  await trace("soak.final-idle.60s", () => delay(60000));
  mark("final-idle-end", await inspect());
  return {
    elapsedMs,
    cycles: 60,
    reopenCycles: 6,
    initialIdleSeconds: 60,
    warmupSeconds: 60,
    finalIdleSeconds: 60,
    observerInstalled: false,
    closeMechanism:
      "native IPC close, isolated frontend reload, real picker reopen; not OS application restart",
  };
}
