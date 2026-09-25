import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { launchOwned } from "./owned-run.mjs";
import { fixtureData } from "./fixture-data.mjs";
const receiptPath = process.env.P2_LAUNCHER_RECEIPT;
if (!receiptPath)
  throw new Error("P2_LAUNCHER_RECEIPT is required; build the local launcher first");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8").replace(/^\uFEFF/, ""));
const ps = (file, args) =>
  execFileSync(
    "powershell",
    ["-NoProfile", "-File", fileURLToPath(new URL(file, import.meta.url)), ...args],
    { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 },
  );
test("owned native tree is sampled and fully reaped on explicit teardown", async () => {
  const owned = await launchOwned(receiptPath, receipt.executable, ["--fixture-tree"], {
    leaseMs: 30000,
  });
  try {
    const observed = JSON.parse(
      ps("./inspect-owned.ps1", [
        "-OwnedPid",
        String(owned.identity.pid),
        "-Creation",
        owned.identity.creation,
      ]),
    );
    assert.ok(observed.descendants.length >= 2);
    const lines = ps("./sample-resources.ps1", [
      "-OwnedPid",
      String(owned.identity.pid),
      "-ExpectedExecutable",
      receipt.executable,
      "-ExpectedCreationUtc",
      observed.creationUtc,
      "-DurationSeconds",
      "5",
    ])
      .trim()
      .split(/\r?\n/)
      .map((s) => JSON.parse(s));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((s) => s.rootAlive && s.processCount >= 2));
    assert.ok(
      lines.every((s) =>
        s.processes.every(
          (p) => p.privateBytes > 0 && p.workingSet > 0 && p.handles > 0 && p.cpuSeconds >= 0,
        ),
      ),
    );
  } finally {
    const result = await owned.close();
    assert.ok(result.events.some((e) => e.event === "closed" && e.empty));
  }
});
test("lease expiry reaps the entire owned native tree", async () => {
  const owned = await launchOwned(receiptPath, receipt.executable, ["--fixture-tree"], {
    leaseMs: 300,
  });
  const result = await owned.exit;
  assert.equal(result.code, 0);
  assert.ok(result.events.some((e) => e.event === "closed" && e.empty));
});
test("full disposable project states validate with the pinned media at both cadences", () => {
  if (!process.env.P2_MEDIA_RECEIPT) throw new Error("P2_MEDIA_RECEIPT required");
  for (const kind of ["small", "timeline-1000", "two-layer"])
    for (const rate of ["30/1", "30000/1001"]) {
      const fixture = fixtureData(process.env.P2_MEDIA_RECEIPT, kind, rate);
      assert.equal(fixture.projection.state.assets.length, 2);
      assert.equal(fixture.projection.state.activeSequenceId, fixture.sequence.id);
      assert.match(fixture.fixtureSha256, /^[a-f0-9]{64}$/);
    }
});
test("Node worker writes a startup marker before external lease reaps it", async () => {
  const directory = mkdtempSync(
    fileURLToPath(new URL("./runs/node-watchdog-test-", import.meta.url)),
  );
  const marker = path.join(directory, "started.json");
  const owned = await launchOwned(
    receiptPath,
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}), {flag:'wx'}); setInterval(()=>{},1000);`,
    ],
    { leaseMs: 3000 },
  );
  const result = await owned.exit;
  assert.equal(result.code, 0);
  assert.ok(result.events.some((e) => e.event === "closed" && e.empty));
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).pid, owned.identity.pid);
});
test("minimal bootstrap traces entry and a real ESM import under the owned launcher", async () => {
  const directory = mkdtempSync(
    fileURLToPath(new URL("./runs/browser-watchdog-bootstrap-test-", import.meta.url)),
  );
  const script = path.join(directory, "fixture.mjs");
  writeFileSync(
    script,
    "import process from 'node:process'; export const started = process.pid > 0;\n",
    { flag: "wx" },
  );
  const source = readFileSync(
    fileURLToPath(new URL("./worker-bootstrap.cjs", import.meta.url)),
    "utf8",
  );
  const owned = await launchOwned(
    receiptPath,
    process.execPath,
    ["-e", source, script, "--worker", directory],
    { leaseMs: 5000 },
  );
  const result = await owned.exit;
  assert.equal(result.code, 0);
  assert.ok(result.events.some((e) => e.event === "closed" && e.empty));
  const events = readFileSync(path.join(directory, "bootstrap.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0].pid, owned.identity.pid);
  assert.ok(events.some((e) => e.operation === "bootstrap.import-worker" && e.event === "after"));
});
test("invalid long lease is refused without launching", async () => {
  await assert.rejects(
    launchOwned(receiptPath, receipt.executable, ["--fixture-tree"], { leaseMs: 4500001 }),
    /Invalid owned lease/,
  );
});
