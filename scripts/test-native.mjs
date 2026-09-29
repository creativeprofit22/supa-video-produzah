// Standard native test command. Runs the full all-feature suite in parallel with the isolated
// tests skipped by exact name, then runs those tests serially on one thread:
// - the durable command acknowledgement budget test (unchanged 300 ms debug budget);
// - the cache publication race test, whose 10 s gate deadline covers the whole preparation
//   pipeline and is missed under parallel-suite load (late arrival, not a publisher race).
// Both passes always run; the command fails if either fails, or if the isolated pass did not
// run exactly those tests (so a rename cannot silently drop one from both passes).
//
// Usage: node scripts/test-native.mjs [extra cargo args for the parallel pass]
// With --message-format, the isolated pass's output goes to stderr so stdout stays the
// parallel pass's JSON stream only.
import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const manifest = fileURLToPath(new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url));
const isolatedTests = [
  "video::project::tests::durable_command_acknowledgement_p95_meets_budget",
  "video::tests::race_actual_prepared_publication_and_completed_reuse",
];
const cargoBase = ["test", "--locked", "--all-features", "--manifest-path", manifest];
const extraCargoArgs = process.argv.slice(2);
const jsonStdout = extraCargoArgs.some((arg) => arg.startsWith("--message-format"));

function run(label, args, output) {
  const started = Date.now();
  return new Promise((resolve) => {
    let captured = "";
    const child = spawn("cargo", args, { stdio: ["inherit", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => {
      captured += chunk.toString();
      output.write(chunk);
    });
    child.on("error", (error) => resolve({ label, status: null, error, captured, started }));
    child.on("close", (status) => resolve({ label, status, captured, started }));
  });
}

function report(result, extra) {
  console.error(
    JSON.stringify({
      event: "native-test-pass",
      pass: result.label,
      exit: result.status,
      error: result.error?.message,
      elapsedMs: Date.now() - result.started,
      ...extra,
    }),
  );
}

const parallel = await run(
  "parallel",
  [
    ...cargoBase,
    ...extraCargoArgs,
    "--",
    ...isolatedTests.flatMap((name) => ["--skip", name]),
    "--exact",
  ],
  process.stdout,
);
report(parallel);

const isolated = await run(
  "isolated",
  [...cargoBase, "--lib", "--", ...isolatedTests, "--exact", "--test-threads=1", "--show-output"],
  jsonStdout ? process.stderr : process.stdout,
);
const ranExactly =
  isolatedTests.every((name) => isolated.captured.includes(`test ${name} ... ok`)) &&
  isolated.captured.includes(`test result: ok. ${isolatedTests.length} passed; 0 failed`);
const p95 = /durable command acknowledgement p95: (\S+)/.exec(isolated.captured)?.[1] ?? null;
report(isolated, { ranExactly, p95 });

if (parallel.status !== 0 || isolated.status !== 0 || !ranExactly) {
  if (isolated.status === 0 && !ranExactly)
    console.error(`Isolated pass did not run exactly ${isolatedTests.join(", ")}`);
  process.exit(parallel.status || isolated.status || 1);
}
