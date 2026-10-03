// Third-party license inventory for the desktop app (npm production graph of
// @supa-video/desktop + Rust normal/build graphs of the Tauri crate and the
// bundled beat detector sidecar for x86_64-pc-windows-msvc, plus notices for
// the downloadable music-beat runtime from its pinned manifest). Writes a deterministic THIRD_PARTY_LICENSES.md that
// is bundled as a Tauri resource next to the FFmpeg notices.
//
//   node scripts/license-inventory.mjs           regenerate the file
//   node scripts/license-inventory.mjs --check   fail if missing, stale or a
//                                                license is unknown/denied
//
// Fails closed: malformed tool output, a package without a license, or a
// license expression that cannot be satisfied by the allowlist is an error.
import process from "node:process";
import console from "node:console";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = resolve(ROOT, "apps/desktop/src-tauri/licenses/THIRD_PARTY_LICENSES.md");
const MANIFEST = resolve(ROOT, "apps/desktop/src-tauri/Cargo.toml");
/** The bundled music beat detector sidecar (ADR 0004); its own Cargo workspace. */
const BEAT_DETECTOR_MANIFEST = resolve(ROOT, "apps/desktop/src-tauri/beat-detector/Cargo.toml");
const BEAT_RUNTIME_MANIFEST = resolve(
  ROOT,
  "apps/desktop/src-tauri/src/video/beat-detect-runtime-manifest.json",
);
const TARGET = "x86_64-pc-windows-msvc";
const NPM_PACKAGE = "@supa-video/desktop";

/** Licenses acceptable for a privately distributed desktop build. */
export const ALLOWED = Object.freeze(
  new Set([
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "CC0-1.0",
    "CDLA-Permissive-2.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "OFL-1.1",
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "Unlicense",
    "Zlib",
  ]),
);

function fail(message) {
  throw new Error(`license-inventory: ${message}`);
}

/** Normalizes legacy `A/B` spellings to SPDX `A OR B`. */
export function normalizeExpression(expression) {
  if (typeof expression !== "string" || expression.trim() === "") return null;
  return expression
    .replace(/\s*\/\s*/gu, " OR ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * True when the SPDX expression can be satisfied with allowed licenses.
 * Supports OR, AND, WITH and parentheses; AND binds tighter than OR.
 */
export function isSatisfiable(expression, allowed = ALLOWED) {
  const tokens = expression.match(/\(|\)|[^\s()]+/gu) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  function primary() {
    const token = tokens[index++];
    if (token === undefined) fail(`truncated expression "${expression}"`);
    if (token === "(") {
      const value = or();
      if (tokens[index++] !== ")") fail(`unbalanced expression "${expression}"`);
      return value;
    }
    if (["AND", "OR", "WITH", ")"].includes(token)) fail(`malformed expression "${expression}"`);
    if (peek() === "WITH") {
      index++;
      const exception = tokens[index++];
      if (exception === undefined) fail(`malformed expression "${expression}"`);
      return allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  }
  function and() {
    let value = primary();
    while (peek() === "AND") {
      index++;
      value = primary() && value;
    }
    return value;
  }
  function or() {
    let value = and();
    while (peek() === "OR") {
      index++;
      value = and() || value;
    }
    return value;
  }
  const result = or();
  if (index !== tokens.length) fail(`malformed expression "${expression}"`);
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
  }
  return result.stdout;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail(`${label}: malformed JSON`);
  }
}

/** pnpm `licenses list --json` shape: { [license]: [{ name, versions[], license }] }. */
export function npmEntries(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    fail("pnpm licenses: expected an object");
  }
  const entries = [];
  for (const [group, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) fail(`pnpm licenses: group ${group} is not a list`);
    for (const item of packages) {
      if (typeof item?.name !== "string" || !Array.isArray(item.versions)) {
        fail(`pnpm licenses: malformed entry in ${group}`);
      }
      for (const version of item.versions) {
        if (typeof version !== "string") fail(`pnpm licenses: bad version for ${item.name}`);
        entries.push({
          ecosystem: "npm",
          name: item.name,
          version,
          license: normalizeExpression(item.license ?? group),
        });
      }
    }
  }
  return entries;
}

/** Normal + build dependency closure of the workspace root crate. */
export function cargoEntries(metadata) {
  if (!Array.isArray(metadata?.packages) || metadata?.resolve?.nodes === undefined) {
    fail("cargo metadata: unexpected shape");
  }
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.resolve.root;
  if (typeof root !== "string" || !nodes.has(root)) fail("cargo metadata: no root package");
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const node = nodes.get(queue.shift());
    for (const dep of node?.deps ?? []) {
      const kinds = Array.isArray(dep.dep_kinds) ? dep.dep_kinds : [];
      if (!kinds.some((kind) => kind.kind === null || kind.kind === "build")) continue;
      if (!seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  seen.delete(root);
  return [...seen].map((id) => {
    const item = packages.get(id);
    if (item === undefined) fail(`cargo metadata: unknown package ${id}`);
    return {
      ecosystem: "cargo",
      name: item.name,
      version: item.version,
      license: normalizeExpression(item.license),
    };
  });
}

export function validate(entries) {
  const problems = [];
  for (const entry of entries) {
    if (entry.license === null)
      problems.push(`${entry.ecosystem} ${entry.name}@${entry.version}: no license`);
    else if (!isSatisfiable(entry.license)) {
      problems.push(
        `${entry.ecosystem} ${entry.name}@${entry.version}: ${entry.license} not allowed`,
      );
    }
  }
  return problems;
}

/**
 * Notices for the downloadable music-beat runtime (models and GPU pack). These files are
 * not bundled; the user's runtime folder is filled from the pinned manifest.
 */
export function runtimeNotices(manifest) {
  const models = manifest?.models?.files;
  const archives = manifest?.gpuPack?.archives;
  if (!Array.isArray(models) || !Array.isArray(archives)) {
    fail("beat runtime manifest: unexpected shape");
  }
  const notice = (name, license) => {
    if (
      typeof name !== "string" ||
      typeof license?.spdx !== "string" ||
      typeof license?.url !== "string"
    ) {
      fail(`beat runtime manifest: incomplete license for ${String(name)}`);
    }
    return { name, license: license.spdx, url: license.url };
  };
  return [
    ...models.map((model) => notice(model.file, model.license)),
    ...archives.map((archive) => notice(archive.url?.split("/").pop(), archive.license)),
  ];
}

export function render(entries, notices = []) {
  const sorted = [...entries].sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  );
  const unique = sorted.filter(
    (entry, index) =>
      index === 0 ||
      entry.ecosystem !== sorted[index - 1].ecosystem ||
      entry.name !== sorted[index - 1].name ||
      entry.version !== sorted[index - 1].version,
  );
  const lines = [
    "# Third-party licenses — Supa Video Producer",
    "",
    "Generated by `node scripts/license-inventory.mjs` from the production npm graph of",
    `\`${NPM_PACKAGE}\` and the Rust normal/build graph for \`${TARGET}\`.`,
    "FFmpeg and its libraries are listed separately in `media-tools/THIRD_PARTY_NOTICES.md`.",
    "Full license texts are available from each package's published source.",
    "",
  ];
  for (const ecosystem of ["npm", "cargo"]) {
    const rows = unique.filter((entry) => entry.ecosystem === ecosystem);
    lines.push(
      `## ${ecosystem === "npm" ? "JavaScript (npm)" : "Rust (crates.io)"} — ${rows.length} packages`,
      "",
    );
    lines.push("| Package | Version | License |", "|---|---|---|");
    for (const row of rows) lines.push(`| ${row.name} | ${row.version} | ${row.license} |`);
    lines.push("");
  }
  if (notices.length > 0) {
    lines.push(
      `## Music beat runtime (downloaded separately) — ${notices.length} items`,
      "",
      "Not bundled. `scripts/bootstrap-beat-runtime-windows.ps1` downloads these pinned files into",
      "the user's music beat runtime folder; NVIDIA components are redistributed under their EULAs.",
      "",
      "| File | License | Terms |",
      "|---|---|---|",
    );
    for (const item of notices) lines.push(`| ${item.name} | ${item.license} | ${item.url} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export function collect() {
  const npm = npmEntries(
    parseJson(
      run("pnpm", ["--filter", NPM_PACKAGE, "licenses", "list", "--json", "--prod"], ROOT),
      "pnpm licenses",
    ),
  ).filter((entry) => !entry.name.startsWith("@supa-video/"));
  const cargo = [MANIFEST, BEAT_DETECTOR_MANIFEST].flatMap((manifest) =>
    cargoEntries(
      parseJson(
        run(
          "cargo",
          [
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--filter-platform",
            TARGET,
            "--manifest-path",
            manifest,
          ],
          ROOT,
        ),
        "cargo metadata",
      ),
    ),
  );
  return [...npm, ...cargo];
}

export function collectNotices() {
  return runtimeNotices(
    parseJson(readFileSync(BEAT_RUNTIME_MANIFEST, "utf8"), "beat runtime manifest"),
  );
}

function main(argv) {
  const check = argv.includes("--check");
  const entries = collect();
  const problems = validate(entries);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    fail(`${problems.length} package(s) with unknown or denied licenses`);
  }
  const text = render(entries, collectNotices());
  if (check) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8").replace(/\r\n/gu, "\n") !== text) {
      fail(`${OUTPUT} is missing or stale; run node scripts/license-inventory.mjs`);
    }
    console.log(`license-inventory: ${entries.length} packages, all allowed, file up to date`);
    return;
  }
  writeFileSync(OUTPUT, text);
  console.log(`license-inventory: wrote ${entries.length} packages to ${OUTPUT}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
