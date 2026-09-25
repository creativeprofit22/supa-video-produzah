// One bounded case per invocation. Explicit authorization is never inferred.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { captureCalibration } from "./capture-calibration.mjs";
import { cases, mediaRoot, stem, key, hash, decode } from "./step8-media.mjs";
import { analyze, targetNames } from "./step8-analysis.mjs";
import { testBaseUrl } from "../../apps/desktop/test-port.mjs";

const [mode, index, reviewedProfile, generation = "baseline", scope = "all"] =
  process.argv.slice(2);
if (!["baseline", "slow-onset"].includes(generation)) throw Error("Unknown fixed media generation");
const activeMediaRoot = generation === "baseline" ? mediaRoot : path.join(mediaRoot, "slow-onset");
if (
  !["--record-authorized", "--validate-only"].includes(mode) ||
  !/^[0-7]$/.test(index ?? "") ||
  !reviewedProfile
)
  throw Error(
    "Usage: node capture-step8.mjs <--record-authorized|--validate-only> <0..7> <parent-reviewed-calibration/results.json> [baseline|slow-onset] [all|preview-only]",
  );
const c = cases[Number(index)];
const names = targetNames(c, scope);
// Exercise the same shared entry gate before file reads, decode subprocesses or capture.
const validation = await captureCalibration({
  mode: "--validate-only",
  targets: names.map((name) => ({ name })),
});
if (mode === "--validate-only") {
  console.log(JSON.stringify({ ...validation, case: c, scope }));
} else {
  const profileBytes = fs.readFileSync(reviewedProfile);
  const profile = JSON.parse(profileBytes);
  if (
    profile.calibration !== "candidate-pass-parent-review-required" ||
    profile.results?.length !== 3 ||
    profile.results.some((r) => r.classification !== "pass") ||
    !profile.noOffsetSubtraction ||
    !profile.strictSixSecondBoundMet
  )
    throw Error("A parent-reviewed synchronized/+100/-100ms qualified profile is required");
  const source = path.join(activeMediaRoot, stem(c) + ".mp4"),
    final = path.join(activeMediaRoot, key(c) + ".mp4");
  // Failed final timing is a product observation, not a reason to shift the source or retry to green.
  const decodedSource = decode(source, 180, c),
    decodedFinal = names.includes("final") ? decode(final, 60, c) : null;
  if (!decodedSource.valid || (decodedFinal && !decodedFinal.structurallyValid))
    throw Error("Invalid synthetic source/output structure");
  const provenance = {
    case: c,
    generation,
    scope,
    reviewedProfile: path.resolve(reviewedProfile),
    profileSha256: hash(profileBytes),
    decodedSource,
    decodedFinal,
    compilerPlan: JSON.parse(fs.readFileSync(path.join(activeMediaRoot, key(c) + ".plan.json"))),
    compilerSha256: hash(fs.readFileSync("apps/desktop/browser-tests/compile-speed-export.mjs")),
    fixtureSha256: hash(
      fs.readFileSync("apps/desktop/browser-tests/program-monitor-speed.fixture.tsx"),
    ),
  };
  // At 200%, also verify source audition returns to 1x, once at each sequence rate.
  const targets = names.map((name) => ({
    name,
    async prepare(page) {
      await page.goto(
        `${testBaseUrl}/browser-tests/program-monitor-speed.html?parity&completion=${generation}&speed=${c.percent}${c.rd === 1001 ? "&fractional" : ""}`,
      );
      // WgcRoi rechecks this tag with PID/HWND on every capture; navigation replaces the title.
      await page.evaluate(() => {
        globalThis.document.title = "SUPA_LOOPBACK_PRIVATE_TEST";
      });
      if (name === "final") await page.getByRole("button", { name: "Final", exact: true }).click();
      if (name === "source")
        await page.getByRole("button", { name: "Source 1x", exact: true }).click();
      // Only positioning of the owned visual stage changes. No observer AudioContext/worklet.
      await page.addStyleTag({
        content: `.monitor-stage {position:fixed!important;left:0!important;top:0!important;width:640px!important;height:360px!important;z-index:10000!important;background:black!important} .transport-play {position:fixed!important;left:0!important;top:400px!important;z-index:10001!important}`,
      });
      await page.waitForFunction(() => {
        const video = globalThis.document.querySelector("video");
        return video && video.readyState >= 2 && !video.seeking && video.paused;
      });
      const state = await page.locator("video").evaluate((v) => ({
        src: v.currentSrc,
        rate: v.playbackRate,
        time: v.currentTime,
        preservesPitch: v.preservesPitch,
        muted: v.muted,
      }));
      if (
        !state.src.endsWith((name === "final" ? key(c) : stem(c)) + ".mp4") ||
        state.muted ||
        !state.preservesPitch ||
        state.rate !== (name === "preview" ? c.sn / c.sd : 1) ||
        Math.abs(state.time - (name === "preview" ? (30 * c.rd) / c.rn : 0)) > c.rd / c.rn
      )
        throw Error("Production media mode/initial seek/rate not ready: " + JSON.stringify(state));
      provenance[name] = state;
    },
  }));
  const run = await captureCalibration({
    mode,
    targets,
    reviewCalibration: async (directory) => {
      // Explicit CLI confirms review of the supplied historical profile, NOT a claim
      // that this fresh calibration or eventual production intervals have passed parent review.
      fs.writeFileSync(
        path.join(directory, "step8-provenance.json"),
        JSON.stringify(provenance, null, 2),
      );
      return true;
    },
  });
  fs.writeFileSync(path.join(run, "step8-provenance.json"), JSON.stringify(provenance, null, 2));
  const report = analyze(run, c, scope);
  if (
    (names.includes("final") && !decodedFinal.valid) ||
    Object.values(report.results).some(
      (r) => r.classification !== "candidate-pass-parent-review-required",
    )
  )
    throw Error(`Step8 failed or inconclusive; retained all samples: ${run}`);
}
