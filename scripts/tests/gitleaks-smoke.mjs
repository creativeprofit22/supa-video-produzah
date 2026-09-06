import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";

// Explicit binary path: use only the checksum-verified pinned scanner.
assert.equal(process.argv.length, 3, "Supply the verified Gitleaks binary path");
const binary = resolve(process.argv[2]);
const config = resolve("security/gitleaks.toml");
const root = mkdtempSync(join(tmpdir(), "supa-gitleaks-smoke-"));
const fixtures = ["caption-artifact-v1.json", "transcript-artifact-v1.json", "identity-v1.json"];
const ignore = join(root, "empty.ignore");
const report = join(root, "report.json");
const input = join(root, "input");
const put = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
function scan(command = "dir", source = ".", selectedConfig = config) {
  const result = spawnSync(
    binary,
    [
      command,
      source,
      "--redact=100",
      "--ignore-gitleaks-allow",
      "--config",
      selectedConfig,
      "--gitleaks-ignore-path",
      ignore,
      "--report-format=json",
      "--report-path",
      report,
    ],
    { cwd: input, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, "Scanner must execute");
  return result.status;
}
try {
  put(ignore, "");
  for (const fixture of fixtures) {
    const relative = `packages/video-media/fixtures/${fixture}`;
    put(join(input, relative), readFileSync(relative));
  }
  assert.equal(scan(), 0, "Only exact reviewed fixture identities pass");
  const fake = randomBytes(32).toString("hex");
  put(
    join(input, "packages/video-media/fixtures/identity-v1.json"),
    `api_key = "${fake}" # gitleaks:allow\n`,
  );
  assert.equal(
    scan(),
    1,
    "A different synthetic value in an allowed fixture still fails, despite inline suppression",
  );
  const findings = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(findings.length > 0, "Detection must have a finding");
  assert.ok(!readFileSync(report, "utf8").includes(fake), "Report must redact the synthetic value");
  rmSync(input, { recursive: true });
  mkdirSync(input);
  put(join(input, "outside.json"), readFileSync("packages/video-media/fixtures/identity-v1.json"));
  assert.equal(scan(), 1, "Exact identity outside its reviewed path is not ignored");
  assert.notEqual(scan("dir", ".", join(root, "missing.toml")), 0, "Missing config must fail");
  const missingHistory = spawnSync(
    process.execPath,
    [resolve("scripts/check-secrets.mjs"), binary, input, join(root, "scratch")],
    { encoding: "utf8" },
  );
  assert.equal(
    missingHistory.status,
    1,
    "Gate must reject missing history even when Gitleaks itself exits zero",
  );
  console.log(
    "Gitleaks smoke: exact exceptions, detections, inline suppression, redaction and errors verified",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
