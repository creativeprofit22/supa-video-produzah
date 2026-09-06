import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  evaluate,
  parseStrictJson,
  reviewFingerprint,
  TARGETS,
} from "../check-dependency-policy.mjs";

const now = new Date("2026-09-06T12:00:00Z");
const rust = () => ({
  database: { "advisory-count": 1, "last-commit": "abc", "last-updated": "2026-09-06T00:00:00Z" },
  lockfile: { "dependency-count": 1 },
  settings: {
    target_arch: [],
    target_os: [],
    severity: null,
    ignore: [],
    informational_warnings: ["unmaintained", "unsound", "notice"],
  },
  vulnerabilities: { found: false, count: 0, list: [] },
  warnings: {},
});
const warning = (kind = "unmaintained") => ({
  kind,
  package: { name: "example", version: "1.2.3" },
  advisory: { id: "RUSTSEC-2026-0001", package: "example", informational: kind },
});
const exception = () => ({
  advisory: "RUSTSEC-2026-0001",
  crate: "example",
  version: "1.2.3",
  kind: "unmaintained",
  targets: [...TARGETS],
  rationale: "Reviewed maintenance status",
  evidence: "evidence/review/rust-dispositions.md",
  owner: "dependency/security maintainer",
  expires: "2026-10-06",
  disposition: "maintenance-only",
});
const policy = (exceptions = []) => ({ version: 1, targets: [...TARGETS], exceptions });
const js = () => ({
  actions: [],
  advisories: {},
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    dependencies: 1,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 1,
  },
});
function run(mode, report, status = "0", exceptions = policy(), stderr = "") {
  return evaluate({
    mode,
    raw: JSON.stringify(report),
    status,
    stderr,
    exceptions: JSON.stringify(exceptions),
    now,
  });
}
function warned() {
  const r = rust();
  r.warnings.unmaintained = [warning()];
  return r;
}
function rated(severity) {
  const r = js();
  r.advisories["123"] = {
    id: 123,
    module_name: "example",
    title: "Example advisory",
    severity,
    findings: [{ version: "1.0.0", paths: [".>dev>example"] }],
  };
  r.metadata.vulnerabilities[severity] = 1;
  return r;
}

test("benign Rust and JavaScript pass", () => {
  assert.equal(run("rust", rust()).ok, true);
  assert.equal(run("javascript", js()).ok, true);
});
test("approved warning stays visible; unreviewed warning fails", () => {
  const approved = run("rust", warned(), "1", policy([exception()]));
  assert.equal(approved.ok, true);
  assert.equal(approved.findings.length, 1);
  assert.equal(approved.scannerExitStatus, 1);
  assert.equal(run("rust", warned(), "1").ok, false);
});
test("vulnerabilities always fail and cannot use warning exceptions", () => {
  const r = rust();
  const v = warning();
  v.advisory.informational = null;
  r.vulnerabilities = { found: true, count: 1, list: [v] };
  const result = run("rust", r, "1", policy([exception()]));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].kind, "vulnerability");
  assert.match(result.errors.join(), /stale/);
});
for (const [field, value] of Object.entries({
  advisory: "RUSTSEC-2026-0002",
  crate: "other",
  version: "1.2.4",
  kind: "notice",
  targets: [TARGETS[0]],
  rationale: "",
  evidence: "../review.md",
  owner: "",
  expires: "2026-09-06",
  disposition: "ignore",
  extra: true,
})) {
  test(`exception mismatch or malformed ${field} fails closed`, () => {
    const e = { ...exception(), [field]: value };
    assert.equal(run("rust", warned(), "1", policy([e])).ok, false);
  });
}
test("expired, invalid calendar, duplicate and stale exceptions fail", () => {
  for (const expires of ["2020-01-01", "2027-02-30", "tomorrow"]) {
    assert.equal(run("rust", warned(), "1", policy([{ ...exception(), expires }])).ok, false);
  }
  assert.equal(run("rust", warned(), "1", policy([exception(), exception()])).ok, false);
  assert.equal(run("rust", rust(), "0", policy([exception()])).ok, false);
  assert.equal(
    run("rust", warned(), "1", { ...policy([exception()]), targets: [TARGETS[1]] }).ok,
    false,
  );
});
test("unsound cannot be maintenance-only; evidenced dispositions are scoped", () => {
  const r = rust();
  r.warnings.unsound = [warning("unsound")];
  const e = { ...exception(), kind: "unsound" };
  assert.equal(run("rust", r, "1", policy([e])).ok, false);
  e.disposition = "evidenced-unreachable";
  const result = run("rust", r, "1", policy([e]));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /review-required/);
});
test("notice and yanked are visible and fail without review; unknown warnings fail", () => {
  for (const kind of ["notice", "yanked", "new-category"]) {
    const r = rust();
    r.warnings[kind] = [warning(kind)];
    assert.equal(run("rust", r, "1").ok, false);
  }
  const r = rust();
  r.warnings.unknown = [];
  assert.equal(run("rust", r).ok, false);
});
test("filtered scanners and inconsistent Rust counts fail", () => {
  for (const mutate of [
    (r) => r.settings.ignore.push("RUSTSEC-2026-0001"),
    (r) => r.settings.target_os.push("windows"),
    (r) => r.settings.informational_warnings.pop(),
    (r) => {
      r.vulnerabilities.count = 1;
    },
    (r) => {
      r.database = {};
    },
  ]) {
    const r = rust();
    mutate(r);
    assert.equal(run("rust", r).ok, false);
  }
});
test("strict JSON rejects duplicate keys including escaped keys", () => {
  for (const raw of ['{"version":1,"version":1}', '{"x":{"a":1,"\\u0061":2}}'])
    assert.throws(() => parseStrictJson(raw), /duplicate/);
  assert.deepEqual(parseStrictJson('{"a":[{},[],"x"]}'), { a: [{}, [], "x"] });
});
for (const mode of ["rust", "javascript"]) {
  test(`${mode}: malformed, empty and unknown tool shapes fail`, () => {
    for (const raw of ["", " ", "{", "null", "[]", "{}", '{"error":"network failure"}']) {
      assert.equal(
        evaluate({ mode, raw, status: "0", stderr: "", exceptions: JSON.stringify(policy()), now })
          .ok,
        false,
      );
    }
    const report = mode === "rust" ? rust() : js();
    report.error = "registry unavailable";
    assert.equal(run(mode, report).ok, false);
  });
  test(`${mode}: invalid exit statuses and any stderr fail even at exit zero`, () => {
    const report = mode === "rust" ? rust() : js();
    for (const status of ["", " ", "-1", "01", "1.0", "256", "2", "1", "0\n1"])
      assert.equal(run(mode, report, status).ok, false);
    for (const stderr of ["registry unavailable", " "])
      assert.equal(run(mode, report, "0", policy(), stderr).ok, false);
  });
}
test("stderr and malformed JSON secrets are not echoed", () => {
  for (const raw of ['{"secret":"PRIVATE_MARKER"', "{}"]) {
    const result = evaluate({ mode: "javascript", raw, status: "0", stderr: "PRIVATE_MARKER" });
    assert.equal(JSON.stringify(result).includes("PRIVATE_MARKER"), false);
    assert.equal(result.ok, false);
  }
});
test("findings AND operational failures are reported", () => {
  const result = run("rust", warned(), "2", policy(), "registry failed");
  assert.equal(result.findings.length, 1);
  assert.equal(result.errors.length, 2);
  assert.equal(run("rust", warned(), "0", policy([exception()])).ok, false);
});
for (const severity of ["info", "low", "moderate", "high", "critical"]) {
  test(`JavaScript ${severity}: all dependency paths visible with correct gate`, () => {
    const result = run("javascript", rated(severity), "1");
    assert.equal(result.ok, !["high", "critical"].includes(severity));
    assert.equal(result.findings[0].severity, severity);
    assert.equal(run("javascript", rated(severity), "0").ok, false);
  });
}
test("JavaScript counts, ratings, missing findings and suppressions fail", () => {
  for (const mutate of [
    (r) => {
      r.metadata.vulnerabilities.high = 2;
    },
    (r) => {
      r.metadata.vulnerabilities.low = 1;
    },
    (r) => {
      r.advisories["123"].severity = "unknown";
    },
    (r) => {
      r.advisories["123"].findings = [];
    },
    (r) => r.muted.push(123),
    (r) => {
      r.metadata.vulnerabilities.high = "1";
    },
  ]) {
    const r = rated("high");
    mutate(r);
    assert.equal(run("javascript", r, "1").ok, false);
  }
});
for (const disposition of ["target-inapplicable", "evidenced-unreachable"]) {
  test(`${disposition}: reviewed files, evidence and actual targets bind approval`, () => {
    const root = mkdtempSync(join(tmpdir(), "review-context-"));
    const put = (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const lock = "apps/desktop/src-tauri/Cargo.lock";
    const manifest = "apps/desktop/src-tauri/Cargo.toml";
    const source = "apps/desktop/src-tauri/src/lib.rs";
    const workflow = ".github/workflows/ci.yml";
    const generator = "apps/desktop/src-tauri/build.rs";
    const generated = "apps/desktop/src-tauri/src/generated.rs";
    const e = { ...exception(), kind: "unsound", disposition };
    const entries = [e];
    const report = rust();
    report.warnings.unsound = [warning("unsound")];
    const check = (targets = TARGETS) =>
      evaluate({
        mode: "rust",
        raw: JSON.stringify(report),
        status: "1",
        stderr: "",
        exceptions: JSON.stringify(policy(entries)),
        now,
        root,
        targets,
      });
    const refresh = () => {
      e.reviewContext = {
        version: 1,
        targets: [...TARGETS],
        sha256: reviewFingerprint(root, TARGETS, e.evidence),
      };
    };
    try {
      assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
      for (const path of [lock, manifest, source, workflow, generator, generated, e.evidence])
        put(path, "benign reviewed input\n");
      assert.match(check().errors.join(), /review-required/);
      refresh();
      assert.equal(check().ok, true);
      assert.equal(check().findings[0].approved, true);
      put(source, "benign reviewed input\r\n");
      assert.equal(check().ok, true, "Windows line endings are portable");
      for (const path of [lock, manifest, source, workflow, generator, generated, e.evidence]) {
        put(path, "benign changed input\n");
        const result = check();
        assert.equal(result.ok, false, path);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].approved, false);
        assert.match(result.errors.join(), /review-required/);
        // Only an explicit new review restores approval, never a scan.
        assert.equal(check().ok, false);
        refresh();
        assert.equal(check().ok, true);
      }
      put("apps/desktop/src-tauri/src/new-consumer.rs", "// new benign consumer\n");
      assert.equal(check().ok, false);
      refresh();
      assert.equal(check().ok, true);
      for (const targets of [undefined, [TARGETS[0]], [...TARGETS, "aarch64-pc-windows-msvc"]]) {
        const result =
          targets === undefined
            ? evaluate({
                mode: "rust",
                raw: JSON.stringify(report),
                status: "1",
                stderr: "",
                exceptions: JSON.stringify(policy([e])),
                now,
                root,
              })
            : check(targets);
        assert.equal(result.ok, false);
        assert.match(result.errors.join(), /review-required/);
      }
      e.reviewContext.targets = [TARGETS[0]];
      assert.equal(check().ok, false);
      refresh();
      rmSync(join(root, e.evidence));
      assert.equal(check().ok, false);
      assert.throws(refresh, /review-required/);
      put(e.evidence, "review renewed\n");
      refresh();
      assert.equal(check().ok, true);
      rmSync(join(root, source));
      assert.equal(check().ok, false);
      entries.push(exception());
      report.warnings.unmaintained = [warning()];
      const result = check();
      assert.equal(result.ok, false);
      assert.equal(result.findings.find((f) => f.kind === "unmaintained").approved, true);
      assert.equal(result.findings.find((f) => f.kind === "unsound").approved, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("recorded cargo-audit format retains all 17 findings", () => {
  const load = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
  const r = load("evidence/2026-09-06-p1-dependency-triage/rust-audit.json");
  const result = run("rust", r, "1");
  assert.equal(result.errors.length, 0);
  assert.equal(result.findings.length, 17);
});
test("CLI exits and machine-readable reports; missing inputs and usage fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "dependency-policy-"));
  const cli = fileURLToPath(new URL("../check-dependency-policy.mjs", import.meta.url));
  const invoke = (...args) =>
    spawnSync(
      process.execPath,
      [cli, ...args, ...(args[0] === "rust" && args.length === 5 ? [TARGETS.join(",")] : [])],
      { encoding: "utf8" },
    );
  try {
    const raw = join(dir, "raw.json"),
      status = join(dir, "status"),
      stderr = join(dir, "stderr"),
      exceptions = join(dir, "exceptions.json");
    writeFileSync(raw, JSON.stringify(js()));
    writeFileSync(status, "0\n");
    writeFileSync(stderr, "");
    writeFileSync(exceptions, JSON.stringify(policy()));
    let result = invoke("javascript", raw, status, stderr);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).scannerExitStatus, 0);
    writeFileSync(raw, JSON.stringify(rust()));
    assert.equal(invoke("rust", raw, status, stderr, exceptions).status, 0);
    writeFileSync(stderr, "registry failed");
    result = invoke("rust", raw, status, stderr, exceptions);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).errors.join(), /stderr is nonempty/);
    assert.equal(result.stdout.includes("registry failed"), false);
    writeFileSync(stderr, "");
    writeFileSync(raw, JSON.stringify(warned()));
    writeFileSync(status, "1");
    writeFileSync(exceptions, JSON.stringify(policy([{ ...exception(), expires: "2099-10-06" }])));
    assert.equal(invoke("rust", raw, status, stderr, exceptions).status, 1);
    assert.equal(invoke("javascript", join(dir, "missing"), status, stderr).status, 1);
    assert.equal(invoke("rust").status, 1);
    assert.equal(invoke("other", raw, status, stderr).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
