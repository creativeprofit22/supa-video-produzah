import fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startOwned } from "../2026-09-14-p2-speed/output-capture/owned-browser.mjs";
if (
  !fs
    .readFileSync(path.resolve("apps/desktop/src-tauri/target/debug/supa-video-desktop.exe"))
    .includes(Buffer.from("com.supavideo.editor-controls-completion-20260916"))
)
  throw Error("Refusing ordinary application build; isolated identifier required");
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(9226, "127.0.0.1", resolve);
});
await new Promise((resolve) => probe.close(resolve));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-controls-native-"));
process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(directory, "webview");
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
  "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9226";
const owned = startOwned(
  path.resolve("apps/desktop/src-tauri/target/debug/supa-video-desktop.exe"),
  ["--editor-controls-proof"],
  {
    leaseMs: 120000,
    onEvent: (event) => console.log(JSON.stringify(event)),
  },
);
try {
  const identity = await owned.wait((event) => event.event === "identity", 10000);
  console.log(JSON.stringify({ event: "NATIVE_OWNED", identity, directory }));
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", () => void owned.close());
  process.stdin.once("end", () => void owned.close());
  await owned.exit;
} finally {
  await owned.close();
  process.stdin.pause();
}
