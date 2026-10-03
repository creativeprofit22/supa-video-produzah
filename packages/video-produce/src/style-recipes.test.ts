import {
  agentGraphicsPresetSchema,
  graphicsTextSplitSchema,
  RENDER_CAPTION_FONT_FILES,
} from "@supa-video/contracts";
import { MOTION_PRESET_NAMES } from "@supa-video/project";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STYLE_RECIPE_ID,
  findStyleRecipe,
  STYLE_RECIPES,
  styleRecipeDefaults,
} from "./style-recipes.js";

describe("style recipes", () => {
  it("ships the three named recipes with the default among them", () => {
    expect(STYLE_RECIPES.map(({ id }) => id)).toEqual([
      "punchy-short-form",
      "calm-explainer",
      "retro",
    ]);
    expect(findStyleRecipe(DEFAULT_STYLE_RECIPE_ID)).toBeDefined();
    expect(findStyleRecipe("missing")).toBeUndefined();
  });

  it("keeps the agent preset list in step with the motion presets", () => {
    expect(agentGraphicsPresetSchema.options).toEqual([...MOTION_PRESET_NAMES]);
  });

  describe.each(STYLE_RECIPES)("$id", (recipe) => {
    it("resolves fonts, presets and reveals to real enum members", () => {
      expect(Object.keys(RENDER_CAPTION_FONT_FILES)).toContain(recipe.fontKey);
      for (const preset of Object.values(recipe.presetByCardRole))
        expect(MOTION_PRESET_NAMES).toContain(preset);
      if (recipe.captionReveal !== null)
        expect(graphicsTextSplitSchema.safeParse(recipe.captionReveal).success).toBe(true);
      for (const colour of Object.values(recipe.palette)) expect(colour).toMatch(/^#[0-9A-F]{6}$/u);
    });

    it("has workable pacing", () => {
      const { pacing } = recipe;
      expect(Number.isSafeInteger(pacing.cardDurationUs) && pacing.cardDurationUs > 0).toBe(true);
      expect(Number.isSafeInteger(pacing.minGapUs) && pacing.minGapUs >= 0).toBe(true);
      expect(pacing.maxPerMinute).toBeGreaterThan(0);
    });

    it("is frozen", () => {
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.pacing)).toBe(true);
      expect(Object.isFrozen(recipe.palette)).toBe(true);
    });

    it("maps to plain style defaults", () => {
      expect(styleRecipeDefaults(recipe)).toEqual({
        fontKey: recipe.fontKey,
        palette: recipe.palette,
        presetByCardRole: recipe.presetByCardRole,
        captionReveal: recipe.captionReveal,
        defaultDurationUs: recipe.pacing.cardDurationUs,
        maxOverlapping: 1,
      });
    });
  });

  it("gives each recipe a distinct look", () => {
    const looks = new Set(
      STYLE_RECIPES.map(({ fontKey, palette }) => `${fontKey}${palette.accent}`),
    );
    expect(looks.size).toBe(STYLE_RECIPES.length);
  });
});
