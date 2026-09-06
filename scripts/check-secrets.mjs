import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const root = fileURLToPath(new URL("../", import.meta.url));
const [binaryArg, sourceArg = ".", scratchArg = ".cache/p1-security"] = process.argv.slice(2);
try {
  if (!binaryArg || process.argv.length > 5)
    throw new Error(
      "Supply a verified Gitleaks binary, optional Git source and private scratch directory",
    );
  const binary = resolve(binaryArg);
  const source = resolve(sourceArg);
  function git(args) {
    const result = spawnSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || result.stderr)
      throw new Error("Git coverage inspection failed");
    return result.stdout.trim();
  }
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false")
    throw new Error("Full history required; shallow repository rejected");
  const commits = git(["rev-list", "--all", "--count"]);
  if (!/^[1-9]\d*$/.test(commits) || !Number.isSafeInteger(Number(commits)))
    throw new Error("Empty or invalid history coverage");
  const refs = git(["for-each-ref", "--format=%(refname) %(objectname)"]);
  mkdirSync(resolve(scratchArg), { recursive: true });
  const scratch = mkdtempSync(join(resolve(scratchArg), "secrets-"));
  const ignore = join(scratch, "empty.gitleaksignore");
  const report = join(scratch, "report.json");
  writeFileSync(ignore, "");
  writeFileSync(join(scratch, "coverage.txt"), `commits=${commits}\nshallow=false\n${refs}\n`);
  const result = spawnSync(
    binary,
    [
      "git",
      source,
      // Separate-parent patches expose merge resolutions to Gitleaks' ordinary diff parser.
      "--log-opts=--all --full-history --diff-merges=separate",
      "--redact=100",
      "--ignore-gitleaks-allow",
      "--config",
      join(root, "security/gitleaks.toml"),
      "--gitleaks-ignore-path",
      ignore,
      "--report-format=json",
      "--report-path",
      report,
      "--log-level=error",
      "--no-banner",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  // The scanner can exit zero on Git errors. Error-only logs must also be empty.
  writeFileSync(join(scratch, "scanner.stderr"), result.stderr ?? "");
  writeFileSync(join(scratch, "scanner.stdout"), result.stdout ?? "");
  writeFileSync(join(scratch, "scanner.exit"), `${result.status}\n`);
  let findings;
  try {
    findings = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    throw new Error("Missing or malformed secret report; inspect private scratch output");
  }
  if (!Array.isArray(findings)) throw new Error("Unknown secret report shape");
  console.log(
    `Secret history scan: ${commits} commits; ${findings.length} findings; scanner exit ${result.status}`,
  );
  if (
    result.error ||
    result.status !== 0 ||
    result.stderr ||
    result.stdout ||
    findings.length !== 0
  )
    throw new Error(
      "Secret gate failed; findings or scanner errors remain in private scratch output",
    );
} catch (error) {
  // Never echo tool output or secret report contents.
  console.error(
    error instanceof Error && error.message.startsWith("E")
      ? "Secret gate file/process operation failed"
      : error.message,
  );
  process.exitCode = 1;
}
