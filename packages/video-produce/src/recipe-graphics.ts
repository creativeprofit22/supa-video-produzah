/**
 * The single entry point for agent- and rule-written graphics: resolve the description's style
 * recipe to plain defaults, then compile it into a graphics proposal for review.
 */
import type { ProjectRevisionDescriptorV2, VideoSequenceV2 } from "@supa-video/contracts";
import {
  type AgentGraphicsError,
  compileAgentGraphics,
  type CompileAgentGraphicsInput,
} from "@supa-video/project";

import type { Result } from "./result.js";
import { DEFAULT_STYLE_RECIPE_ID, findStyleRecipe, styleRecipeDefaults } from "./style-recipes.js";

export type RecipeGraphicsError =
  AgentGraphicsError | { readonly kind: "unknown_recipe"; readonly recipeId: string };

export type RecipeGraphicsProposal = Extract<
  ReturnType<typeof compileAgentGraphics>,
  { ok: true }
>["value"];

export interface ProposeRecipeGraphicsInput {
  /** Untrusted agent graphics description (from a model, a rule or a test). */
  readonly description: unknown;
  readonly projectId: string;
  readonly revision: ProjectRevisionDescriptorV2;
  readonly sequence: VideoSequenceV2;
  readonly producer: CompileAgentGraphicsInput["producer"];
  readonly newId: () => string;
}

function requestedRecipeId(description: unknown): unknown {
  if (typeof description !== "object" || description === null) return undefined;
  return (description as { readonly recipeId?: unknown }).recipeId;
}

export function proposeRecipeGraphics(
  input: ProposeRecipeGraphicsInput,
): Result<RecipeGraphicsProposal, RecipeGraphicsError> {
  const requested = requestedRecipeId(input.description);
  // A non-string recipeId is a description problem: compile with the default recipe so the
  // compiler reports it with its issue path.
  const recipeId = typeof requested === "string" ? requested : DEFAULT_STYLE_RECIPE_ID;
  const recipe = findStyleRecipe(recipeId);
  if (recipe === undefined) {
    if (recipeId === DEFAULT_STYLE_RECIPE_ID)
      throw new Error(`Default style recipe ${DEFAULT_STYLE_RECIPE_ID} is missing`);
    return { ok: false, error: { kind: "unknown_recipe", recipeId } };
  }
  return compileAgentGraphics({ ...input, defaults: styleRecipeDefaults(recipe) });
}
