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
} from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  base = fileURLToPath(new URL("./", import.meta.url));
const desktop = path.join(root, "apps/desktop"),
  tauri = path.join(desktop, "src-tauri");
const require = createRequire(path.join(desktop, "package.json"));
const mode = process.argv[2];
if (!["native-profile", "native-uninstrumented"].includes(mode))
  throw new Error("Explicit native build mode required");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// Fail before build when source resources/capabilities are not verified. This does not install.
execFileSync(
  "powershell",
  ["-NoProfile", "-File", path.join(root, "scripts/bootstrap-ffmpeg-windows.ps1"), "-VerifyOnly"],
  { cwd: root, stdio: "inherit" },
);
mkdirSync(path.join(base, "runs"), { recursive: true });
const run = mkdtempSync(path.join(base, "runs", "release-"));
const frontend = path.join(run, "frontend"),
  target = path.join(run, "target");
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
// No app/security/capability/resource policy override; identity and owned build output only.
const configPath = path.join(run, "tauri.isolated.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
const argv = [
  path.join(path.dirname(require.resolve("@tauri-apps/cli")), "tauri.js"),
  "build",
  "--no-bundle",
  "--config",
  path.join(tauri, "tauri.media-tools.windows.conf.json"),
  "--config",
  configPath,
  "--",
  "--offline",
  "--locked",
];
const overrides = {
  COREPACK_ENABLE_NETWORK: "0",
  CARGO_NET_OFFLINE: "true",
  RUSTUP_AUTO_INSTALL: "0",
  CARGO_TARGET_DIR: target,
  P2_FRONTEND_OUTPUT: frontend,
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
  trackedDiffSha256: sha(
    execFileSync("git", ["diff", "HEAD", "--binary", "--no-ext-diff"], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    }),
  ),
  sourceScripts: [
    "assemble-release.mjs",
    "vite.evidence.config.mjs",
    "vite.profile.config.mjs",
  ].map((p) => ({ path: p, sha256: sha(readFileSync(path.join(base, p))) })),
  scope: "Isolated assembled release, no installer or distribution claim",
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
  if (result.status !== 0) throw new Error(`Offline release build failed; retained log: ${log}`);
  const executable = path.join(target, "release", "supa-video-desktop.exe");
  receipt.executable = executable;
  receipt.executableSha256 = sha(readFileSync(executable));
  const overlay = JSON.parse(
    readFileSync(path.join(tauri, "tauri.media-tools.windows.conf.json"), "utf8"),
  );
  receipt.resources = Object.entries(overlay.bundle.resources).map(([source, destination]) => {
    const expected = readFileSync(path.join(tauri, source)),
      actual = readFileSync(path.join(target, "release", destination));
    if (!expected.equals(actual)) throw new Error(`Assembled resource mismatch: ${destination}`);
    return { path: destination, sha256: sha(actual), bytes: actual.length };
  });
  const enumerate = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? enumerate(path.join(dir, entry.name))
        : [
            {
              path: path.relative(frontend, path.join(dir, entry.name)),
              sha256: sha(readFileSync(path.join(dir, entry.name))),
            },
          ],
    );
  receipt.frontend = enumerate(frontend);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error);
  throw error;
} finally {
  closeSync(fd);
  receipt.logSha256 = sha(readFileSync(log));
  const out = path.join(run, "receipt.json");
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({ receipt: out, sha256: sha(readFileSync(out)), status: receipt.status }),
  );
}
