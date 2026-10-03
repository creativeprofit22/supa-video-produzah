import {
  createRationalTime,
  type ProjectRevisionDescriptorV2,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { compileAgentGraphics } from "@supa-video/project";
import { describe, expect, it } from "vitest";

import { proposeRecipeGraphics, type ProposeRecipeGraphicsInput } from "./recipe-graphics.js";
import { findStyleRecipe, styleRecipeDefaults } from "./style-recipes.js";
import { TEST_PROJECT_ID, testUuid } from "./test-support.js";

const rate = { numerator: 30, denominator: 1 } as const;

function sequence(seconds: number): VideoSequenceV2 {
  return {
    id: testUuid(0x90, 1),
    name: "Sequence",
    rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [],
    tracks: [
      {
        id: testUuid(0x90, 2),
        name: "Video",
        kind: "video",
        clips: [
          {
            id: testUuid(0x90, 3),
            source: { kind: "asset", assetId: testUuid(0x90, 4) },
            timelineStart: createRationalTime(0, rate),
            sourceIn: createRationalTime(0, rate),
            sourceOut: createRationalTime(seconds * 30, rate),
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
}

const revision: ProjectRevisionDescriptorV2 = {
  number: 4,
  id: testUuid(0x91, 4),
  parentId: testUuid(0x91, 3),
  committedAt: "2026-10-03T12:00:00.000Z",
  operationId: testUuid(0x92, 4),
  stateHash: "cd".repeat(32),
};

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return testUuid(0x93, next);
  };
}

function input(description: unknown): ProposeRecipeGraphicsInput {
  return {
    description,
    projectId: TEST_PROJECT_ID,
    revision,
    sequence: sequence(20),
    producer: { id: "test-agent", version: "1", kind: "model", parameters: {} },
    newId: ids(),
  };
}

const title = { kind: "card", id: "title", role: "title", text: "Hello", atUs: 0 } as const;

describe("proposeRecipeGraphics", () => {
  it.each(["punchy-short-form", "calm-explainer", "retro"])(
    "applies the %s recipe's look",
    (recipeId) => {
      const result = proposeRecipeGraphics(input({ schemaVersion: 1, recipeId, items: [title] }));
      if (!result.ok) throw new Error(result.error.kind);
      const recipe = findStyleRecipe(recipeId);
      const add = result.value.commandGroup.commands.find(({ type }) => type === "AddGraphicsClip");
      if (add?.type !== "AddGraphicsClip" || recipe === undefined) throw new Error("missing");
      expect(add.graphicsClip.fontKey).toBe(recipe.fontKey);
      expect(add.graphicsClip.duration.value).toBe((recipe.pacing.cardDurationUs * 30) / 1_000_000);
      expect(result.value.description.recipeId).toBe(recipeId);
    },
  );

  it("uses the calm explainer recipe when none is named", () => {
    const description = { schemaVersion: 1, items: [title] };
    const viaRecipe = proposeRecipeGraphics(input(description));
    const recipe = findStyleRecipe("calm-explainer");
    if (recipe === undefined) throw new Error("missing");
    const direct = compileAgentGraphics({
      ...input(description),
      defaults: styleRecipeDefaults(recipe),
    });
    expect(viaRecipe).toEqual(direct);
  });

  it("reports an unknown recipe without compiling", () => {
    expect(
      proposeRecipeGraphics(input({ schemaVersion: 1, recipeId: "neon", items: [title] })),
    ).toEqual({ ok: false, error: { kind: "unknown_recipe", recipeId: "neon" } });
  });

  it.each([
    ["invalid_description", { schemaVersion: 1, recipeId: 7, items: [title] }],
    ["invalid_description", null],
    ["out_of_sequence", { schemaVersion: 1, items: [{ ...title, atUs: 30_000_000 }] }],
    ["overlap_limit", { schemaVersion: 1, items: [title, { ...title, id: "again", atUs: 1 }] }],
    ["text_too_long", { schemaVersion: 1, items: [{ ...title, text: "y".repeat(200) }] }],
  ])("passes the compiler's %s error through unchanged", (kind, description) => {
    const viaRecipe = proposeRecipeGraphics(input(description));
    expect(viaRecipe.ok).toBe(false);
    if (!viaRecipe.ok) expect(viaRecipe.error.kind).toBe(kind);
    const recipe = findStyleRecipe("calm-explainer");
    if (recipe === undefined) throw new Error("missing");
    expect(viaRecipe).toEqual(
      compileAgentGraphics({ ...input(description), defaults: styleRecipeDefaults(recipe) }),
    );
  });
});
