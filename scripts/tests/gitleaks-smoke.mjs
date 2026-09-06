import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";

// Explicit binary path: use only the checksum-verified pinned scanner.
assert.equal(process.argv.length, 3, "Supply the verified Gitleaks binary path");
const binary = resolve(process.argv[2]);
// Inherited Git overrides must never redirect fixture operations into the user's repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
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
  // Plumbing builds isolated merge-resolution history without checkout, hooks or user config edits.
  for (const detect of [false, true]) {
    const history = join(root, detect ? "merge-detection" : "merge-clean");
    mkdirSync(history);
    function git(args, stdin = "") {
      const result = spawnSync("git", ["-C", history, ...args], {
        input: stdin,
        encoding: "utf8",
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: ignore,
          GIT_AUTHOR_NAME: "Synthetic fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Synthetic fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
      assert.equal(result.error, undefined, "Fixture Git must execute");
      assert.equal(result.status, 0, "Fixture Git operation must succeed");
      return result.stdout.trim();
    }
    git(["init", "--bare"]);
    function commit(content, parents = []) {
      const blob = git(["hash-object", "-w", "--stdin"], content);
      const tree = git(["mktree"], `100644 blob ${blob}\tresolution.txt\n`);
      return git(
        ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
        "Fixture\n",
      );
    }
    const base = commit("base\n");
    const left = commit("left\n", [base]);
    const right = commit("right\n", [base]);
    const synthetic = randomBytes(32).toString("hex");
    const merge = commit(detect ? `api_key = "${synthetic}"\n` : "resolved\n", [left, right]);
    const tip = commit("removed\n", [merge]);
    git(["update-ref", "refs/heads/main", tip]);
    assert.equal(git(["rev-list", "--all", "--count"]), "5");
    assert.equal(git(["rev-list", "--all", "--merges"]), merge);
    for (const revision of [base, left, right, tip]) {
      assert.ok(!git(["show", `${revision}:resolution.txt`]).includes(synthetic));
    }
    const scratch = join(root, detect ? "detection-scratch" : "clean-scratch");
    const gate = spawnSync(
      process.execPath,
      [resolve("scripts/check-secrets.mjs"), binary, history, scratch],
      { encoding: "utf8", env },
    );
    assert.equal(gate.error, undefined, "Production gate must execute");
    assert.equal(
      gate.status,
      detect ? 1 : 0,
      "Gate must detect merge-only history and accept clean merges",
    );
    const runs = readdirSync(scratch);
    assert.equal(runs.length, 1);
    const run = join(scratch, runs[0]);
    const raw = readFileSync(join(run, "report.json"), "utf8");
    const mergeFindings = JSON.parse(raw);
    assert.ok(!raw.includes(synthetic), "Merge report must redact the synthetic value");
    for (const output of [
      gate.stdout,
      gate.stderr,
      ...["scanner.stdout", "scanner.stderr"].map((file) => readFileSync(join(run, file), "utf8")),
    ]) {
      assert.ok(!output.includes(synthetic), "Gate output must not expose the synthetic value");
    }
    if (detect) {
      assert.ok(mergeFindings.length > 0, "Merge detection must produce findings");
      assert.ok(
        mergeFindings.every(
          (finding) =>
            finding.Commit === merge &&
            finding.File === "resolution.txt" &&
            finding.Secret === "REDACTED",
        ),
        "Findings must identify only the merge resolution and be redacted",
      );
    } else {
      assert.deepEqual(mergeFindings, [], "Clean merge history must have no findings");
    }
  }
  console.log(
    "Gitleaks smoke: exact exceptions, detections, inline suppression, redaction, errors and merge history verified",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
