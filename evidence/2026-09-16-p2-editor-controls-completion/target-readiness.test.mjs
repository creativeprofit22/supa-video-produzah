import test from "node:test";
import assert from "node:assert/strict";
import { prepareTargetForCapture } from "./target-readiness.mjs";

function fixture() {
  const events = [];
  const window = { valid: true, handle: "123" };
  const owner = {
    identity: { pid: 42, creation: "1000" },
    async findWindow() {
      events.push("find");
      return window;
    },
  };
  const page = {
    async bringToFront() {
      events.push("front");
    },
  };
  const target = {
    async prepare() {
      events.push("prepare");
    },
  };
  const predicate = (titleMatches) => ({
    isWindow: true,
    pidMatches: true,
    visible: true,
    iconic: false,
    titleMatches,
    valid: titleMatches,
  });
  return { events, window, owner, page, target, predicate };
}

// These tests run the real bounded nativeReady polling loop with synthetic window queries.
// No browser, audio session, native helper, or capture is started.
test("delayed title readiness holds the helper-launch boundary until ready", async () => {
  const f = fixture();
  let calls = 0;
  let launched = false;
  await prepareTargetForCapture(f.target, f.page, f.owner, f.window, {
    check(handle, pid) {
      assert.equal(handle, "123");
      assert.equal(pid, 42);
      assert.equal(launched, false);
      f.events.push(++calls === 3 ? "ready" : "pending");
      return f.predicate(calls === 3);
    },
  });
  launched = true;
  f.events.push("launch");
  assert.equal(calls, 3);
  assert.equal(f.events[0], "prepare");
  assert.deepEqual(f.events.slice(-2), ["ready", "launch"]);
});

test("persistent title mismatch times out at the existing default deadline without launch", async () => {
  const f = fixture();
  let launched = false;
  let calls = 0;
  await assert.rejects(async () => {
    await prepareTargetForCapture(f.target, f.page, f.owner, f.window, {
      check() {
        calls++;
        assert.equal(launched, false);
        return f.predicate(false);
      },
    });
    launched = true;
  }, /Bounded native title readiness timeout/);
  assert.ok(calls > 1);
  assert.equal(launched, false);
});

test("changed HWND fails closed even if its title could match", async () => {
  const f = fixture();
  let calls = 0;
  f.owner.findWindow = async () => ({ valid: true, handle: ++calls === 1 ? "123" : "456" });
  await assert.rejects(
    prepareTargetForCapture(f.target, f.page, f.owner, f.window, {
      check() {
        return f.predicate(false);
      },
    }),
    /Target HWND identity changed/,
  );
  assert.equal(calls, 2);
});

test("changed owner creation time after navigation fails before any native predicate", async () => {
  const f = fixture();
  f.target.prepare = async () => {
    f.owner.identity.creation = "2000";
  };
  await assert.rejects(
    prepareTargetForCapture(f.target, f.page, f.owner, f.window, {
      check() {
        assert.fail("Changed owner must not reach native check");
      },
    }),
    /Target owner identity changed/,
  );
});

test("native PID mismatch remains a hard failure, not a title retry", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    prepareTargetForCapture(f.target, f.page, f.owner, f.window, {
      check() {
        calls++;
        return { ...f.predicate(true), pidMatches: false, valid: false };
      },
    }),
    /Native non-title predicate failed/,
  );
  assert.equal(calls, 1);
});
