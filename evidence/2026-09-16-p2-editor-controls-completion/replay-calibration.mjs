// Offline reanalysis only: original captures/results are never modified.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { playQpcBounds } from "./capture-protocol.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const analyzer = path.resolve(root, "../2026-09-14-p2-speed/output-capture/analyze-bounded.mjs");
for (const original of ["capture-cUIXeK", "capture-rsUpcY"]) {
  const output = fs.mkdtempSync(path.join(root, "capture-replay-"));
  const hashes = [];
  for (const condition of ["sync", "late", "early"]) {
    for (const relative of [
      "audio/clock.txt",
      "audio/packets.csv",
      "audio/loopback.wav",
      "visual/clock.txt",
      "visual/start-stop.txt",
      "visual/frames.csv",
      "play-qpc.json",
    ]) {
      const input = path.join(root, original, condition, relative);
      if (fs.statSync(input).size > 2e6) throw Error("Replay input bound");
      const bytes = fs.readFileSync(input);
      const destination = path.join(output, condition, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let contents = bytes;
      if (relative === "play-qpc.json") {
        const fields = JSON.parse(bytes);
        contents = JSON.stringify(
          original === "capture-cUIXeK"
            ? playQpcBounds(fields.before, fields.after)
            : playQpcBounds(fields.beforePlayQpcTicks, fields.afterPlayQpcTicks),
        );
      }
      fs.writeFileSync(destination, contents);
      hashes.push({
        input: path.relative(root, input),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        adaptedFieldNamesOnly: relative === "play-qpc.json",
      });
    }
  }
  fs.writeFileSync(
    path.join(output, "replay-provenance.json"),
    JSON.stringify({ original, recordingPerformed: false, hashes }, null, 2),
  );
  execFileSync(process.execPath, [analyzer, output], { maxBuffer: 2e6 });
  const result = JSON.parse(fs.readFileSync(path.join(output, "results.json"), "utf8"));
  const historical = JSON.parse(fs.readFileSync(path.join(root, original, "results.json"), "utf8"));
  assert.deepEqual(
    result.results.map((r) => r.audioMinusVisualMs),
    historical.results.map((r) => r.audioMinusVisualMs),
  );
  assert.equal(result.strictSixSecondBoundMet, true);
  assert.equal(
    result.calibration,
    original === "capture-rsUpcY" ? "candidate-pass-parent-review-required" : "inconclusive",
  );
  for (const entry of hashes) {
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, entry.input)))
        .digest("hex"),
      entry.sha256,
    );
  }
  console.log(
    JSON.stringify(
      {
        original,
        output,
        calibration: result.calibration,
        results: result.results.map(
          ({
            name,
            classification,
            audioMinusVisualMs,
            initialDiscontinuityAcceptedAsPreplayBoundary,
          }) => ({
            name,
            classification,
            audioMinusVisualMs,
            initialDiscontinuityAcceptedAsPreplayBoundary,
          }),
        ),
      },
      null,
      2,
    ),
  );
}
