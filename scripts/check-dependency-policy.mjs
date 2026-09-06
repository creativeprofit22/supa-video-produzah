import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { readFileSync, realpathSync, statSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath, URL } from "node:url";

export const TARGETS = Object.freeze(["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]);
const KINDS = ["unmaintained", "unsound", "notice", "yanked"];
const RATINGS = ["info", "low", "moderate", "high", "critical"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
function keys(value, expected, label, optional = []) {
  requireThat(object(value), `${label}: expected object`);
  requireThat(
    expected.every((k) => Object.hasOwn(value, k)) &&
      Object.keys(value).every((k) => [...expected, ...optional].includes(k)),
    `${label}: missing or unknown keys`,
  );
}
function scope(value) {
  return (
    Array.isArray(value) &&
    value.length === TARGETS.length &&
    TARGETS.every((t) => value.filter((v) => v === t).length === 1)
  );
}

// JSON.parse silently accepts duplicate keys. Walk its already-validated token stream
// separately so escaped spellings of the same key cannot bypass policy validation.
export function parseStrictJson(raw) {
  requireThat(text(raw), "empty JSON output");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("malformed JSON output");
  }
  const tokens = raw.match(
    /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
  );
  let i = 0;
  function walk() {
    const token = tokens[i++];
    if (token === "{") {
      const seen = new Set();
      while (tokens[i] !== "}") {
        const key = JSON.parse(tokens[i++]);
        requireThat(!seen.has(key), "duplicate JSON key");
        seen.add(key);
        i++; // colon
        walk();
        if (tokens[i] !== ",") break;
        i++;
      }
      i++;
    } else if (token === "[") {
      while (tokens[i] !== "]") {
        walk();
        if (tokens[i] !== ",") break;
        i++;
      }
      i++;
    }
  }
  walk();
  return parsed;
}

const identity = (v) => JSON.stringify([v.advisory, v.crate, v.version, v.kind]);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Read-only: a reviewer must deliberately record this value after renewing evidence.
// simplification: hash the entire repository inventory, not a dependency-aware slice;
// unrelated edits also reopen review. Narrow only with proven input coverage.
export function reviewFingerprint(root, targets, evidence) {
  requireThat(scope(targets), "review-required: missing or changed actual target scope");
  const base = realpathSync(root);
  const inventory = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: base,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  requireThat(
    inventory.status === 0 && inventory.stderr === "",
    "review-required: input inventory unavailable",
  );
  const paths = [...new Set(inventory.stdout.split("\0").filter(Boolean))]
    .filter((p) => p !== "security/dependency-exceptions.json")
    .sort();
  requireThat(
    paths.includes("apps/desktop/src-tauri/Cargo.lock") &&
      paths.includes("apps/desktop/src-tauri/Cargo.toml") &&
      paths.includes(".github/workflows/ci.yml") &&
      paths.includes(evidence),
    "review-required: required reviewed inputs missing",
  );
  const files = paths.map((p) => {
    const path = resolve(base, p);
    const local = relative(base, realpathSync(path));
    requireThat(
      local !== ".." &&
        !local.startsWith("../") &&
        !local.startsWith("..\\") &&
        !isAbsolute(local) &&
        lstatSync(path).isFile(),
      "review-required: invalid reviewed input",
    );
    const bytes = readFileSync(path);
    const decoded = bytes.toString("utf8");
    // Existing Windows checkouts can predate the repository's LF attributes.
    const content =
      !bytes.includes(0) && Buffer.from(decoded, "utf8").equals(bytes)
        ? decoded.replace(/\r\n/g, "\n")
        : bytes;
    return [p, sha256(content)];
  });
  return sha256(JSON.stringify({ version: 1, targets: [...targets].sort(), evidence, files }));
}

export function validateExceptions(value, now = new Date()) {
  keys(value, ["version", "targets", "exceptions"], "exceptions document");
  requireThat(
    value.version === 1 && scope(value.targets) && Array.isArray(value.exceptions),
    "invalid exception version or complete inventory scope",
  );
  requireThat(Number.isFinite(now.getTime()), "invalid policy clock");
  const seen = new Set();
  for (const e of value.exceptions) {
    keys(
      e,
      [
        "advisory",
        "crate",
        "version",
        "kind",
        "targets",
        "rationale",
        "evidence",
        "owner",
        "expires",
        "disposition",
      ],
      "exception",
      ["reviewContext"],
    );
    requireThat(
      /^RUSTSEC-\d{4}-\d{4}$/.test(e.advisory) &&
        text(e.crate) &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(e.version),
      "invalid exception identity",
    );
    requireThat(
      KINDS.includes(e.kind) && scope(e.targets),
      "invalid exception kind or target scope",
    );
    requireThat(
      text(e.rationale) &&
        e.owner === "dependency/security maintainer" &&
        typeof e.evidence === "string" &&
        /^evidence\/(?:[A-Za-z0-9_-]+\/)+rust-dispositions\.md$/.test(e.evidence),
      "invalid exception rationale, evidence or owner",
    );
    requireThat(
      ["maintenance-only", "target-inapplicable", "evidenced-unreachable"].includes(
        e.disposition,
      ) &&
        (e.disposition !== "maintenance-only" || e.kind === "unmaintained"),
      "invalid exception disposition (maintenance-only requires unmaintained)",
    );
    if (e.disposition !== "maintenance-only") {
      keys(e.reviewContext, ["version", "targets", "sha256"], "review-required: review context");
      requireThat(
        e.reviewContext.version === 1 &&
          scope(e.reviewContext.targets) &&
          typeof e.reviewContext.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(e.reviewContext.sha256),
        "review-required: invalid reviewed fingerprint or targets",
      );
    } else
      requireThat(
        !Object.hasOwn(e, "reviewContext"),
        "maintenance-only must not use reachability context",
      );
    const expiry = new Date(`${e.expires}T00:00:00.000Z`);
    requireThat(
      typeof e.expires === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(e.expires) &&
        Number.isFinite(expiry.getTime()) &&
        expiry.toISOString().slice(0, 10) === e.expires &&
        expiry > now,
      "expired or invalid exception expiry",
    );
    requireThat(!seen.has(identity(e)), "duplicate exception identity");
    seen.add(identity(e));
  }
  return value.exceptions;
}

function rustFinding(v, kind) {
  requireThat(
    object(v) && object(v.package) && text(v.package.name) && text(v.package.version),
    "malformed Rust finding package",
  );
  if (kind !== "yanked") {
    requireThat(
      object(v.advisory) &&
        /^RUSTSEC-\d{4}-\d{4}$/.test(v.advisory.id) &&
        v.advisory.package === v.package.name &&
        (kind === "vulnerability"
          ? v.advisory.informational === null
          : v.advisory.informational === kind),
      "malformed Rust advisory",
    );
  }
  requireThat(kind === "vulnerability" || v.kind === kind, "Rust warning kind mismatch");
  return {
    advisory: v.advisory?.id ?? "yanked",
    crate: v.package.name,
    version: v.package.version,
    kind,
    approved: false,
  };
}

function checkRust(raw, exceptionsRaw, result, guard, now, root, targets) {
  let report;
  guard(() => {
    report = parseStrictJson(raw);
    keys(
      report,
      ["database", "lockfile", "settings", "vulnerabilities", "warnings"],
      "cargo-audit report",
    );
  });
  if (!object(report)) return;
  guard(() => {
    keys(report.database, ["advisory-count", "last-commit", "last-updated"], "database");
    requireThat(
      count(report.database["advisory-count"]) &&
        report.database["advisory-count"] > 0 &&
        text(report.database["last-commit"]) &&
        Number.isFinite(Date.parse(report.database["last-updated"])),
      "invalid advisory database",
    );
    keys(report.lockfile, ["dependency-count"], "lockfile");
    requireThat(
      count(report.lockfile["dependency-count"]) && report.lockfile["dependency-count"] > 0,
      "empty or invalid lockfile",
    );
    keys(
      report.settings,
      ["target_arch", "target_os", "severity", "ignore", "informational_warnings"],
      "settings",
    );
    const s = report.settings;
    requireThat(
      ["target_arch", "target_os", "ignore"].every(
        (k) => Array.isArray(s[k]) && s[k].length === 0,
      ) &&
        s.severity === null &&
        Array.isArray(s.informational_warnings) &&
        s.informational_warnings.length === 3 &&
        ["unmaintained", "unsound", "notice"].every((k) => s.informational_warnings.includes(k)),
      "scanner must be unfiltered with all informational warnings",
    );
  });
  guard(() => {
    keys(report.vulnerabilities, ["found", "count", "list"], "vulnerabilities");
    const v = report.vulnerabilities;
    requireThat(Array.isArray(v.list), "invalid vulnerability list");
    for (const entry of v.list)
      guard(() => result.findings.push(rustFinding(entry, "vulnerability")));
    requireThat(
      count(v.count) && v.count === v.list.length && v.found === v.count > 0,
      "inconsistent vulnerability count",
    );
  });
  guard(() => {
    requireThat(object(report.warnings), "invalid warnings");
    for (const [kind, entries] of Object.entries(report.warnings))
      guard(() => {
        requireThat(KINDS.includes(kind), "unknown warning category");
        requireThat(Array.isArray(entries), "invalid warning list");
        for (const entry of entries) guard(() => result.findings.push(rustFinding(entry, kind)));
      });
  });
  guard(() => {
    const exceptions = validateExceptions(parseStrictJson(exceptionsRaw), now);
    for (const e of exceptions) {
      const matches = result.findings.filter(
        (f) => f.kind !== "vulnerability" && identity(f) === identity(e),
      );
      if (!matches.length) result.errors.push(`stale exception: ${identity(e)}`);
      guard(() => {
        if (e.disposition !== "maintenance-only") {
          let fingerprint;
          try {
            fingerprint = reviewFingerprint(root, targets, e.evidence);
          } catch {
            throw new Error(`review-required: context missing or invalid for ${identity(e)}`);
          }
          requireThat(
            fingerprint === e.reviewContext.sha256,
            `review-required: reviewed inputs changed for ${identity(e)}`,
          );
        }
        for (const f of matches) f.approved = true;
      });
    }
  });
}

function checkJavascript(raw, result, guard) {
  let report;
  guard(() => {
    report = parseStrictJson(raw);
    keys(report, ["actions", "advisories", "muted", "metadata"], "pnpm audit report");
  });
  if (!object(report)) return;
  guard(() => {
    requireThat(
      Array.isArray(report.actions) &&
        report.actions.length === 0 &&
        Array.isArray(report.muted) &&
        report.muted.length === 0,
      "unexpected actions or suppressed advisories",
    );
  });
  const actual = Object.fromEntries(RATINGS.map((r) => [r, 0]));
  guard(() => {
    requireThat(object(report.advisories), "invalid advisories");
    for (const [id, a] of Object.entries(report.advisories))
      guard(() => {
        requireThat(
          object(a) &&
            count(a.id) &&
            String(a.id) === id &&
            text(a.module_name) &&
            RATINGS.includes(a.severity) &&
            text(a.title),
          "invalid advisory",
        );
        requireThat(
          Array.isArray(a.findings) &&
            a.findings.length > 0 &&
            a.findings.every(
              (f) =>
                object(f) &&
                text(f.version) &&
                Array.isArray(f.paths) &&
                f.paths.length > 0 &&
                f.paths.every(text),
            ),
          "invalid advisory findings",
        );
        actual[a.severity]++;
        result.findings.push({
          advisory: id,
          package: a.module_name,
          severity: a.severity,
          title: a.title,
          findings: a.findings,
          approved: !["high", "critical"].includes(a.severity),
        });
      });
  });
  guard(() => {
    keys(
      report.metadata,
      [
        "vulnerabilities",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "totalDependencies",
      ],
      "metadata",
    );
    requireThat(
      ["dependencies", "devDependencies", "optionalDependencies", "totalDependencies"].every((k) =>
        count(report.metadata[k]),
      ) && report.metadata.totalDependencies > 0,
      "invalid dependency counts",
    );
    keys(report.metadata.vulnerabilities, RATINGS, "severity counts");
    requireThat(
      RATINGS.every(
        (r) =>
          count(report.metadata.vulnerabilities[r]) &&
          report.metadata.vulnerabilities[r] === actual[r],
      ),
      "advisory severity counts disagree with actual advisories",
    );
  });
}

// Status is the scanner status, never the status of a pipe/tee. Findings remain in
// the report even when stderr, metadata, exceptions or scanner execution fail.
export function evaluate({
  mode,
  raw,
  status,
  stderr,
  exceptions,
  now = new Date(),
  root = repositoryRoot,
  targets,
}) {
  const result = { mode, scannerExitStatus: null, findings: [], errors: [], ok: false };
  const guard = (fn) => {
    try {
      fn();
    } catch (error) {
      result.errors.push(error.message);
    }
  };
  guard(() => {
    requireThat(
      typeof status === "string" && /^(0|[1-9]\d*)(?:\r?\n)?$/.test(status),
      "invalid scanner exit status file",
    );
    result.scannerExitStatus = Number(status.trim());
    requireThat(
      Number.isSafeInteger(result.scannerExitStatus) && result.scannerExitStatus <= 255,
      "invalid scanner exit status",
    );
  });
  if (typeof stderr !== "string") result.errors.push("scanner stderr unavailable");
  else if (stderr.length !== 0)
    result.errors.push(`scanner stderr is nonempty (${Buffer.byteLength(stderr, "utf8")} bytes)`);
  if (mode === "rust") checkRust(raw, exceptions, result, guard, now, root, targets);
  else if (mode === "javascript") checkJavascript(raw, result, guard);
  else result.errors.push("unknown mode");
  const expectedStatus = result.findings.length > 0 ? 1 : 0;
  if (result.scannerExitStatus !== expectedStatus)
    result.errors.push(
      `scanner exit status ${result.scannerExitStatus} inconsistent with findings (expected ${expectedStatus})`,
    );
  result.ok = result.errors.length === 0 && result.findings.every((f) => f.approved);
  return result;
}

export function main(args) {
  const [mode, rawPath, statusPath, stderrPath, exceptionsPath, targetScope] = args;
  if (!((mode === "rust" && args.length === 6) || (mode === "javascript" && args.length === 4))) {
    console.error(
      "Usage: node scripts/check-dependency-policy.mjs rust <raw-json> <exit-status-file> <stderr-file> <exceptions-json> <comma-separated-targets>\n       node scripts/check-dependency-policy.mjs javascript <raw-json> <exit-status-file> <stderr-file>",
    );
    return 1;
  }
  const errors = [];
  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      errors.push("unable to read required input file");
      return undefined;
    }
  };
  const result = evaluate({
    mode,
    raw: read(rawPath),
    status: read(statusPath),
    stderr: read(stderrPath),
    exceptions: mode === "rust" ? read(exceptionsPath) : undefined,
    targets: targetScope?.split(","),
  });
  if (mode === "rust") {
    if (!scope(targetScope?.split(",")))
      errors.push("review-required: invalid actual target scope");
    try {
      const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
      for (const e of validateExceptions(parseStrictJson(readFileSync(exceptionsPath, "utf8")))) {
        const evidence = realpathSync(resolve(root, e.evidence));
        const local = relative(root, evidence);
        requireThat(
          local !== ".." &&
            !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
            !isAbsolute(local) &&
            statSync(evidence).isFile(),
          "invalid evidence file",
        );
      }
    } catch {
      errors.push("exception evidence or policy unavailable or invalid");
    }
  }
  result.errors.push(...errors);
  result.ok = result.ok && errors.length === 0;
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
