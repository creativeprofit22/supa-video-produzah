// Runs both versioned first-cut fixtures twice through the built package,
// writes each proposal and compiled group, and checks reproducibility,
// beat coverage and duration against the beat plan.
// Usage (from repo root, after `pnpm --filter @supa-video/produce build`):
//   node evidence/2026-09-30-p3-first-cut/run-fixtures.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { canonicalJson, proposalDurationUs, runFirstCutFixture } from "../../packages/video-produce/dist/index.js";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../../packages/video-produce/fixtures/v1/${name}.json`, import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");

const summary = [];
let failed = false;
for (const name of ["explainer", "podcast"]) {
  const input = JSON.parse(readFileSync(fixture(name), "utf8"));
  const runs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runFirstCutFixture(input);
    if (!result.ok) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
    runs.push(result.value);
  }
  const [first, second] = runs;
  const bytes = [first, second].map((run) => canonicalJson({ proposal: run.proposal, compiled: run.compiled }));
  const planned = first.beats.at(-1).endUs - first.beats[0].startUs;
  const coverage = first.proposal.beats.map((item) => ({
    order: item.beat.order,
    startUs: item.beat.startUs,
    endUs: item.beat.endUs,
    intent: item.beat.intent.kind,
    status: item.status,
    coverage: item.coverage.kind,
    shot: item.coverage.kind === "footage" ? item.coverage.selected.candidate.displayName : null,
    alternatives: item.alternatives.map((alternative) => alternative.candidate.displayName),
    unresolvedReason: item.unresolvedReason,
  }));
  const record = {
    fixture: name,
    proposalId: first.proposal.proposalId,
    reproducible: bytes[0] === bytes[1] && first.proposal.proposalId === second.proposal.proposalId,
    run1Sha256: sha(bytes[0]),
    run2Sha256: sha(bytes[1]),
    beats: coverage.length,
    covered: coverage.filter((beat) => beat.status === "covered").length,
    unresolved: coverage.filter((beat) => beat.status === "unresolved").length,
    everyBeatCoveredOrUnresolved: coverage.every((beat) => beat.status === "covered" || beat.status === "unresolved"),
    plannedDurationUs: planned,
    proposalDurationUs: proposalDurationUs(first.proposal),
    durationMatchesPlan: proposalDurationUs(first.proposal) === planned,
    rightsRejected: first.proposal.rightsDecisions.filter((decision) => !decision.eligible).map((decision) => ({
      assetId: decision.assetId,
      reason: decision.reason,
    })),
    commands: first.compiled.request.commands.map((command) => command.type),
    clipCount: first.compiled.clipCount,
    captionCount: first.compiled.captionCount,
    markerCount: first.compiled.markerCount,
    coverage,
  };
  failed ||= !record.reproducible || !record.everyBeatCoveredOrUnresolved || !record.durationMatchesPlan;
  writeFileSync(here(`${name}-proposal.json`), `${JSON.stringify(JSON.parse(bytes[0]), null, 2)}\n`);
  summary.push(record);
}
writeFileSync(here("summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
for (const record of summary) {
  console.log(
    `${record.fixture}: ${record.proposalId} reproducible=${record.reproducible} beats=${record.beats} covered=${record.covered} unresolved=${record.unresolved} duration=${record.proposalDurationUs}/${record.plannedDurationUs}`,
  );
}
if (failed) process.exitCode = 1;
