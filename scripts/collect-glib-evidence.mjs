import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST = "apps/desktop/src-tauri/Cargo.toml";
export const TARGET = "apps/desktop/src-tauri/target";
export const STAGE = ".cache/p1-security/hosted-glib";
export const TRIPLE = "x86_64-unknown-linux-gnu";
export const TEST_ARGV = [
  "test",
  "--locked",
  "--all-features",
  "--manifest-path",
  MANIFEST,
  "--message-format=json-render-diagnostics",
];
const fail = (message) => {
  throw new Error(message);
};
const slash = (path) => path.split(sep).join("/");
const json = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

// Check each component, not only realpath: an in-tree symlink is also forbidden.
export function contained(root, path, kind = "file") {
  root = resolve(root);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail(`Path escape: ${path}`);
  let current = root;
  for (const part of ["", ...rel.split(sep)]) {
    current = part ? join(current, part) : current;
    if (lstatSync(current).isSymbolicLink()) fail(`Symlink forbidden: ${current}`);
  }
  const info = lstatSync(absolute);
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) fail(`Nonregular ${kind}: ${path}`);
  if (realpathSync(absolute) !== absolute) fail(`Noncanonical path: ${path}`);
  return absolute;
}

export function makeContainedDirectory(root, path) {
  const rel = relative(resolve(root), resolve(root, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail(`Path escape: ${path}`);
  let current = resolve(root);
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    contained(root, current, "directory");
  }
  return current;
}

export function hashFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function walk(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        contained(root, path, "directory");
        visit(path);
      } else {
        contained(root, path);
        files.push(path);
      }
    }
  }
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail(`Invalid directory: ${root}`);
  visit(root);
  return files;
}

export function parseCargo(text, packageId, features) {
  const artifacts = [],
    scripts = [];
  let finished = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("{")) continue;
    const message = JSON.parse(line);
    if (finished) fail("Unexpected JSON after build-finished");
    if (message.reason === "build-finished") {
      if (message.success !== true) fail("Cargo build failed");
      finished = true;
    } else if (message.reason === "build-script-executed") {
      if (
        typeof message.package_id !== "string" ||
        !message.package_id ||
        typeof message.out_dir !== "string" ||
        !isAbsolute(message.out_dir)
      )
        fail("Malformed build-script message");
      scripts.push(message);
    } else if (message.reason === "compiler-artifact") {
      if (
        typeof message.package_id !== "string" ||
        !message.target ||
        !message.profile ||
        !Array.isArray(message.features) ||
        typeof message.fresh !== "boolean"
      )
        fail("Malformed artifact message");
      if (
        message.package_id === packageId &&
        message.target.name === "supa_video_desktop_lib" &&
        message.profile.test === true &&
        message.executable !== null
      )
        artifacts.push(message);
    } else if (message.reason !== "compiler-message") fail("Unknown Cargo message");
  }
  if (!finished) fail("Missing successful build-finished");
  if (artifacts.length !== 1)
    fail(`Expected exactly one library test ELF; found ${artifacts.length}`);
  const selected = artifacts[0];
  if (
    typeof selected.executable !== "string" ||
    !isAbsolute(selected.executable) ||
    !selected.filenames?.includes(selected.executable) ||
    selected.profile.opt_level !== "0" ||
    selected.profile.debuginfo !== 2 ||
    selected.profile.debug_assertions !== true ||
    !selected.target.kind?.some((kind) => ["lib", "rlib", "staticlib", "cdylib"].includes(kind))
  )
    fail("Invalid debug library test artifact");
  if (JSON.stringify([...selected.features].sort()) !== JSON.stringify([...features].sort()))
    fail("All-feature selection mismatch");
  if (!scripts.length) fail("Missing build-script messages");
  return { selected, scripts, buildFinished: true };
}

export function sourceInventory(root, scripts) {
  const build = contained(root, `${TARGET}/debug/build`, "directory");
  const reported = new Map();
  for (const script of scripts) {
    const out = contained(build, script.out_dir, "directory");
    if (reported.has(out)) fail(`Duplicate reported out_dir: ${out}`);
    reported.set(out, script.package_id);
  }
  const sources = new Map();
  for (const [out, packageId] of reported) {
    for (const path of walk(out).filter((path) => path.endsWith(".rs")))
      sources.set(path, {
        origin: "reported-build-script",
        packageId,
        outDir: slash(relative(root, out)),
      });
  }
  // Independent enumeration includes same-job Clippy outputs reused or unreported by tests.
  for (const path of walk(build).filter((path) => path.endsWith(".rs"))) {
    if (!sources.has(path))
      sources.set(path, { origin: "same-job-debug-build-extra", packageId: null, outDir: null });
  }
  if (!sources.size) fail("Empty generated Rust source inventory");
  return [...sources]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([path, origin]) => ({
      path: slash(relative(root, path)),
      ...origin,
      size: statSync(path).size,
      sha256: hashFile(path),
    }));
}

export function verifyManifest(root, entries) {
  const actual = walk(root)
    .map((path) => slash(relative(root, path)))
    .filter((path) => path !== "manifest.json")
    .sort();
  const expected = entries.map((entry) => entry.path).sort();
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    fail("Manifest missing, duplicate or additional entries");
  for (const entry of entries) {
    const path = contained(root, entry.path);
    if (statSync(path).size !== entry.size || hashFile(path) !== entry.sha256)
      fail(`Manifest hash mismatch: ${entry.path}`);
  }
}

export function validateExits(text) {
  if (!/^0 0\r?\n?$/.test(text)) fail("Cargo or tee did not succeed");
  return { cargo: 0, tee: 0 };
}

export function validateToolchain(rustc) {
  if (
    !/^release: 1\.98\.1$/m.test(rustc) ||
    !/^commit-hash: 48a229cea[0-9a-f]*$/m.test(rustc) ||
    !new RegExp(`^host: ${TRIPLE}$`, "m").test(rustc)
  )
    fail("Unexpected Rust compiler release, commit or host");
}

export function validateEnvironment(env) {
  const allowed = [
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "CARGO_INCREMENTAL",
    "CARGO_TERM_COLOR",
    "CARGO_NET_OFFLINE",
    "CARGO_BUILD_JOBS",
  ];
  const configuration = {};
  for (const key of Object.keys(env)) {
    if (
      /^(RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTDOC|CARGO_ENCODED_|CARGO_BUILD_|CARGO_TARGET_|CARGO_PROFILE_)/.test(
        key,
      ) &&
      !allowed.includes(key)
    )
      fail(`Unsupported build override: ${key}`);
  }
  for (const key of allowed) if (env[key] !== undefined) configuration[key] = env[key];
  if (env.RUSTUP_TOOLCHAIN && !new RegExp(`^1\\.98\\.1(-${TRIPLE})?$`).test(env.RUSTUP_TOOLCHAIN))
    fail("Unexpected RUSTUP_TOOLCHAIN");
  return configuration;
}

export function validateSymbols(text) {
  if (!text.trim()) fail("Empty symbol report");
  if (!/^[0-9a-f]+\s+[a-zA-Z]\s+\S/m.test(text)) fail("Unusable symbol report");
}

export function validateElf(reports) {
  if (
    !/ELF 64-bit LSB.*x86-64/.test(reports.file) ||
    !/not stripped/.test(reports.file) ||
    !/Class:\s+ELF64/.test(reports.header) ||
    !/Machine:\s+Advanced Micro Devices X86-64/.test(reports.header) ||
    !/\s\.symtab\s/.test(reports.sections) ||
    !/\s\.debug_info\s/.test(reports.sections) ||
    !/GNU\s+0x[0-9a-f]+\s+NT_GNU_BUILD_ID/i.test(reports.notes) ||
    !/Build ID:\s+[0-9a-f]+/i.test(reports.notes)
  )
    fail("ELF missing expected architecture, symbols, debug information or build ID");
  return reports.notes.match(/Build ID:\s+([0-9a-f]+)/i)[1];
}

export function command(root, program, argv, output) {
  const fd = output ? openSync(output, "wx") : null;
  let result;
  try {
    result = spawnSync(program, argv, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", fd ?? "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120000,
    });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (result.error || result.signal || result.status !== 0)
    fail(`${program} failed (${result.status ?? result.error?.code ?? result.signal})`);
  return { program, argv, status: result.status, stdout: result.stdout ?? null };
}
const git = (root, args) => command(root, "git", args).stdout;
const names = (text) => text.split("\0").filter(Boolean).sort();
export function snapshot(root) {
  const tracked = names(git(root, ["ls-files", "-z"])).map((path) => ({
    path,
    sha256: hashFile(contained(root, path)),
  }));
  return {
    checkout: git(root, ["rev-parse", "HEAD"]).trim(),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    tracked,
    untracked: names(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  };
}
export function rejectConfig(
  root,
  cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo"),
) {
  const dirs = new Set([resolve(cargoHome)]);
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    dirs.add(join(dir, ".cargo"));
    if (dirname(dir) === dir) break;
  }
  dirs.add(join(root, "apps", ".cargo"));
  dirs.add(join(root, "apps/desktop/.cargo"));
  dirs.add(join(root, dirname(MANIFEST), ".cargo"));
  for (const dir of dirs)
    for (const name of ["config", "config.toml"])
      if (existsSync(join(dir, name))) fail(`Unsupported Cargo config: ${join(dir, name)}`);
}
export function context(env) {
  const keys = [
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_EVENT_NAME",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
    "GITHUB_SERVER_URL",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "ImageOS",
    "ImageVersion",
  ];
  const result = {};
  for (const key of keys) {
    if (!env[key]) fail(`Missing provenance: ${key}`);
    result[key] = env[key];
  }
  if (env.GITHUB_JOB !== "rust" || env.RUNNER_OS !== "Linux" || env.RUNNER_ARCH !== "X64")
    fail("Unexpected hosted job");
  result.runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    result.pullRequest = event.pull_request
      ? {
          number: event.number,
          headSha: event.pull_request.head.sha,
          baseSha: event.pull_request.base.sha,
          mergeCommitSha: event.pull_request.merge_commit_sha,
        }
      : null;
  }
  return result;
}

export function prepare(root = process.cwd()) {
  if (process.platform !== "linux") fail("prepare requires the authorized hosted Linux job");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) fail("Node >=22.12 is required");
  const hosted = context(process.env);
  rejectConfig(root);
  const configuration = validateEnvironment(process.env);
  const target = join(root, TARGET);
  if (existsSync(target) && walk(target).length)
    fail("Prior target build payload found after cache restore");
  const stage = join(root, STAGE);
  if (existsSync(stage)) fail("Capture scratch already exists; refusing reuse");
  const reports = {};
  for (const tool of ["file", "readelf", "nm", "tar", "sha256sum"])
    reports[tool] = command(root, tool, ["--version"]);
  reports.node = { version: process.version };
  reports.rustc = command(root, "rustc", ["-vV"]);
  reports.cargo = command(root, "cargo", ["-vV"]);
  reports.toolchain = command(root, "rustup", ["show", "active-toolchain"]);
  validateToolchain(reports.rustc.stdout);
  if (!reports.toolchain.stdout.startsWith(`1.98.1-${TRIPLE} `))
    fail("Unexpected active toolchain");
  const before = snapshot(root);
  if (before.status || before.untracked.length) fail("Hosted checkout must start clean");
  makeContainedDirectory(root, STAGE);
  json(join(stage, "prepare.json"), {
    hosted,
    configuration,
    reports,
    before,
    targetInitiallyEmpty: true,
    testArgv: TEST_ARGV,
  });
}

export function collect(root = process.cwd()) {
  if (process.platform !== "linux") fail("collect requires the authorized hosted Linux job");
  const stage = contained(root, STAGE, "directory");
  const prepared = JSON.parse(readFileSync(contained(stage, "prepare.json"), "utf8"));
  const exits = validateExits(readFileSync(contained(stage, "test-exits.txt"), "utf8"));
  rejectConfig(root);
  if (
    JSON.stringify(validateEnvironment(process.env)) !== JSON.stringify(prepared.configuration) ||
    JSON.stringify(context(process.env)) !== JSON.stringify(prepared.hosted)
  )
    fail("Capture context changed");
  const rustc = command(root, "rustc", ["-vV"]);
  validateToolchain(rustc.stdout);
  if (rustc.stdout !== prepared.reports.rustc.stdout) fail("Compiler changed during job");
  for (const [key, program, argv] of [
    ["cargo", "cargo", ["-vV"]],
    ["toolchain", "rustup", ["show", "active-toolchain"]],
  ]) {
    if (command(root, program, argv).stdout !== prepared.reports[key].stdout)
      fail(`${program} changed during job`);
  }
  const payload = join(stage, "payload");
  mkdirSync(payload);
  const commands = [];
  const run = (program, argv, output) => {
    const receipt = command(root, program, argv, output && join(payload, output));
    commands.push(receipt);
    return receipt.stdout;
  };
  run(
    "cargo",
    [
      "metadata",
      "--locked",
      "--all-features",
      "--format-version",
      "1",
      "--filter-platform",
      TRIPLE,
      "--manifest-path",
      MANIFEST,
    ],
    "cargo-metadata.json",
  );
  const metadata = JSON.parse(readFileSync(join(payload, "cargo-metadata.json"), "utf8"));
  if (resolve(metadata.target_directory) !== resolve(root, TARGET))
    fail("Unexpected Cargo target directory");
  const pkg = metadata.packages.find(
    (pkg) => resolve(pkg.manifest_path) === resolve(root, MANIFEST),
  );
  if (!pkg || pkg.name !== "supa-video-desktop") fail("Missing desktop package identity");
  const log = contained(stage, "cargo-test.stdout.log");
  const parsed = parseCargo(readFileSync(log, "utf8"), pkg.id, Object.keys(pkg.features));
  for (const script of parsed.scripts)
    if (!metadata.packages.some((pkg) => pkg.id === script.package_id))
      fail("Unknown build-script package identity");
  const executable = contained(join(root, TARGET, "debug"), parsed.selected.executable);
  if (!(statSync(executable).mode & 0o111)) fail("Selected ELF is not executable");
  const sources = sourceInventory(root, parsed.scripts);
  const after = snapshot(root);
  if (
    after.checkout !== prepared.before.checkout ||
    after.tree !== prepared.before.tree ||
    JSON.stringify(after.tracked) !== JSON.stringify(prepared.before.tracked) ||
    git(root, ["status", "--porcelain=v1", "--untracked-files=no"])
  )
    fail("Tracked build inputs changed");
  const outsideRust = names(git(root, ["ls-files", "--others", "-z", "--", "*.rs"])).filter(
    (path) => !path.startsWith(`${TARGET}/`) && !/^(node_modules|\.git|\.gg|\.cache)\//.test(path),
  );
  const repositoryGenerated = outsideRust.map((path) => ({
    path,
    origin: "repository-untracked-rust-outside-target",
    size: statSync(contained(root, path)).size,
    sha256: hashFile(contained(root, path)),
  }));
  const copies = [];
  function copy(source, destination, expectedHash = hashFile(source)) {
    const sourceHash = hashFile(source);
    if (sourceHash !== expectedHash) fail(`Inventory changed before copy: ${destination}`);
    const dest = join(payload, destination);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest, constants.COPYFILE_EXCL);
    if (hashFile(dest) !== sourceHash || hashFile(source) !== sourceHash)
      fail(`Copy changed: ${destination}`);
    copies.push({ source, destination, sha256: sourceHash });
  }
  copy(executable, "elf/supa_video_desktop_lib.test.elf");
  copy(log, "cargo-test.stdout.log");
  copy(contained(stage, "test-exits.txt"), "test-exits.txt");
  copy(contained(stage, "prepare.json"), "prepare.json");
  for (const source of [...sources, ...repositoryGenerated])
    copy(contained(root, source.path), `sources/${source.path}`, source.sha256);
  const elf = join(payload, "elf/supa_video_desktop_lib.test.elf");
  const reports = {
    file: run("file", ["--", elf]),
    header: run("readelf", ["-h", "--", elf]),
    sections: run("readelf", ["-SW", "--", elf]),
    notes: run("readelf", ["-n", "--", elf]),
  };
  const buildId = validateElf(reports);
  json(join(payload, "elf-reports.json"), reports);
  run("nm", ["-C", "--", elf], "nm-demangled.txt");
  const nmPath = join(payload, "nm-demangled.txt");
  validateSymbols(readFileSync(nmPath, "utf8"));
  const pattern = /array_iter_str|VariantStrIter/g;
  const hits = [];
  for (const path of [...sources, ...repositoryGenerated]
    .map((item) => `sources/${item.path}`)
    .concat("nm-demangled.txt")) {
    readFileSync(join(payload, path), "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        const terms = [...line.matchAll(pattern)].map((match) => match[0]);
        if (terms.length) hits.push({ file: path, line: index + 1, terms });
      });
  }
  json(join(payload, "producer-type-search.json"), {
    pattern: pattern.source,
    status: 0,
    hits,
    scope:
      "Captured Rust files and full nm -C output; symbol absence is corroboration only, not proof against inlining.",
  });
  json(join(payload, "generated-sources.json"), {
    sources,
    repositoryGenerated,
    scripts: parsed.scripts.map(({ package_id, out_dir }) => ({
      packageId: package_id,
      outDir: out_dir,
    })),
    limitations:
      "Same-job generation, not necessarily same-step: Clippy can populate outputs reused by tests. Extra debug sources are labeled. Historical count 14 is not a completeness invariant; reconcile differences. Unmaterialized proc-macro expansions are not captured.",
  });
  const inputPaths = prepared.before.tracked.filter(
    ({ path }) =>
      /(^|\/)(Cargo\.toml|Cargo\.lock|build\.rs)$/.test(path) ||
      path === ".github/workflows/ci.yml",
  );
  json(join(payload, "provenance.json"), {
    ...prepared,
    after,
    inputHashes: inputPaths,
    kind: "all-feature debug library test ELF; not a production/release executable",
    targetMode: "host-native (no --target)",
    targetTriple: TRIPLE,
    exits,
    buildFinished: parsed.buildFinished,
    selected: parsed.selected,
    buildId,
    commands,
    completeness:
      "Collection requires successful all-feature tests. Release-budget/job status must be checked independently against hosted metadata. Upload is not an unreachability disposition or signed reproducible-build attestation.",
  });
  for (const item of copies)
    if (
      hashFile(item.source) !== item.sha256 ||
      hashFile(join(payload, item.destination)) !== item.sha256
    )
      fail(`Copied bytes changed: ${item.destination}`);
  const entries = walk(payload)
    .map((path) => ({
      path: slash(relative(payload, path)),
      size: statSync(path).size,
      sha256: hashFile(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  json(join(payload, "manifest.json"), { version: 1, entries });
  verifyManifest(payload, entries);
  const tar = join(stage, "hosted-glib.tar");
  command(root, "tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=gnu",
    "-cf",
    tar,
    "-C",
    payload,
    ".",
  ]);
  verifyManifest(payload, entries);
  const digest = command(stage, "sha256sum", ["hosted-glib.tar"]).stdout;
  if (digest.split(/\s+/)[0] !== hashFile(tar)) fail("Tar checksum mismatch");
  writeFileSync(join(stage, "hosted-glib.tar.sha256"), digest, { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !["prepare", "collect"].includes(process.argv[2]))
      fail("Usage: node scripts/collect-glib-evidence.mjs prepare|collect");
    (process.argv[2] === "prepare" ? prepare : collect)();
  } catch (error) {
    console.error(`GLib capture failed: ${error.message}`);
    process.exitCode = 1;
  }
}
