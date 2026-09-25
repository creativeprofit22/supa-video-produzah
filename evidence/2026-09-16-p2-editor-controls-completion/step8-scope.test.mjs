import test from "node:test";
import assert from "node:assert/strict";
import { targetNames, analyze } from "./step8-analysis.mjs";
import { captureCalibration } from "./capture-calibration.mjs";
import fs from "node:fs";
import process from "node:process";
import { execFileSync } from "node:child_process";

test("Preview-only capture and analysis exclude Final and source audition", () => {
  assert.deepEqual(targetNames({ percent: 50 }, "preview-only"), ["preview"]);
  assert.deepEqual(targetNames({ percent: 200 }, "preview-only"), ["preview"]);
});

test("default scope preserves existing targets and unknown scopes fail closed", () => {
  assert.deepEqual(targetNames({ percent: 50 }), ["preview", "final"]);
  assert.deepEqual(targetNames({ percent: 200 }), ["preview", "final", "source"]);
  assert.throws(() => targetNames({ percent: 50 }, "typo"), /Unknown capture scope/);
});

test("real capture entry accepts selected scopes before creating evidence or preparing targets", async (t) => {
  t.mock.method(fs, "mkdtempSync", () => {
    throw Error("Must not create capture evidence");
  });
  for (const percent of [50, 200]) {
    for (const scope of ["preview-only", "all"]) {
      const names = targetNames({ percent }, scope);
      const result = await captureCalibration({
        mode: "--validate-only",
        targets: names.map((name) => ({
          name,
          prepare() {
            throw Error("Must not launch playback");
          },
        })),
      });
      assert.deepEqual(result, { validated: true, targets: names });
      if (scope === "preview-only") assert.deepEqual(result.targets, ["preview"]);
    }
  }
  assert.deepEqual(await captureCalibration({ mode: "--validate-only" }), {
    validated: true,
    targets: [],
  });
});

test("real capture entry rejects unsupported target combinations before any launch", async (t) => {
  t.mock.method(fs, "mkdtempSync", () => {
    throw Error("Must not create capture evidence");
  });
  for (const names of [
    ["final"],
    ["source"],
    ["preview", "source"],
    ["final", "preview"],
    ["preview", "preview"],
    ["preview", "final", "other"],
    ["preview", "final", "source", "source"],
  ]) {
    await assert.rejects(
      captureCalibration({ mode: "--record-authorized", targets: names.map((name) => ({ name })) }),
      /Unsupported capture targets/,
    );
  }
  assert.throws(
    () => analyze("must-not-be-read", { percent: 50 }, "typo"),
    /Unknown capture scope/,
  );
});

test("CLI validation traverses selection and shared validator without media/profile reads", () => {
  const script = "evidence/2026-09-16-p2-editor-controls-completion/capture-step8.mjs";
  const args = [
    script,
    "--validate-only",
    "0",
    "nonexistent-profile-no-io.json",
    "slow-onset",
    "preview-only",
  ];
  const result = JSON.parse(
    execFileSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }),
  );
  assert.equal(result.validated, true);
  assert.deepEqual(result.targets, ["preview"]);
  assert.equal(result.case.percent, 50);
  assert.equal(result.case.rn, 30);
  assert.equal(result.case.rd, 1);
  assert.throws(
    () =>
      execFileSync(process.execPath, [...args.slice(0, -1), "typo"], {
        stdio: "pipe",
        timeout: 10000,
      }),
    /Command failed/,
  );
});
