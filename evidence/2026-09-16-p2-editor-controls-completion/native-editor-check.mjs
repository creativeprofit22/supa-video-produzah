import fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startOwned } from "../2026-09-14-p2-speed/output-capture/owned-browser.mjs";
const { chromium, expect } = createRequire(path.resolve("apps/desktop/package.json"))(
  "@playwright/test",
);
const root = path.resolve("evidence/2026-09-16-p2-editor-controls-completion");
if (
  !fs
    .readFileSync(path.resolve("apps/desktop/src-tauri/target/debug/supa-video-desktop.exe"))
    .includes(Buffer.from("com.supavideo.editor-controls-completion-20260916"))
)
  throw Error(
    "Refusing to launch an ordinary build against existing app state; compile the isolated identifier first",
  );
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-controls-native-"));
const project = path.join(directory, "acceptance.svpvideo");
const source = path.resolve("apps/desktop/browser-tests/completion-layer-red.mp4");
process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(directory, "webview");
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
  "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9226";
console.log(JSON.stringify({ directory, project }));
const events = [];
let baseline;
let expectedLayout;
for (let launch = 0; launch < 2; launch++) {
  const port = net.createServer();
  await new Promise((resolve, reject) => {
    port.once("error", reject);
    port.listen(9226, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => port.close(resolve));
  const owned = startOwned(
    path.resolve("apps/desktop/src-tauri/target/debug/supa-video-desktop.exe"),
    ["--editor-controls-proof"],
    {
      leaseMs: 120000,
      onEvent: (event) => events.push({ launch, ...event }),
    },
  );
  let browser;
  let failure;
  try {
    const identity = await owned.wait((event) => event.event === "identity", 10000);
    await expect
      .poll(
        async () => {
          try {
            return (await globalThis.fetch("http://127.0.0.1:9226/json/version")).ok;
          } catch {
            return false;
          }
        },
        { timeout: 10000 },
      )
      .toBe(true);
    browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(10000);
    await expect.poll(() => page.url()).toBe("http://localhost:1420/");
    expect(await page.evaluate(() => typeof globalThis.__TAURI_INTERNALS__?.invoke)).toBe(
      "function",
    );
    // Tool readiness is a native prerequisite, not a 10-second button action.
    // Observe its real IPC result within the unchanged owned-process lease.
    const toolStarted = Date.now();
    const toolStatus = await page.evaluate(() =>
      globalThis.__TAURI_INTERNALS__.invoke("video_ffmpeg_status"),
    );
    console.log(
      JSON.stringify({
        event: "NATIVE_TOOL_STATUS",
        elapsedMs: Date.now() - toolStarted,
        toolStatus,
      }),
    );
    expect(toolStatus.ready).toBe(true);
    const choose = async (button, file) => {
      await page.getByRole("button", { name: button, exact: true }).click();
      console.log(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-File",
            path.join(root, "native-file-dialog.ps1"),
            "-OwnerId",
            String(identity.pid),
            "-Creation",
            identity.creation,
            "-FilePath",
            file,
          ],
          { encoding: "utf8", timeout: 10000 },
        ),
      );
    };
    const revision = async (number) =>
      expect(page.locator(".project-status")).toContainText(`Revision ${number}`);
    if (launch === 0) {
      await choose("New project", project);
      await revision(0);
      await choose("Choose video", source);
      // Import/preparation is a native job, not an edit-acknowledgement assertion.
      // Await its observable terminal UI state under the unchanged owned job lease.
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const observer = new globalThis.MutationObserver(check);
            function check() {
              const status =
                globalThis.document.querySelector(".project-status")?.textContent ?? "";
              const failure = globalThis.document.querySelector(".inline-error")?.textContent;
              if (failure) {
                observer.disconnect();
                reject(new Error(failure));
              } else if (status.includes("Revision 1")) {
                observer.disconnect();
                resolve(true);
              }
            }
            observer.observe(globalThis.document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            check();
          }),
      );
      await revision(1);
      await expect(page.getByRole("spinbutton", { name: "Speed (%)", exact: true })).toBeVisible();
      const speed = page.getByRole("spinbutton", { name: "Speed (%)", exact: true });
      await speed.fill("150");
      await page.getByRole("button", { name: "Apply speed", exact: true }).focus();
      await page.keyboard.press("Enter");
      await revision(2);
      await expect(speed).toBeFocused();
      await page.getByRole("spinbutton", { name: "Volume (dB)", exact: true }).fill("-6");
      await page
        .getByRole("spinbutton", { name: "Fade in (sequence frames)", exact: true })
        .fill("5");
      await page
        .getByRole("spinbutton", { name: "Fade out (sequence frames)", exact: true })
        .fill("7");
      await page.getByRole("button", { name: "Apply audio", exact: true }).click();
      await revision(3);
      await page.getByRole("spinbutton", { name: /^Source in/ }).fill("30");
      await page.getByRole("button", { name: "Apply source range", exact: true }).click();
      await revision(4);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await revision(5);
      await expect(page.getByRole("spinbutton", { name: /^Source in/ })).toHaveValue("0");
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      await revision(6);
      await expect(page.getByRole("spinbutton", { name: /^Source in/ })).toHaveValue("30");
      await page.getByRole("button", { name: "Video 1 track lock", exact: true }).click();
      await revision(7);
      await expect(speed).toBeDisabled();
      await expect(page.getByRole("button", { name: "Apply audio", exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Apply source range", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Video 1 track lock", exact: true }).click();
      await revision(8);
      await expect(page.locator(".frame-readout")).toHaveText("Frame 0");
      for (let step = 0; step < 12; step++)
        await page.getByRole("button", { name: "Step forward five frames", exact: true }).click();
      await expect(page.locator(".frame-readout")).toHaveText("Frame 60");
      await page.getByRole("button", { name: /^Split at playhead/ }).click();
      await revision(9);
      const selects = page.getByRole("button", { name: /^Select completion-layer-red/ });
      await expect(selects).toHaveCount(2);
      for (let index = 0; index < 2; index++) {
        if ((await selects.nth(index).getAttribute("aria-pressed")) !== "true") {
          await selects.nth(index).focus();
          await page.keyboard.press("Space");
        }
      }
      const bulk = page.getByRole("region", { name: "Multiple clip controls", exact: true });
      await expect(bulk).toBeVisible();
      await bulk.getByRole("spinbutton", { name: "Common volume (dB)", exact: true }).fill("-9");
      await bulk.getByRole("button", { name: "Apply to selected clips", exact: true }).click();
      await revision(10);
      await bulk.getByRole("spinbutton", { name: "Common speed (%)", exact: true }).fill("200");
      await bulk.getByRole("button", { name: "Apply common speed", exact: true }).click();
      await revision(11);
      await bulk
        .getByRole("spinbutton", { name: "Relative move (sequence frames)", exact: true })
        .fill("5");
      await bulk.getByRole("button", { name: "Move selected clips", exact: true }).click();
      await revision(12);
      await bulk.getByRole("button", { name: "Delete 2 clips (undoable)", exact: true }).click();
      await revision(13);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await revision(14);
      await expect(selects).toHaveCount(2);
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      await revision(15);
      await expect(selects).toHaveCount(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await revision(16);
      await expect(selects).toHaveCount(2);
      const separator = page.getByRole("separator", {
        name: "Program and media / editing controls pane width",
      });
      await separator.focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Tab");
      expectedLayout = await page.evaluate(() =>
        globalThis.localStorage.getItem("supa-video.workspace-preferences"),
      );
      expect(expectedLayout).not.toBeNull();
      await revision(16);
      await page.screenshot({
        path: path.join(root, "native-editor-controls.png"),
        fullPage: true,
      });
      // Open through the real native picker; no mock IPC or app-store replacement.
      await choose("Open", project);
      await revision(16);
      await expect(speed).toHaveValue("200");
      await expect(page.getByRole("spinbutton", { name: "Volume (dB)", exact: true })).toHaveValue(
        "-9",
      );
    } else {
      await choose("Open project", project);
      await revision(16);
      await expect(page.getByRole("spinbutton", { name: "Speed (%)", exact: true })).toHaveValue(
        "200",
      );
      expect(
        await page.evaluate(() =>
          globalThis.localStorage.getItem("supa-video.workspace-preferences"),
        ),
      ).toBe(expectedLayout);
      await expect(
        page.getByRole("region", { name: "Multiple clip controls", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("spinbutton", { name: /^Source in/ })).toHaveValue("30");
      await expect(page.getByRole("spinbutton", { name: "Volume (dB)", exact: true })).toHaveValue(
        "-9",
      );
      const after = JSON.parse(fs.readFileSync(project, "utf8"));
      expect(after.state).toEqual(baseline.state);
      expect(after.revision).toEqual(baseline.revision);
      expect(after.history).toEqual(baseline.history);
    }
    console.log(
      JSON.stringify({
        launch,
        url: page.url(),
        runtime: await browser.version(),
        status: "UI_CHECKS_PASS",
      }),
    );
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=Get-Process -Id ${identity.pid}; if($p.StartTime.ToFileTimeUtc().ToString() -ne '${identity.creation}'){throw 'Identity mismatch'}; if(!$p.CloseMainWindow()){throw 'Close rejected'}; if(!$p.WaitForExit(10000)){throw 'Close timed out'}`,
      ],
      { timeout: 15000 },
    );
    if (launch === 0) {
      baseline = JSON.parse(fs.readFileSync(project, "utf8"));
      expect(baseline.revision.number).toBe(16);
      expect(
        baseline.state.sequences[0].tracks[0].clips.map((clip) => [
          clip.timelineStart.value,
          clip.sourceIn.value,
          clip.sourceOut.value,
          clip.speed.numerator,
          clip.speed.denominator,
          clip.gainMilliDecibels,
          clip.fades.inFrames,
          clip.fades.outFrames,
        ]),
      ).toEqual([
        [5, 30, 120, 2, 1, -9000, 5, 7],
        [65, 120, 180, 2, 1, -9000, 5, 7],
      ]);
      expect(baseline.history.undoStack).toHaveLength(10);
      expect(baseline.history.redoStack).toHaveLength(1);
      fs.writeFileSync(path.join(directory, "expected.json"), JSON.stringify(baseline, null, 2));
    }
  } catch (error) {
    console.error(error);
    if (browser)
      console.error(
        await browser
          .contexts()[0]
          .pages()[0]
          .locator("body")
          .innerText()
          .catch(() => "Native page unavailable"),
      );
    failure = error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    const closed = await owned.close();
    fs.writeFileSync(path.join(directory, `owned-${launch}.json`), JSON.stringify(events, null, 2));
    if (closed.code !== 0 || !owned.events.some((event) => event.event === "closed" && event.empty))
      failure = new AggregateError(failure ? [failure] : [], "Owned process cleanup not confirmed");
  }
  if (failure) throw failure;
}
console.log(JSON.stringify({ status: "NATIVE_UI_RESTART_PASS", directory }));
