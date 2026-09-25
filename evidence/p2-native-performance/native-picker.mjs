import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
const base = fileURLToPath(new URL("./", import.meta.url));
export function submitOwnedPicker(session, file) {
  const runs = realpathSync(path.join(base, "runs")),
    full = path.resolve(file);
  const relative = path.relative(runs, realpathSync(path.dirname(full)));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.(mp4|svpvideo)$/i.test(full))
    throw new Error("Picker path outside evidence roots");
  const source = readFileSync(
    new URL("../2026-09-16-p2-editor-controls-completion/native-file-dialog.ps1", import.meta.url),
  );
  if (
    createHash("sha256").update(source).digest("hex") !==
    "c81d41c4053e1b0521a0aaf1e6e76b8813ab207acc76b3589b1d45631a4094f4"
  )
    throw new Error("Reviewed picker source changed");
  if (runs.includes("'")) throw new Error("Unsupported quote in evidence root");
  const script = source
    .toString()
    .replace(
      /\$testRoot =[^\r\n]*\r?\n\$media =[^\r\n]*\r?\nif \(!\$full\.StartsWith[^\r\n]*/,
      `$testRoot = '${runs}\\'\nif (!$full.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Not an authorized disposable fixture path' }`,
    );
  if (script === source.toString()) throw new Error("Picker scope adaptation failed");
  const out = path.join(session.run, "native-file-dialog.ps1");
  if (!existsSync(out)) writeFileSync(out, script, { flag: "wx" });
  else if (readFileSync(out, "utf8") !== script) throw new Error("Generated picker changed");
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-File",
      out,
      "-OwnerId",
      String(session.owned.identity.pid),
      "-Creation",
      session.owned.identity.creation,
      "-FilePath",
      full,
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
  );
}
export async function invokeNative(page, command, args = {}) {
  return page.evaluate(
    ([name, payload]) => globalThis.__TAURI_INTERNALS__.invoke(name, payload),
    [command, args],
  );
}
export async function pickNative(session, command, args, file) {
  await session.page.evaluate(
    ([name, payload]) => {
      globalThis.__p2PickerResult = globalThis.__TAURI_INTERNALS__.invoke(name, payload);
    },
    [command, args],
  );
  submitOwnedPicker(session, file);
  const selected = await session.page.evaluate(() => globalThis.__p2PickerResult);
  if (
    typeof selected !== "string" ||
    path.toNamespacedPath(path.resolve(selected)).toLowerCase() !==
      path.toNamespacedPath(path.resolve(file)).toLowerCase()
  )
    throw new Error(
      `Native picker selected unexpected path: ${JSON.stringify({ selected, expected: file })}`,
    );
  return selected;
}
