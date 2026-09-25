import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { nativeTestRoot, testPort } from "../../apps/desktop/test-port.mjs";
import {
  isolatedConfig,
  title,
  committedProjection,
  keyboardBudget,
  keyboardCli,
  holdForHuman,
  runNativePlayback,
} from "./native-playback-check.mjs";
import { nativeCaptureArguments, classifyNativeTiming } from "./native-timing-adapter.mjs";
test("native settings evidence comes from the matching committed journal projection", () => {
  const projection = { projectId: "owned", revision: { number: 4 }, state: { sequences: [] } };
  const record = {
    kind: "commit",
    resultingRevision: { number: 4 },
    idempotencyResult: { projection },
  };
  const journal = JSON.stringify({ journalVersion: 1 }) + "\n" + JSON.stringify(record) + "\n";
  assert.deepEqual(committedProjection(journal, "owned", 4), projection);
  assert.throws(() => committedProjection(journal, "foreign", 4));
  assert.throws(() => committedProjection(journal, "owned", 3));
  assert.throws(() =>
    committedProjection(JSON.stringify({ revision: { number: 0 }, state: {} }), "owned", 4),
  );
});
test("human mode requires explicit CLI, forbids capture and preserves cleanup reserve", async () => {
  assert.equal(keyboardCli(["--run-native-keyboard-check-authorized"]), true);
  assert.equal(keyboardCli([]), false);
  assert.equal(keyboardCli(["--run-native-playback-authorized"]), false);
  assert.throws(() => keyboardCli(["--run-native-keyboard-check-authorized", "capture.json"]));
  await assert.rejects(
    runNativePlayback({ keyboardCheck: true, timingProfile: "anything" }),
    /cannot enable recording/,
  );
  assert.deepEqual(keyboardBudget(1000, 81000), {
    remainingMs: 40000,
    holdMs: 32000,
    sufficient: true,
  });
  assert.equal(keyboardBudget(0, 82000).sufficient, true);
  assert.equal(keyboardBudget(0, 82001).sufficient, false);
  assert.equal(keyboardBudget(0, 120001).holdMs, 0);
  for (const holdMs of [0, -1, Infinity, 112001]) assert.throws(() => holdForHuman({ holdMs }));
});
test("automated keyboard mode forbids capture and human-mode mixing before launch", async () => {
  await assert.rejects(
    runNativePlayback({ automatedKeyboardCheck: true, timingProfile: "anything" }),
    /cannot enable recording/,
  );
  await assert.rejects(
    runNativePlayback({ automatedKeyboardCheck: true, keyboardCheck: true }),
    /Human and automated modes are separate/,
  );
});
test("DONE completes only tool handoff, never human evidence, and releases stdin", async () => {
  const input = new PassThrough();
  let ready = false;
  const result = holdForHuman({
    input,
    holdMs: 500,
    ownedExit: new Promise(() => {}),
    ready: () => {
      ready = true;
    },
  });
  assert.equal(ready, true);
  input.write("not a result\nDO");
  input.write("NE\r\n");
  assert.deepEqual(await result, {
    toolStatus: "parent-finished",
    humanResult: "unverified",
    humanPass: null,
  });
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isPaused(), true);
});
test("human hold stops at deadline, EOF, owned exit or bounded input overflow", async () => {
  for (const expected of ["deadline", "stdin-closed", "owned-exited", "input-limit"]) {
    const input = new PassThrough();
    const result = holdForHuman({
      input,
      holdMs: 10,
      ownedExit: expected === "owned-exited" ? Promise.resolve({ code: 0 }) : new Promise(() => {}),
      ready: () => {},
    });
    if (expected === "stdin-closed") input.end();
    if (expected === "input-limit") input.write("x".repeat(257));
    assert.deepEqual(await result, {
      toolStatus: expected,
      humanResult: "unverified",
      humanPass: null,
    });
    assert.equal(input.listenerCount("data"), 0);
  }
});
const input = () => ({
  identity: { pid: 123, creation: "133000000000000000" },
  executable: path.resolve("native.exe"),
  window: {
    pid: 123,
    handle: "456",
    title,
    visible: true,
    iconic: false,
    width: 1280,
    height: 800,
  },
  roi: { x: 100, y: 200, side: 8, coordinateSpace: "WGC-window-physical-pixels" },
  directory: path.resolve("new-capture"),
  reader: {
    pid: 789,
    creation: "133000000000000001",
    executable: path.resolve("CompletionLoopback.exe"),
  },
});
test("isolated overlay changes no grants or CSP", () => {
  assert.deepEqual(Object.keys(isolatedConfig).sort(), ["app", "build", "identifier"]);
  assert.deepEqual(isolatedConfig.build, { devUrl: `http://localhost:${testPort}` });
  assert.equal(`${isolatedConfig.build.devUrl}/`, nativeTestRoot);
  assert.deepEqual(Object.keys(isolatedConfig.app), ["windows"]);
  assert.match(isolatedConfig.app.windows[0].title, /SUPA_LOOPBACK_PRIVATE_TEST/);
});
test("native adapter uses retained root identity, not Chromium executable", () => {
  const args = nativeCaptureArguments(input());
  assert.equal(args.guard[2], path.resolve("native.exe"));
  assert.deepEqual(args.visual.slice(0, 2), ["456", "123"]);
  assert.equal(args.audio[1], "3");
});
test("reject foreign HWND, untagged title and guessed/out-of-bounds ROI", () => {
  for (const change of [
    (v) => v.window.pid++,
    (v) => (v.window.title = "ordinary editor"),
    (v) => (v.roi.coordinateSpace = "screen"),
    (v) => (v.roi.x = 1280),
    (v) => (v.roi.side = 17),
    (v) => (v.window.iconic = true),
    (v) => (v.reader.creation = "unknown"),
  ]) {
    const value = input();
    change(value);
    assert.throws(() => nativeCaptureArguments(value));
  }
});
const observation = {
  flags: [],
  stopHandshakeAndStrictBoundsMet: true,
  audioStoppedBeforeWgcClose: true,
  inconsistentTimestamps: false,
  deviceGaps: [],
  sounds: [1],
  visualOnsets: [1],
  audioMinusVisualMs: [-5, 5],
};
const proof = {
  freshControlsParentReviewed: true,
  nativeIpc: true,
  exactOwnedRoiVerified: true,
  guardReadyAndStopped: true,
  foreignUnmutedSessions: 0,
  mutationCalls: 0,
  ownedCleanupEmpty: true,
};
test("all native safety/review gates required, never claims Step 9 done", () => {
  for (const key of Object.keys(proof)) {
    const missing = { ...proof };
    delete missing[key];
    assert.equal(classifyNativeTiming(observation, 1000, missing).classification, "inconclusive");
  }
  const result = classifyNativeTiming(observation, 1000, proof);
  assert.equal(result.classification, "candidate-pass-parent-review-required");
  assert.equal(result.step9Done, false);
});
test("unchanged one-frame interval and pitch gates retain shifted controls", () => {
  for (const interval of [
    [80, 120],
    [-120, -80],
  ])
    assert.equal(
      classifyNativeTiming({ ...observation, audioMinusVisualMs: interval }, 1000, proof)
        .classification,
      "fail",
    );
  assert.equal(
    classifyNativeTiming({ ...observation, audioMinusVisualMs: [-34, 5] }, 1000, proof)
      .classification,
    "inconclusive",
  );
  assert.equal(classifyNativeTiming(observation, 1020, proof).classification, "fail");
});
