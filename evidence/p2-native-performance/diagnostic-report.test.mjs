import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTrace } from "./diagnostic-report.mjs";

test("missing worker trace is an explicit startup outcome, not an exception or success", () => {
  const report = summarizeTrace(null);
  assert.equal(report.traceStatus, "missing");
  assert.equal(report.lastCompleted, null);
  assert.equal(report.workerFinished, false);
  assert.equal(report.pending[0].operation, "worker.startup.before-first-marker");
});
test("empty trace is distinguished from missing", () => {
  assert.equal(summarizeTrace("").traceStatus, "empty");
});
test("nested pending await retains exact last completed operation", () => {
  const events = [
    { event: "before", operation: "measurement" },
    { event: "before", operation: "warmup" },
    { event: "after", operation: "warmup" },
    { event: "before", operation: "snapshot" },
  ];
  const report = summarizeTrace(events.map(JSON.stringify).join("\n"));
  assert.equal(report.lastCompleted.operation, "warmup");
  assert.deepEqual(
    report.pending.map((e) => e.operation),
    ["measurement", "snapshot"],
  );
});
test("a killed partial write preserves prior completed markers", () => {
  const report = summarizeTrace('{"event":"after","operation":"ready"}\n{"event":');
  assert.equal(report.traceStatus, "incomplete");
  assert.equal(report.lastCompleted.operation, "ready");
  assert.equal(report.parseErrors.length, 1);
  assert.equal(report.workerFinished, false);
});
test("worker error followed by cleanup is not successful measurement", () => {
  const events = [
    { event: "error", operation: "measurement", error: "failed" },
    { event: "after", operation: "worker.finished" },
  ];
  const report = summarizeTrace(events.map(JSON.stringify).join("\n"));
  assert.equal(report.errors.length, 1);
  assert.equal(report.workerFinished, true);
  assert.equal(report.measurementCompleted, false);
});
test("complete sample and teardown are required separately", () => {
  const report = summarizeTrace(
    [
      { event: "after", operation: "measurement" },
      { event: "after", operation: "worker.finished" },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.equal(report.measurementCompleted, true);
  assert.equal(report.workerFinished, true);
  assert.deepEqual(report.pending, []);
});
