import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pitch, tools } from "./step8-media.mjs";
import { validateTargetNames } from "./capture-targets.mjs";

// The historical extractor stays byte-for-byte unchanged. A new derived view
// substitutes the production observation for sync; shifted controls remain raw.
export function classify(observation, c, hz, controlsQualified) {
  const band = (1000 * c.rd) / c.rn,
    interval = observation.audioMinusVisualMs;
  const invalidFlags = observation.flags.some(
    (f) =>
      f.flags & 4 ||
      (f.flags & 1 &&
        !(observation.initialDiscontinuityAcceptedAsPreplayBoundary && f.packet === 0)),
  );
  const usable =
    controlsQualified &&
    observation.stopHandshakeAndStrictBoundsMet &&
    observation.audioStoppedBeforeWgcClose &&
    !observation.inconsistentTimestamps &&
    !invalidFlags &&
    observation.deviceGaps.length === 0 &&
    observation.sounds.length === 1 &&
    observation.visualOnsets.length === 1 &&
    interval?.length === 2 &&
    interval.every(Number.isFinite) &&
    interval[0] <= interval[1] &&
    Number.isFinite(hz);
  const pitchPass = Number.isFinite(hz) && Math.abs(hz - 1000) <= 10;
  return {
    classification: !usable
      ? "inconclusive"
      : interval[0] >= -band && interval[1] <= band && pitchPass
        ? "candidate-pass-parent-review-required"
        : !pitchPass || interval[1] < -band || interval[0] > band
          ? "fail"
          : "inconclusive",
    sequenceFrameMs: band,
    pitchHz: hz,
    pitchPass,
    pitchTolerancePercent: 1,
    noOffsetSubtraction: true,
    parentReviewRequired: true,
    observation,
  };
}
export function targetNames(c, scope = "all") {
  if (scope === "preview-only") return validateTargetNames(["preview"]);
  if (scope !== "all") throw Error("Unknown capture scope");
  return validateTargetNames(["preview", "final", ...(c.percent === 200 ? ["source"] : [])]);
}

export function analyze(run, c, scope = "all") {
  const names = targetNames(c, scope);
  const calibration = JSON.parse(fs.readFileSync(path.join(run, "results.json")));
  const { ffmpeg } = tools();
  const results = {};
  for (const name of names) {
    const derived = path.join(run, `analysis-${name}`);
    fs.mkdirSync(derived);
    for (const [from, to] of [
      [name, "sync"],
      ["late", "late"],
      ["early", "early"],
    ])
      fs.cpSync(path.join(run, from), path.join(derived, to), {
        recursive: true,
        errorOnExist: true,
      });
    execFileSync(
      process.execPath,
      ["evidence/2026-09-14-p2-speed/output-capture/analyze-bounded.mjs", derived],
      { timeout: 30000, maxBuffer: 2e6 },
    );
    const raw = JSON.parse(fs.readFileSync(path.join(derived, "results.json")));
    const pcm = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path.join(run, name, "audio/loopback.wav"),
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { timeout: 30000, maxBuffer: 2e6 },
    );
    const hz = pitch(Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4)));
    results[name] = classify(
      raw.results[0],
      c,
      hz,
      calibration.calibration === "candidate-pass-parent-review-required",
    );
  }
  const report = {
    case: c,
    calibration,
    results,
    scope: "Digital browser only; not physical output or native WebView",
    parentReviewRequired: true,
  };
  fs.writeFileSync(path.join(run, "step8-results.json"), JSON.stringify(report, null, 2));
  return report;
}
