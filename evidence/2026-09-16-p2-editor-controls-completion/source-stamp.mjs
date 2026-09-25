import fs from "node:fs";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import crypto from "node:crypto";
import { format, resolveConfig } from "prettier";
import { execFileSync } from "node:child_process";
import { testPort } from "../../apps/desktop/test-port.mjs";
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) throw Error("Explicit safe check label required");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const files = [
  ...new Set([
    ...git("diff", "--name-only", "-z", "HEAD").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ]),
]
  .filter(Boolean)
  .sort();
const hashes = Object.fromEntries(
  files
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]),
);
const record = {
  label,
  timestamp: new Date().toISOString(),
  head: git("rev-parse", "HEAD").trim(),
  platform: process.platform,
  node: process.version,
  environment: { SUPA_VIDEO_TEST_PORT: process.env.SUPA_VIDEO_TEST_PORT ?? null },
  effectiveTestPort: testPort,
  hashes,
};
fs.writeFileSync(
  path.join("evidence/2026-09-16-p2-editor-controls-completion", `stamp-${label}.json`),
  await format(JSON.stringify(record), {
    ...(await resolveConfig("package.json")),
    parser: "json",
  }),
);
console.log(
  JSON.stringify({
    ...record,
    hashes: undefined,
    dirtyFileCount: files.length,
    hashManifest: `stamp-${label}.json`,
  }),
);
