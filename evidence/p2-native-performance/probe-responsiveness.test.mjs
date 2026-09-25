import test from "node:test";
import assert from "node:assert/strict";
import { boundedProbe, probeResponsiveness } from "./probe-responsiveness.mjs";
import { browserSession } from "./browser-session.mjs";

test("unknown media-control options fail before opening files or launching a browser", async () => {
  await assert.rejects(
    browserSession("", {}, "", undefined, { mediaLoadControl: "skip-validation" }),
    /Invalid diagnostic media-load control/,
  );
});
test("idle control never clicks play and retains independent channel failure", async () => {
  let detached = false;
  const recorded = [];
  const connection = {
    send: async () => ({ product: "test" }),
    detach: async () => {
      detached = true;
    },
  };
  const page = {
    context: () => ({ browser: () => ({ newBrowserCDPSession: async () => connection }) }),
    locator: () => assert.fail("idle controls must not request playback"),
    evaluate: async () => {
      throw new Error("page unavailable");
    },
  };
  const result = await probeResponsiveness(
    page,
    (_name, operation) => operation(),
    (sample) => recorded.push(sample),
    { idle: true },
  );
  assert.equal(result.idle, true);
  assert.equal(result.allResponsive, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].control.ok, true);
  assert.equal(recorded[0].renderer.ok, false);
  assert.equal(detached, true);
});
test("responsive probe preserves its real return value", async () => {
  const result = await boundedProbe(() => ({ value: 7 }), 100);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { value: 7 });
});
test("probe rejection is unavailable rather than a fabricated measurement", async () => {
  const result = await boundedProbe(() => {
    throw new Error("closed");
  }, 100);
  assert.equal(result.ok, false);
  assert.match(result.error, /closed/);
  assert.equal(result.value, undefined);
});
test("unresponsive probe returns at its own deadline", async () => {
  const result = await boundedProbe(() => new Promise(() => {}), 20);
  assert.equal(result.ok, false);
  assert.match(result.error, /deadline/);
  assert.equal(result.value, undefined);
});
