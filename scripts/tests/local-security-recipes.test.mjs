import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { TARGETS } from "../check-dependency-policy.mjs";

const readme = readFileSync(new URL("../../security/README.md", import.meta.url), "utf8");
const blocks = [...readme.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
const recipe = (text) => {
  const block = blocks.find((b) => b.includes(text));
  assert.ok(block, `Missing recipe: ${text}`);
  return block;
};
function run(t, block, setup = "", files = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "local-security-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const dir of ["scripts", "security", ".cache/p1-security/bin"]) {
    mkdirSync(join(cwd, dir), { recursive: true });
  }
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd, path), content);
  const result = spawnSync("bash", ["--noprofile", "--norc"], {
    cwd,
    input: `${setup}\n${block}`,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, cwd };
}

test("documented checksum mismatch prevents extraction and execution", (t) => {
  const result = run(
    t,
    recipe("curl --fail"),
    `
    cargo() { echo cargo; }
    curl() { printf 'harmless non-archive' > .cache/p1-security/gitleaks.tar.gz; }
    tar() { echo EXTRACTION; }
    gitleaks() { echo EXECUTION; }
    node() { echo TESTS; }
  `,
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /EXTRACTION|EXECUTION|TESTS/);
  assert.match(result.stderr, /checksum.*NOT match/i);
});

const js = {
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
};
const rust = {
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
};
for (const [jsStatus, rustStatus, expected] of [
  [1, 0, 1],
  [0, 1, 1],
  [0, 0, 0],
  [2, 0, 1],
  [0, 2, 1],
]) {
  test(`documented dependency recipe: scanner exits ${jsStatus}/${rustStatus}`, (t) => {
    const result = run(
      t,
      recipe("pnpm audit --json"),
      `
      pnpm() { cat javascript-fixture.json; return ${jsStatus}; }
      cargo() { cat rust-fixture.json; return ${rustStatus}; }
    `,
      {
        "scripts/check-dependency-policy.mjs": readFileSync(
          new URL("../check-dependency-policy.mjs", import.meta.url),
          "utf8",
        ),
        "security/dependency-exceptions.json": JSON.stringify({
          version: 1,
          targets: TARGETS,
          exceptions: [],
        }),
        "javascript-fixture.json": JSON.stringify(js),
        "rust-fixture.json": JSON.stringify(rust),
      },
    );
    assert.equal(result.status, expected, result.stdout + result.stderr);
    for (const [mode, status] of [
      ["javascript", jsStatus],
      ["rust", rustStatus],
    ]) {
      assert.equal(
        readFileSync(join(result.cwd, `.cache/p1-security/${mode}.exit`), "utf8").trim(),
        String(status),
      );
      assert.match(result.stdout, new RegExp(`"mode": "${mode}"`));
    }
  });
}
for (const [smoke, history, expected] of [
  [1, 0, 1],
  [0, 1, 1],
  [0, 0, 0],
  [2, 0, 1],
]) {
  test(`documented secret recipe: exits ${smoke}/${history}`, (t) => {
    const result = run(
      t,
      recipe("node scripts/tests/gitleaks-smoke.mjs"),
      `
      node() {
        case "$1" in
          scripts/tests/gitleaks-smoke.mjs) echo SMOKE; return ${smoke};;
          scripts/check-secrets.mjs) echo HISTORY; return ${history};;
          *) return 99;;
        esac
      }
    `,
    );
    assert.equal(result.status, expected);
    assert.match(result.stdout, /SMOKE/);
    assert.match(result.stdout, /HISTORY/);
  });
}
