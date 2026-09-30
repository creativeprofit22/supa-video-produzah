import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical.js";
import {
  type FirstCutFixtureRun,
  firstCutFixtureSchema,
  runFirstCutFixture,
} from "./first-cut-fixture.js";
import { proposalDurationUs } from "./first-cut-proposal.js";

/*
 * Golden fixtures. Set UPDATE_FIRST_CUT_GOLDEN=1 to rewrite the expected files
 * after an intentional, versioned change to planning or ranking.
 */

const FIXTURES = ["explainer", "podcast"] as const;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/v1/${name}`, import.meta.url));
}

function load(name: string): unknown {
  return JSON.parse(readFileSync(fixturePath(`${name}.json`), "utf8")) as unknown;
}

async function run(name: string): Promise<FirstCutFixtureRun> {
  const result = await runFirstCutFixture(load(name));
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function golden(value: FirstCutFixtureRun): string {
  const body = { proposal: value.proposal, compiled: value.compiled };
  return `${JSON.stringify(JSON.parse(canonicalJson(body)), null, 2)}\n`;
}

describe.each(FIXTURES)("%s golden fixture", (name) => {
  it("matches the checked-in expected output in canonical form", async () => {
    const actual = golden(await run(name));
    const path = fixturePath(`${name}.expected.json`);
    if (process.env.UPDATE_FIRST_CUT_GOLDEN === "1") writeFileSync(path, actual);
    // Canonical comparison is byte-exact on content but independent of file formatting.
    expect(canonicalJson(JSON.parse(actual))).toBe(
      canonicalJson(JSON.parse(readFileSync(path, "utf8"))),
    );
  });

  it("reproduces the same proposal id and bytes on a second run", async () => {
    const first = await run(name);
    const second = await run(name);
    expect(second.proposal.proposalId).toBe(first.proposal.proposalId);
    expect(golden(second)).toBe(golden(first));
  });

  it("covers every beat or leaves it explicitly unresolved across the planned duration", async () => {
    const { beats, proposal } = await run(name);
    expect(proposal.beats).toHaveLength(beats.length);
    for (const item of proposal.beats) {
      expect(["covered", "unresolved"]).toContain(item.status);
      if (item.status === "unresolved") {
        expect(item.coverage.kind).toBe("unresolved");
        expect(item.unresolvedReason).not.toBeNull();
      }
    }
    const planned = (beats.at(-1)?.endUs ?? 0) - (beats[0]?.startUs ?? 0);
    expect(proposalDurationUs(proposal)).toBe(planned);
  });

  it("never offers media whose rights failed, and explains every offer", async () => {
    const fixture = firstCutFixtureSchema.parse(load(name));
    const { proposal } = await run(name);
    const blocked = new Set(
      proposal.rightsDecisions.filter((decision) => !decision.eligible).map((d) => d.assetId),
    );
    const unknownLicense = fixture.state.assets.filter((asset) =>
      fixture.receipts.some(
        (receipt) =>
          receipt.receiptId === asset.origin?.acquisitionReceiptId &&
          receipt.license.code === "unknown",
      ),
    );
    expect(unknownLicense.length).toBeGreaterThan(0);
    for (const asset of unknownLicense) expect(blocked.has(asset.id)).toBe(true);
    for (const item of proposal.beats) {
      const offers = [
        ...(item.coverage.kind === "footage" ? [item.coverage.selected] : []),
        ...item.alternatives,
      ];
      for (const offer of offers) {
        expect(blocked.has(offer.candidate.assetId)).toBe(false);
        expect(offer.score.explanation.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("explainer fixture specifics", () => {
  it("resolves Spanish beats against English and German file names", async () => {
    const { proposal } = await run("explainer");
    const pick = (order: number): string | null => {
      const coverage = proposal.beats[order]?.coverage;
      return coverage?.kind === "footage" ? coverage.selected.candidate.displayName : null;
    };
    expect(pick(2)).toBe("kayak rapids.mp4");
    expect(pick(3)).toBe("Brücke bei Sonnenuntergang.mov");
    expect(pick(8)).toBe("river phone vertical.mp4");
    expect(proposal.beats[7]?.unresolvedReason).toBe("No rights-safe media shows: ciudad.");
  });

  it("records each rights failure mode in the audit", async () => {
    const { proposal } = await run("explainer");
    const reasons = proposal.rightsDecisions.flatMap((decision) =>
      decision.eligible ? [] : [decision.reason],
    );
    expect(reasons.sort()).toEqual([
      "refresh-stale",
      "upstream-withdrawn",
      "use-blocked",
      "use-blocked",
    ]);
  });
});

describe("podcast fixture specifics", () => {
  it("keeps the A-roll for beats without a strong cutaway and never cuts to the A-roll itself", async () => {
    const { proposal } = await run("podcast");
    expect(proposal.beats.map((item) => item.coverage.kind)).toEqual([
      "a-roll",
      "footage",
      "footage",
      "a-roll",
      "a-roll",
    ]);
    for (const item of proposal.beats) {
      expect(item.rejected.find((rejected) => rejected.reason === "a-roll-source")).toBeDefined();
    }
  });
});
