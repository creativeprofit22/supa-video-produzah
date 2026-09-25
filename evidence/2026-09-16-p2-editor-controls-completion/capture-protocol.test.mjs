import test from "node:test";
import assert from "node:assert/strict";
import { playQpcBounds } from "./capture-protocol.mjs";
test("play acknowledgement matches the existing analyzer fields without altering clock values", () => {
  assert.deepEqual(playQpcBounds("654676056027", "654676626536"), {
    before: "654676056027",
    after: "654676626536",
  });
});
test("play acknowledgement rejects missing, malformed and reversed timestamps", () => {
  for (const [before, after] of [
    ["", "1"],
    ["1.2", "3"],
    ["2", "1"],
    ["1", "NaN"],
  ])
    assert.throws(() => playQpcBounds(before, after));
});
