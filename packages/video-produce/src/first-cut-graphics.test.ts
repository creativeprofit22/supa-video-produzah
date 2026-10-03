import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createRationalTime,
  graphicsProposalV1WireSchema,
  type ProjectRevisionDescriptorV2,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical.js";
import { type FirstCutFixtureRun, runFirstCutFixture } from "./first-cut-fixture.js";
import {
  graphicsForFirstCut,
  MUSIC_BEAT_SNAP_TOLERANCE_US,
  proposeFirstCutGraphics,
  recipeGraphicsProducer,
} from "./first-cut-graphics.js";
import { proposeRecipeGraphics } from "./recipe-graphics.js";
import { STYLE_RECIPES, type StyleRecipe } from "./style-recipes.js";
import { testUuid } from "./test-support.js";

/*
 * Golden fixtures. Set UPDATE_RECIPE_GRAPHICS_GOLDEN=1 to rewrite the expected files after an
 * intentional change to a recipe, the first-cut graphics rule or the graphics compiler.
 */
const UPDATE = process.env.UPDATE_RECIPE_GRAPHICS_GOLDEN === "1";

function producePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/v1/recipe-graphics/${name}`, import.meta.url));
}

function contractsPath(name: string): string {
  return fileURLToPath(new URL(`../../video-contracts/fixtures/${name}`, import.meta.url));
}

function pretty(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

function expectGolden(path: string, value: unknown): void {
  const actual = pretty(value);
  if (UPDATE) writeFileSync(path, actual);
  expect(canonicalJson(JSON.parse(actual))).toBe(
    canonicalJson(JSON.parse(readFileSync(path, "utf8"))),
  );
}

async function explainer(): Promise<{ run: FirstCutFixtureRun; sequence: VideoSequenceV2 }> {
  const raw: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/v1/explainer.json", import.meta.url)), "utf8"),
  );
  const result = await runFirstCutFixture(raw);
  if (!result.ok) throw new Error(result.error.message);
  const [base] = (raw as { state: { sequences: VideoSequenceV2[] } }).state.sequences;
  if (base === undefined) throw new Error("fixture has a sequence");
  // The sequence as it stands once the first cut is applied.
  const inserted = result.value.compiled.request.commands.flatMap((command) =>
    command.type === "InsertTrack" ? [command.track] : [],
  );
  return { run: result.value, sequence: { ...base, tracks: [...base.tracks, ...inserted] } };
}

function revision(number: number): ProjectRevisionDescriptorV2 {
  return {
    number,
    id: testUuid(0xa0, number),
    parentId: testUuid(0xa0, number - 1),
    committedAt: "2026-10-03T12:00:00.000Z",
    operationId: testUuid(0xa1, number),
    stateHash: "ef".repeat(32),
  };
}

const recipeIds = STYLE_RECIPES.map(({ id }) => id);

describe.each(recipeIds)("%s on the explainer first cut", (recipeId) => {
  const recipe = STYLE_RECIPES.find(({ id }) => id === recipeId) as StyleRecipe;

  it("matches the golden description and proposal", async () => {
    const { run, sequence } = await explainer();
    const description = graphicsForFirstCut({ firstCut: run.proposal, recipe, sequence });
    const proposal = await proposeFirstCutGraphics({
      firstCut: run.proposal,
      recipeId,
      sequence,
      projectId: run.proposal.projectId,
      revision: revision(run.proposal.projectRevision + 1),
    });
    if (!proposal.ok) throw new Error(proposal.error.kind);
    expect(proposal.value.description).toEqual(description);
    expect(proposal.value.producer).toEqual(recipeGraphicsProducer(recipeId));
    graphicsProposalV1WireSchema.parse(proposal.value);
    expectGolden(producePath(`${recipeId}.expected.json`), {
      description,
      proposal: proposal.value,
    });
  });

  it("respects the recipe's pacing limits", async () => {
    const { run, sequence } = await explainer();
    const { pacing } = recipe;
    const { items } = graphicsForFirstCut({ firstCut: run.proposal, recipe, sequence });
    const spanUs = run.proposal.endUs - run.proposal.startUs;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(
      Math.max(1, Math.floor((pacing.maxPerMinute * spanUs) / 60_000_000)),
    );
    for (const [index, item] of items.entries()) {
      expect(item.durationUs).toBe(pacing.cardDurationUs);
      const next = items[index + 1];
      if (next !== undefined)
        expect(next.atUs - (item.atUs + pacing.cardDurationUs)).toBeGreaterThanOrEqual(
          pacing.minGapUs,
        );
      expect(item.atUs + pacing.cardDurationUs).toBeLessThanOrEqual(run.proposal.endUs);
    }
    const roles = items.map((item) => (item.kind === "card" ? item.role : "caption"));
    expect(roles[0] === "title").toBe(pacing.titleCard);
    expect(roles.at(-1) === "endCard").toBe(pacing.endCard);
    expect(roles.slice(1, -1).every((role) => role === "lowerThird")).toBe(true);
  });

  it("is deterministic", async () => {
    const { run, sequence } = await explainer();
    const input = {
      firstCut: run.proposal,
      recipeId,
      sequence,
      projectId: run.proposal.projectId,
      revision: revision(9),
    };
    expect(await proposeFirstCutGraphics(input)).toEqual(await proposeFirstCutGraphics(input));
  });
});

describe("graphicsForFirstCut", () => {
  it("snaps to music beats only for recipes that ask for it", async () => {
    const { run, sequence } = await explainer();
    // Near the 6.6 s and 11.8 s beat starts that both snapping recipes place lower thirds on.
    const beats = [6_700_000, 11_650_000, 20_000_000];
    for (const recipe of STYLE_RECIPES) {
      const plain = graphicsForFirstCut({ firstCut: run.proposal, recipe, sequence });
      const snapped = graphicsForFirstCut({
        firstCut: run.proposal,
        recipe,
        sequence,
        musicBeatsUs: beats,
      });
      const moved = snapped.items.some((item, index) => item.atUs !== plain.items[index]?.atUs);
      expect(moved).toBe(recipe.pacing.snapToMusicBeats);
      if (!recipe.pacing.snapToMusicBeats) continue;
      // Graphics land on a music beat whenever one is within tolerance.
      for (const item of snapped.items.filter(({ id }) => id.startsWith("beat-"))) {
        const near = beats.some(
          (beat) => Math.abs(beat - item.atUs) <= MUSIC_BEAT_SNAP_TOLERANCE_US,
        );
        if (near) expect(beats).toContain(item.atUs);
      }
    }
  });

  it("places new graphics around graphics already on the sequence", async () => {
    // Arrange: the explainer first cut with one recipe's graphics proposal applied.
    const { run, sequence } = await explainer();
    const first = await proposeFirstCutGraphics({
      firstCut: run.proposal,
      recipeId: "calm-explainer",
      sequence,
      projectId: run.proposal.projectId,
      revision: revision(run.proposal.projectRevision + 1),
    });
    if (!first.ok) throw new Error(first.error.kind);
    const { commands } = first.value.commandGroup;
    const clips = commands.flatMap((command) =>
      command.type === "AddGraphicsClip" ? [command.graphicsClip] : [],
    );
    const tracks = commands.flatMap((command) =>
      command.type === "InsertTrack" && command.track.kind === "graphics"
        ? [{ ...command.track, graphicsClips: clips }]
        : [],
    );
    expect(tracks).toHaveLength(1);
    const applied: VideoSequenceV2 = { ...sequence, tracks: [...sequence.tracks, ...tracks] };

    // Act: suggest again with a different recipe.
    const second = await proposeFirstCutGraphics({
      firstCut: run.proposal,
      recipeId: "punchy-short-form",
      sequence: applied,
      projectId: run.proposal.projectId,
      revision: revision(run.proposal.projectRevision + 2),
    });

    // Assert
    if (!second.ok) throw new Error(second.error.kind);
    expect(second.value.items.length).toBeGreaterThan(0);
    const existing = clips.map((clip) => ({
      start: clip.timelineStart.value,
      end: clip.timelineStart.value + clip.duration.value,
    }));
    const added = second.value.commandGroup.commands.flatMap((command) =>
      command.type === "AddGraphicsClip" ? [command.graphicsClip] : [],
    );
    expect(added).toHaveLength(second.value.items.length);
    for (const clip of added) {
      const start = clip.timelineStart.value;
      const end = start + clip.duration.value;
      for (const span of existing) expect(start < span.end && span.start < end).toBe(false);
    }
  });

  it("leaves out every card when existing graphics cover the whole first cut", async () => {
    const { run, sequence } = await explainer();
    const rate = sequence.rate;
    const endFrames = Math.ceil(
      (run.proposal.endUs * rate.numerator) / (1_000_000 * rate.denominator),
    );
    const covered: VideoSequenceV2 = {
      ...sequence,
      tracks: [
        ...sequence.tracks,
        {
          id: testUuid(0xc0, 1),
          name: "Graphics",
          kind: "graphics",
          graphicsClips: [
            {
              graphicsVersion: 1,
              id: testUuid(0xc0, 2),
              timelineStart: createRationalTime(0, rate),
              duration: createRationalTime(endFrames, rate),
              fontKey: "segoe-ui-bold",
              layers: [],
            },
          ],
        },
      ],
    };
    for (const recipe of STYLE_RECIPES)
      expect(
        graphicsForFirstCut({ firstCut: run.proposal, recipe, sequence: covered }).items,
      ).toEqual([]);
  });

  it("reports an unknown recipe", async () => {
    const { run, sequence } = await explainer();
    const result = await proposeFirstCutGraphics({
      firstCut: run.proposal,
      recipeId: "neon",
      sequence,
      projectId: run.proposal.projectId,
      revision: revision(2),
    });
    expect(result).toEqual({ ok: false, error: { kind: "unknown_recipe", recipeId: "neon" } });
  });
});

/*
 * The shared agent-graphics fixture drives the Rust end-to-end test
 * (apps/desktop/src-tauri/src/video/tests/agent_graphics_e2e.rs): an agent-written description
 * for a 2 s, 1280x720, 30 fps sequence with one video clip and no graphics track. The Rust test
 * patches projectId, revision and sequenceId to its own project before submitting.
 */
describe("shared agent graphics proposal fixture", () => {
  it("matches the checked-in golden", () => {
    const rate = { numerator: 30, denominator: 1 } as const;
    const sequence: VideoSequenceV2 = {
      id: testUuid(0xb0, 3),
      name: "Sequence 1",
      rate,
      width: 1280,
      height: 720,
      audioSampleRate: 48_000,
      markers: [],
      tracks: [
        {
          id: testUuid(0xb0, 4),
          name: "Video 1",
          kind: "video",
          clips: [
            {
              id: testUuid(0xb0, 6),
              source: { kind: "asset", assetId: testUuid(0xb0, 1) },
              timelineStart: createRationalTime(0, rate),
              sourceIn: createRationalTime(0, rate),
              sourceOut: createRationalTime(60, rate),
              transform: {
                positionXPermille: 0,
                positionYPermille: 0,
                scaleXPermille: 1_000,
                scaleYPermille: 1_000,
                rotationMilliDegrees: 0,
                opacityPermille: 1_000,
              },
              gainMilliDecibels: 0,
            },
          ],
        },
      ],
    };
    let next = 0;
    const result = proposeRecipeGraphics({
      description: {
        schemaVersion: 1,
        recipeId: "punchy-short-form",
        items: [
          {
            kind: "card",
            id: "title",
            role: "title",
            text: "Agent graphics",
            atUs: 0,
            durationUs: 900_000,
          },
          {
            kind: "card",
            id: "lower-third",
            role: "lowerThird",
            text: "Proposed by an agent",
            atUs: 1_000_000,
            durationUs: 900_000,
          },
        ],
      },
      projectId: testUuid(0xb0, 100),
      revision: revision(1),
      sequence,
      producer: {
        id: "fixture-agent",
        version: "1",
        kind: "model",
        parameters: { recipeId: "punchy-short-form" },
      },
      newId: () => {
        next += 1;
        return testUuid(0xb1, next);
      },
    });
    if (!result.ok) throw new Error(result.error.kind);
    expectGolden(contractsPath("agent-graphics-proposal.json"), result.value);
  });
});
