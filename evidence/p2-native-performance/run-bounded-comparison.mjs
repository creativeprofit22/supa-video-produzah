import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { launchOwned } from "./owned-run.mjs";
const base = fileURLToPath(new URL("./", import.meta.url));
const [target, release, nativeIndex] = process.argv.slice(2);
assert.ok(["native-profile", "native-uninstrumented", "browser-profile"].includes(target));
const preflight = execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    '@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "OwnedRun.exe" -or $_.ExecutablePath -like "*p2-native-performance*runs*" } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress',
  ],
  { encoding: "utf8", timeout: 10000 },
);
assert.equal(preflight.trim(), "", "Existing owned workload detected; refusing duplicate");
const directory = mkdtempSync(path.join(base, "runs", "bounded-comparison-"));
const save = (name, value) =>
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const launcher = path.join(base, "runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json");
const media = path.join(base, "runs/media-9f3WSn/receipt.json");
const argv = [
  path.join(base, "run-workloads.mjs"),
  target,
  path.resolve(release),
  launcher,
  media,
  ...(nativeIndex ? [path.resolve(nativeIndex)] : []),
];
save("inputs.json", {
  utc: new Date().toISOString(),
  target,
  argv,
  workloads: process.env.P2_WORKLOADS ?? null,
  watchdogMs: 4500000,
  cleanupDrainMs: 10000,
  preflight,
  source: JSON.parse(
    execFileSync(process.execPath, [path.join(base, "snapshot.mjs")], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4194304,
    }),
  ),
});
console.log(`COMPARISON_START ${directory}`);
const owned = await launchOwned(launcher, process.execPath, argv, {
  leaseMs: 4500000,
  env: { P2_COMPARISON_RECEIPT: path.join(directory, "index-pointer.json") },
});
let sampler;
try {
  const owner = JSON.parse(
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${owned.launcherPid}'; if($null -eq $p){throw 'Missing owner'}; $p | Select-Object ProcessId,ExecutablePath,@{n='creationUtc';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  const expected = JSON.parse(readFileSync(launcher, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(owner.ExecutablePath.toLowerCase(), expected.executable.toLowerCase());
  save("ownership.json", { owner, child: owned.identity });
  sampler = new Promise((resolve) =>
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-File",
        path.join(base, "sample-resources.ps1"),
        "-OwnedPid",
        String(owned.launcherPid),
        "-ExpectedExecutable",
        owner.ExecutablePath,
        "-ExpectedCreationUtc",
        owner.creationUtc,
        "-DurationSeconds",
        "4500",
      ],
      { timeout: 4515000, encoding: "utf8", maxBuffer: 16777216 },
      (error, stdout, stderr) => {
        writeFileSync(path.join(directory, "resources.jsonl"), stdout, { flag: "wx" });
        resolve({ ok: !error, error: error ? String(error) : null, stderr });
      },
    ),
  );
  const exit = await owned.exit;
  save("worker.json", exit);
  const closed = exit.events.find((event) => event.event === "closed");
  const sample = await sampler;
  save("sampler.json", sample);
  const status =
    exit.code === 0 &&
    !exit.overflow &&
    closed?.empty === true &&
    closed.rootExitBeforeCleanup === 0 &&
    sample.ok
      ? "passed"
      : "failed";
  const index = JSON.parse(readFileSync(path.join(directory, "index-pointer.json"), "utf8"));
  save("result.json", { status, index, cleanupConfirmed: closed?.empty === true });
  console.log(JSON.stringify({ directory, status, index }));
  if (status !== "passed") process.exitCode = 1;
} finally {
  save("cleanup.json", await owned.close());
  if (sampler) await sampler;
}
