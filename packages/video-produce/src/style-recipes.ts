/**
 * Style recipes: named, frozen bundles of fonts, colours, entrance presets and pacing that turn a
 * agent graphics description into a consistent look (see CONTEXT.md). A recipe resolves to plain
 * `GraphicsStyleDefaults` before compiling, so @supa-video/project never sees recipe ids
 * (docs/adr/0005-agent-graphics-proposals.md).
 */
import type {
  AgentGraphicsCardRole,
  GraphicsTextSplit,
  RenderCaptionFontKey,
} from "@supa-video/contracts";
import type { GraphicsStyleDefaults, MotionPresetName } from "@supa-video/project";

export interface StyleRecipePacing {
  /** How long each card stays on screen. */
  readonly cardDurationUs: number;
  /** Least space between the end of one graphic and the start of the next. */
  readonly minGapUs: number;
  /** Most graphics per minute of sequence, title and end card included. */
  readonly maxPerMinute: number;
  readonly titleCard: boolean;
  readonly endCard: boolean;
  /** Move each graphic's start onto the nearest music beat when the sequence has beats. */
  readonly snapToMusicBeats: boolean;
}

export interface StyleRecipe {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly fontKey: RenderCaptionFontKey;
  readonly palette: { readonly fg: string; readonly bg: string; readonly accent: string };
  readonly presetByCardRole: Readonly<Record<AgentGraphicsCardRole, MotionPresetName>>;
  readonly captionReveal: GraphicsTextSplit | null;
  readonly pacing: StyleRecipePacing;
}

export const DEFAULT_STYLE_RECIPE_ID = "calm-explainer";

function freezeRecipe(recipe: StyleRecipe): StyleRecipe {
  return Object.freeze({
    ...recipe,
    palette: Object.freeze({ ...recipe.palette }),
    presetByCardRole: Object.freeze({ ...recipe.presetByCardRole }),
    pacing: Object.freeze({ ...recipe.pacing }),
  });
}

/** Built-in recipes, in display order. */
export const STYLE_RECIPES: readonly StyleRecipe[] = Object.freeze([
  freezeRecipe({
    id: "punchy-short-form",
    name: "Punchy short-form",
    summary: "Bold type, hard-hitting entrances and fast pacing for vertical shorts.",
    fontKey: "verdana-bold",
    palette: { fg: "#FFFFFF", bg: "#111111", accent: "#FF2D55" },
    presetByCardRole: { title: "slam", lowerThird: "pop", endCard: "slam" },
    captionReveal: "word",
    pacing: {
      cardDurationUs: 1_500_000,
      minGapUs: 1_000_000,
      maxPerMinute: 12,
      titleCard: true,
      endCard: true,
      snapToMusicBeats: true,
    },
  }),
  freezeRecipe({
    id: "calm-explainer",
    name: "Calm explainer",
    summary: "Clean type, gentle entrances and generous spacing for tutorials.",
    fontKey: "segoe-ui-bold",
    palette: { fg: "#F5F5F5", bg: "#1E2A38", accent: "#4FC3F7" },
    presetByCardRole: { title: "tiltIn", lowerThird: "tiltIn", endCard: "pop" },
    captionReveal: null,
    pacing: {
      cardDurationUs: 3_000_000,
      minGapUs: 4_000_000,
      maxPerMinute: 6,
      titleCard: true,
      endCard: true,
      snapToMusicBeats: false,
    },
  }),
  freezeRecipe({
    id: "retro",
    name: "Retro",
    summary: "Serif type, warm colours and playful slide-ins.",
    fontKey: "georgia-bold",
    palette: { fg: "#FFF3D6", bg: "#5A2E1C", accent: "#F4A259" },
    presetByCardRole: { title: "rockSlide", lowerThird: "cursorDrag", endCard: "rockSlide" },
    captionReveal: "letter",
    pacing: {
      cardDurationUs: 2_500_000,
      minGapUs: 2_500_000,
      maxPerMinute: 8,
      titleCard: true,
      endCard: false,
      snapToMusicBeats: true,
    },
  }),
]);

export function findStyleRecipe(recipeId: string): StyleRecipe | undefined {
  return STYLE_RECIPES.find(({ id }) => id === recipeId);
}

/** At most one graphic on screen at a time; recipes space graphics out rather than stack them. */
export const RECIPE_MAX_OVERLAPPING = 1;

export function styleRecipeDefaults(recipe: StyleRecipe): GraphicsStyleDefaults {
  return {
    fontKey: recipe.fontKey,
    palette: recipe.palette,
    presetByCardRole: recipe.presetByCardRole,
    captionReveal: recipe.captionReveal,
    defaultDurationUs: recipe.pacing.cardDurationUs,
    maxOverlapping: RECIPE_MAX_OVERLAPPING,
  };
}
