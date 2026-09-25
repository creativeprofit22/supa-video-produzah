import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { physicalRoi, packetReadiness, reviewedProfile } from "./capture-native.mjs";
import { createBoundedCaptureProcesses } from "./capture-calibration.mjs";

const measured = {
  dpi: 144,
  frame: { left: 20, top: 30, width: 1280, height: 800 },
  client: { left: 20, top: 60, width: 1200, height: 720 },
};
const viewport = { dpr: 1.5, width: 800, height: 480 };
test("physical ROI uses measured DWM/client origin and DPI, not screen guesses", () => {
  assert.deepEqual(physicalRoi(measured, viewport), { x: 528, y: 348, side: 8 });
  for (const changed of [
    { ...viewport, dpr: 1 },
    { ...viewport, width: 799 },
    { ...viewport, height: 300 },
  ])
    assert.throws(() => physicalRoi(measured, changed));
  assert.throws(() =>
    physicalRoi({ ...measured, frame: { ...measured.frame, width: 100 } }, viewport),
  );
  assert.throws(() =>
    physicalRoi({ ...measured, client: { ...measured.client, left: NaN } }, viewport),
  );
});
test("no new audio route when owned graph lacks decoded-zero packet readiness", () => {
  assert.deepEqual(packetReadiness("AUDIO_PACKETS_READY frames=2400 peak=0\n"), {
    frames: 2400,
    peak: 0,
  });
  for (const text of [
    "LOOPBACK_READY",
    "AUDIO_PACKETS_READY frames=100 peak=0",
    "AUDIO_PACKETS_READY frames=2400 peak=0.001",
    "AUDIO_PACKETS_READY frames=2400 peak=NaN",
  ])
    assert.throws(() => packetReadiness(text));
});
test("reviewed controls require explicit absolute path and qualified ordered trio", () => {
  assert.throws(() => reviewedProfile("results.json"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-native-capture-unit-"));
  const file = path.join(directory, "results.json");
  const profile = {
    calibration: "candidate-pass-parent-review-required",
    results: ["sync", "late", "early"].map((name) => ({ name, classification: "pass" })),
    noOffsetSubtraction: true,
    strictSixSecondBoundMet: true,
  };
  fs.writeFileSync(file, JSON.stringify(profile));
  assert.equal(reviewedProfile(file).sha256.length, 64);
  for (const changed of [
    { ...profile, noOffsetSubtraction: false },
    { ...profile, strictSixSecondBoundMet: false },
    { ...profile, results: profile.results.slice(1) },
    { ...profile, calibration: "inconclusive" },
  ]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => reviewedProfile(file));
  }
});
test("shared bounded launcher retains ready/exit logs without native processes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-native-capture-unit-"));
  const processes = createBoundedCaptureProcesses();
  const child = processes.launch(
    process.execPath,
    [
      "-e",
      "console.log('UNIT_READY'); process.stdin.once('data',()=>{console.log('UNIT_STOPPED');process.exit(0)});",
    ],
    "UNIT_READY",
    directory,
    3000,
  );
  try {
    await child.readiness;
    child.child.stdin.end("stop\n");
    await child.exit;
    assert.equal(processes.invalid, undefined);
    assert.match(
      fs.readFileSync(path.join(directory, path.basename(process.execPath) + ".log"), "utf8"),
      /UNIT_STOPPED/,
    );
  } finally {
    if (!child.ended()) child.child.kill();
    await Promise.allSettled([child.exit]);
  }
});
test("shared launcher fails closed on read-only isolation rejection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-native-capture-unit-"));
  const processes = createBoundedCaptureProcesses();
  const child = processes.launch(
    process.execPath,
    [
      "-e",
      "console.log('ISOLATION_REJECTED foreign session');setTimeout(()=>process.exit(1),100);",
    ],
    "ISOLATION_READY",
    directory,
    3000,
  );
  await assert.rejects(child.readiness);
  await assert.rejects(child.exit);
  assert.ok(processes.invalid);
  assert.equal(child.ended(), true);
});
