// Offline, locked Windows MSI build from the current tree, then an administrative extraction
// (msiexec /a) into an owned run directory. Nothing is installed or registered on the system.
// The frontend is the evidence build (native-uninstrumented: production React plus the harness's
// seek entry, as used by native-baseline.mjs); no app/security/capability/resource override.
// Any bundler download is refused: proxies point at a closed local port, and the cached tool
// directory is hashed before and after the build.
// Usage: node assemble-installer.mjs
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  base = fileURLToPath(new URL("./", import.meta.url));
const desktop = path.join(root, "apps/desktop"),
  tauri = path.join(desktop, "src-tauri");
const require = createRequire(path.join(desktop, "package.json"));
const mode = "native-uninstrumented";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const enumerate = (dir, from = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? enumerate(path.join(dir, entry.name), from)
        : [
            {
              path: path.relative(from, path.join(dir, entry.name)).replaceAll("\\", "/"),
              sha256: sha(readFileSync(path.join(dir, entry.name))),
            },
          ],
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const toolCache = path.join(process.env.LOCALAPPDATA ?? "", "tauri");
if (!existsSync(path.join(toolCache, "WixTools314")))
  throw new Error(
    `Cached WiX toolchain missing at ${toolCache}; refusing to let the bundler download it`,
  );
const cacheDigest = () => sha(JSON.stringify(enumerate(toolCache)));

execFileSync(
  "powershell",
  ["-NoProfile", "-File", path.join(root, "scripts/bootstrap-ffmpeg-windows.ps1"), "-VerifyOnly"],
  { cwd: root, stdio: "inherit" },
);
mkdirSync(path.join(base, "runs"), { recursive: true });
const run = mkdtempSync(path.join(base, "runs", "installer-"));
const frontend = path.join(run, "frontend"),
  target = path.join(run, "target"),
  extract = path.join(run, "extracted");
const identifier = `com.supavideo.p2-${path.basename(run).toLowerCase()}`;
const config = {
  identifier,
  build: {
    frontendDist: path.relative(tauri, frontend).replaceAll("\\", "/"),
    beforeBuildCommand: {
      cwd: desktop,
      script: `pnpm exec vite build --config ../../evidence/p2-native-performance/vite.evidence.config.mjs --mode ${mode}`,
    },
  },
};
const configPath = path.join(run, "tauri.isolated.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
const argv = [
  path.join(path.dirname(require.resolve("@tauri-apps/cli")), "tauri.js"),
  "build",
  "--bundles",
  "msi",
  "--config",
  path.join(tauri, "tauri.media-tools.windows.conf.json"),
  "--config",
  configPath,
  "--",
  "--offline",
  "--locked",
];
const deadProxy = "http://127.0.0.1:9";
const overrides = {
  COREPACK_ENABLE_NETWORK: "0",
  CARGO_NET_OFFLINE: "true",
  RUSTUP_AUTO_INSTALL: "0",
  CARGO_TARGET_DIR: target,
  P2_FRONTEND_OUTPUT: frontend,
  HTTP_PROXY: deadProxy,
  HTTPS_PROXY: deadProxy,
  ALL_PROXY: deadProxy,
  http_proxy: deadProxy,
  https_proxy: deadProxy,
  NO_PROXY: "",
};
const receipt = {
  utc: new Date().toISOString(),
  mode,
  identifier,
  config,
  argv: [process.execPath, ...argv],
  environmentOverrides: overrides,
  sourceSnapshot: JSON.parse(
    execFileSync(process.execPath, [path.join(base, "snapshot.mjs")], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceScripts: [
    "assemble-installer.mjs",
    "vite.evidence.config.mjs",
    "vite.profile.config.mjs",
  ].map((p) => ({ path: p, sha256: sha(readFileSync(path.join(base, p))) })),
  toolCacheBefore: cacheDigest(),
  installer: true,
  scope:
    "MSI built offline; administratively extracted (msiexec /a) into an owned directory, not installed",
};
const log = path.join(run, "build.log"),
  fd = openSync(log, "wx");
try {
  console.log(`BUILD_START ${run}`);
  const result = spawnSync(process.execPath, argv, {
    cwd: desktop,
    env: { ...process.env, ...overrides },
    stdio: ["ignore", fd, fd],
  });
  receipt.exitCode = result.status;
  if (result.error) throw result.error;
  closeSync(fd);
  const text = readFileSync(log, "utf8");
  receipt.toolCacheAfter = cacheDigest();
  receipt.downloadLines = text
    .split(/\r?\n/)
    .filter((line) => /download|https?:\/\//i.test(line))
    .slice(0, 50);
  if (receipt.toolCacheAfter !== receipt.toolCacheBefore)
    throw new Error("Bundler tool cache changed during the build (possible download)");
  if (receipt.downloadLines.some((line) => /download/i.test(line)))
    throw new Error(`Bundler reported a download: ${receipt.downloadLines.join(" | ")}`);
  if (result.status !== 0) throw new Error(`Offline MSI build failed; retained log: ${log}`);

  const bundleDir = path.join(target, "release", "bundle", "msi");
  const msis = readdirSync(bundleDir).filter((f) => f.toLowerCase().endsWith(".msi"));
  if (msis.length !== 1) throw new Error(`Expected one MSI, found ${msis.join(", ")}`);
  const msi = path.join(bundleDir, msis[0]);
  receipt.msi = { path: msi, sha256: sha(readFileSync(msi)), bytes: readFileSync(msi).length };
  receipt.authenticode = JSON.parse(
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$s = Get-AuthenticodeSignature -LiteralPath $env:P2_MSI; @{ status = [string]$s.Status; message = $s.StatusMessage; signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress",
      ],
      { env: { ...process.env, P2_MSI: msi }, encoding: "utf8" },
    ),
  );

  // Administrative extraction: unpacks the files, registers nothing.
  mkdirSync(extract);
  const msiLog = path.join(run, "msiexec-admin.log");
  const admin = spawnSync(
    "msiexec.exe",
    ["/a", msi, "/qn", `TARGETDIR=${extract}`, "/l*v", msiLog],
    { stdio: "ignore", timeout: 600000 },
  );
  receipt.adminExtract = { exitCode: admin.status, log: msiLog };
  if (admin.error) throw admin.error;
  if (admin.status !== 0) throw new Error(`msiexec /a failed with ${admin.status}; log ${msiLog}`);
  receipt.extractedTree = enumerate(extract);
  const exe = receipt.extractedTree.filter(
    (f) =>
      f.path.toLowerCase().endsWith("/supa-video-desktop.exe") ||
      f.path.toLowerCase() === "supa-video-desktop.exe",
  );
  if (exe.length !== 1) throw new Error(`Expected one extracted executable, found ${exe.length}`);
  const executable = path.join(extract, exe[0].path);
  receipt.executable = executable;
  receipt.executableSha256 = exe[0].sha256;
  receipt.builtExecutableSha256 = sha(
    readFileSync(path.join(target, "release", "supa-video-desktop.exe")),
  );

  // Bundled resources in the extracted tree must byte-match the pinned sources.
  const overlay = JSON.parse(
    readFileSync(path.join(tauri, "tauri.media-tools.windows.conf.json"), "utf8"),
  );
  receipt.resources = Object.entries(overlay.bundle.resources).map(([source, destination]) => {
    const expected = readFileSync(path.join(tauri, source)),
      actual = readFileSync(path.join(path.dirname(executable), destination));
    if (!expected.equals(actual)) throw new Error(`Extracted resource mismatch: ${destination}`);
    return { path: destination, sha256: sha(actual), bytes: actual.length };
  });
  receipt.frontend = enumerate(frontend);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error);
  throw error;
} finally {
  try {
    closeSync(fd);
  } catch {
    // already closed after the build
  }
  receipt.logSha256 = sha(readFileSync(log));
  const out = path.join(run, "receipt.json");
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({ receipt: out, sha256: sha(readFileSync(out)), status: receipt.status }),
  );
}
