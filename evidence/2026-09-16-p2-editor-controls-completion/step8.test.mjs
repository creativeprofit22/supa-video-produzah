import test from "node:test";
import assert from "node:assert/strict";
import { cases, pitch } from "./step8-media.mjs";
import { classify } from "./step8-analysis.mjs";
import { captureCalibration } from "./capture-calibration.mjs";

test("capture rejects implicit authorization and unbounded targets before starting resources", async () => {
  await assert.rejects(
    captureCalibration({ mode: "--not-authorized" }),
    /explicit read-only preflight/,
  );
  await assert.rejects(
    captureCalibration({ mode: "--record-authorized", targets: [{ name: "other" }] }),
    /bounded preview\/final pair/,
  );
});
const clean = () => ({
  audioMinusVisualMs: [-10, 10],
  flags: [],
  stopHandshakeAndStrictBoundsMet: true,
  audioStoppedBeforeWgcClose: true,
  inconsistentTimestamps: false,
  deviceGaps: [],
  sounds: [{}],
  visualOnsets: [{}],
});
const decision = (o, c = cases[0], hz = 1000, controls = true) =>
  classify(o, c, hz, controls).classification;
test("fixed eight cases and unchanged one-output-frame gate", () => {
  assert.equal(cases.length, 8);
  for (const c of cases) {
    const band = (1000 * c.rd) / c.rn;
    assert.equal(
      decision({ ...clean(), audioMinusVisualMs: [-band, band] }, c),
      "candidate-pass-parent-review-required",
    );
    // An interval crossing the limit is not acceptance, but also not proof of product skew.
    assert.equal(
      decision({ ...clean(), audioMinusVisualMs: [-band - 0.001, band] }, c),
      "inconclusive",
    );
    assert.equal(decision({ ...clean(), audioMinusVisualMs: [-band - 2, -band - 1] }, c), "fail");
    for (const delta of [-100, 100])
      assert.equal(decision({ ...clean(), audioMinusVisualMs: [delta - 1, delta + 1] }, c), "fail");
  }
});
test("no event dropping or contaminated/uncertain capture pass", () => {
  for (const patch of [
    { sounds: [] },
    { sounds: [{}, {}] },
    { visualOnsets: [{}, {}] },
    { audioMinusVisualMs: null },
    { audioMinusVisualMs: [NaN, 0] },
    { deviceGaps: [{}] },
    { flags: [{ packet: 0, flags: 4 }] },
    { flags: [{ packet: 1, flags: 1 }], initialDiscontinuityAcceptedAsPreplayBoundary: true },
    { inconsistentTimestamps: true },
    { stopHandshakeAndStrictBoundsMet: false },
    { audioStoppedBeforeWgcClose: false },
  ])
    assert.equal(decision({ ...clean(), ...patch }), "inconclusive");
  assert.equal(decision(clean(), cases[0], 1000, false), "inconclusive");
  assert.equal(decision(clean(), cases[0], NaN), "inconclusive");
});
test("1% pitch gate and pitch-shifting controls", () => {
  for (const hz of [500, 990, 1000, 1010, 1500, 2000]) {
    const samples = Array.from({ length: 14400 }, (_, i) =>
      i >= 2400 && i < 12000 ? 0.25 * Math.sin((2 * Math.PI * hz * i) / 48000) : 0,
    );
    assert.ok(Math.abs(pitch(samples) - hz) < 0.1);
    assert.equal(
      decision(clean(), cases[0], hz),
      hz >= 990 && hz <= 1010 ? "candidate-pass-parent-review-required" : "fail",
    );
  }
});
