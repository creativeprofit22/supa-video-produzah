import { createHash } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  lstatSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

// Inventory only: no builds, downloads, launches, or reads of live application data.
const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
const files = (bytes) => bytes.toString("utf8").split("\0").filter(Boolean);
function identity(relative) {
  const absolute = path.resolve(root, relative);
  const contained = path.relative(root, realpathSync(absolute));
  if (
    contained.startsWith("..") ||
    path.isAbsolute(contained) ||
    lstatSync(absolute).isSymbolicLink()
  ) {
    throw new Error(`Refusing external or linked input: ${relative}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`Not a regular input: ${relative}`);
  return {
    path: relative.replaceAll("\\", "/"),
    bytes: stat.size,
    sha256: sha(readFileSync(absolute)),
  };
}
const tracked = files(git("ls-files", "-z"));
const untracked = files(git("ls-files", "--others", "--exclude-standard", "-z"));
const relevant = (p) =>
  /^(apps\/desktop\/|packages\/|scripts\/|evidence\/p2-native-performance\/)/.test(p) ||
  /^(package.json|pnpm-lock.yaml|pnpm-workspace.yaml)$/.test(p);
const source = [...tracked, ...untracked].filter(relevant).sort().map(identity);
const overlay = JSON.parse(
  readFileSync(
    path.join(root, "apps/desktop/src-tauri/tauri.media-tools.windows.conf.json"),
    "utf8",
  ),
);
const resources = Object.keys(overlay.bundle.resources)
  .sort()
  .map((p) => identity(`apps/desktop/src-tauri/${p}`));
const receipt = {
  utc: new Date().toISOString(),
  head: git("rev-parse", "HEAD").toString().trim(),
  trackedDiffSha256: sha(git("diff", "HEAD", "--binary", "--no-ext-diff")),
  status: git("status", "--porcelain=v1").toString(),
  sourceSha256: sha(JSON.stringify(source)),
  source,
  resources,
  argv: process.argv,
  environmentOverrides: {},
  scope:
    "Dirty working tree inventory, not HEAD-only verification; source resources, not assembled release resources. No runtime measurement.",
};
const runs = path.join(root, "evidence/p2-native-performance/runs");
mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(path.join(runs, "snapshot-"));
const output = path.join(directory, "identity.json");
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      output,
      sha256: sha(readFileSync(output)),
      head: receipt.head,
      trackedDiffSha256: receipt.trackedDiffSha256,
      sourceSha256: receipt.sourceSha256,
      sourceFiles: source.length,
      resources,
    },
    null,
    2,
  ),
);
