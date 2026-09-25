import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  calibrationReaderLifetimeMs,
  createBoundedCaptureProcesses,
} from "./capture-calibration.mjs";

// Synthetic stdin/stdout protocol only: no browser, native reader, or audio device.
test("reader lifetime covers setup, three-second recording, and ordered normal shutdown", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-reader-lifecycle-"));
  const processes = createBoundedCaptureProcesses();
  const reader = processes.launch(
    process.execPath,
    [
      "-e",
      `const readline = require('node:readline');
       const input = readline.createInterface({input: process.stdin});
       let stopped = false;
       console.log('READER_WAITING');
       input.on('line', line => {
         if (line === 'BEGIN_AUTHORIZED_CAPTURE') {
           console.log('LOOPBACK_READY');
           setTimeout(() => {
             stopped = true;
             console.log('AUDIO_STOP_ACK');
             console.log('READER_CAPTURE_STOPPED');
           }, 3000);
         } else if (line === 'EXIT_OWNED_READER') {
           process.exit(stopped ? 0 : 2);
         }
       });`,
    ],
    "READER_WAITING",
    directory,
    calibrationReaderLifetimeMs,
  );
  try {
    await reader.readiness;
    // Isolation and visual setup consume lifetime before authorization, as in the late failure.
    await delay(1500);
    reader.child.stdin.write("BEGIN_AUTHORIZED_CAPTURE\n");
    await reader.waitFor("LOOPBACK_READY");
    await reader.waitFor("READER_CAPTURE_STOPPED", 4000);
    assert.match(reader.text(), /AUDIO_STOP_ACK\s+READER_CAPTURE_STOPPED/);
    // Reader identity must survive until the visual/guard shutdown has completed.
    await delay(200);
    assert.equal(reader.ended(), false);
    reader.child.stdin.end("EXIT_OWNED_READER\n");
    await reader.exit;
    assert.equal(processes.invalid, undefined);
    assert.match(
      fs.readFileSync(path.join(directory, path.basename(process.execPath) + ".log"), "utf8"),
      /READER_CAPTURE_STOPPED/,
    );
  } finally {
    if (!reader.ended()) reader.child.kill();
    await reader.exit.catch(() => {});
  }
});

test("owned process watchdog still rejects a stalled synthetic reader", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supa-reader-stall-"));
  const processes = createBoundedCaptureProcesses();
  const reader = processes.launch(
    process.execPath,
    ["-e", "console.log('READER_WAITING'); process.stdin.resume();"],
    "READER_WAITING",
    directory,
    2500,
  );
  try {
    await reader.readiness;
    await assert.rejects(reader.exit, /Owned process failed/);
    assert.match(processes.invalid.message, /Owned capture watchdog/);
    assert.equal(reader.ended(), true);
    assert.doesNotMatch(reader.text(), /READER_CAPTURE_STOPPED/);
  } finally {
    if (!reader.ended()) reader.child.kill();
    await reader.exit.catch(() => {});
  }
});
