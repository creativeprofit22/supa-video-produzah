// Probe: does the isolated app exit on WM_CLOSE (a user clicking the window X)?
// Launches with no project, optionally keeps a CDP connection open, posts WM_CLOSE to the
// owned top-level window, and records window title, PostMessage result and exit timing.
// Run from repo root: node evidence/2026-09-29-p3-agent-proposals/01-close-probe.mjs [cdp|nocdp]
import fs from "node:fs";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startOwned } from "../2026-09-28-p3-transcription-audio/13-owned.mjs";

const { chromium } = createRequire(path.resolve("apps/desktop/package.json"))("@playwright/test");
const exe = "E:/nemo-runtime/proof/hwhap-436/scenario/target/debug/supa-video-desktop.exe";
const mode = process.argv[2] ?? "cdp";
const runDir = `E:\\nemo-runtime\\proof\\hwhap-436\\scenario\\close-probe-${mode}-${Date.now()}`;
fs.mkdirSync(runDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
const t0 = Date.now();
const out = (event, data = {}) => console.log(JSON.stringify({ t: Date.now() - t0, event, ...data }));

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(runDir, "webview");
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
process.env.SUPA_VIDEO_AGENT_PROPOSALS = "1";
const owned = startOwned(exe, ["--p3-close-probe"], { leaseMs: 300000, onEvent: () => {} });
try {
  const identity = await owned.wait((event) => event.event === "identity", 15000);
  let browser;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* not up */
    }
    await sleep(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => typeof globalThis.__TAURI_INTERNALS__?.invoke === "function");
  await page.getByRole("button", { name: "New project", exact: true }).waitFor({ timeout: 30000 });
  await sleep(2000);
  if (mode === "nocdp") await browser.close().catch(() => {});
  const { handle } = await owned.findWindow(identity);
  const res = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);'; $h=[System.IntPtr]${handle}; $t=New-Object System.Text.StringBuilder 256; $c=New-Object System.Text.StringBuilder 256; [void][W.U]::GetWindowText($h,$t,256); [void][W.U]::GetClassName($h,$c,256); $r=[W.U]::PostMessage($h, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero); "title=$t class=$c posted=$r"`,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  out("wm-close", { handle, result: res.trim() });
  if (mode === "cdp") {
    await sleep(2000);
    const dialogs = await page
      .evaluate(() => [...globalThis.document.querySelectorAll("dialog[open]")].map((d) => d.innerText.slice(0, 200)))
      .catch((e) => `page gone: ${e.message}`);
    out("open-dialogs", { dialogs });
  }
  const exit = await Promise.race([owned.exit, sleep(20000).then(() => null)]);
  out("result", { exited: exit !== null, exit, closed: owned.events.find((e) => e.event === "closed") ?? null });
} finally {
  await owned.close();
}
