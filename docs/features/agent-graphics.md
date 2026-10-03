# Agent graphics (Proposals panel)

Agents and rules can suggest on-screen graphics, such as a title card, lower thirds, an end card or short captions. They arrive as a **graphics proposal** in the Proposals panel, and nothing reaches the timeline until you apply it. Design: `docs/adr/0005-agent-graphics-proposals.md`.

## Using it

1. Apply a first cut in the Produce panel.
2. In the Proposals panel, pick a **Graphics style** and press **Suggest graphics**.
3. Each graphic gets its own row with its time span, and all rows start ticked. Untick the ones you don't want, then press **Apply N of M**. **Reject all** discards the proposal without changing anything.
4. **Restore to before** returns the project to the revision before the proposal was applied. Undo works too.

If the project has no unlocked graphics track, the proposal creates one called "Graphics". It is only created if at least one graphic is applied.

## Pipeline

1. **Agent graphics description** (`agentGraphicsDescriptionSchema`, `packages/video-contracts`). This is what an agent writes: items with text and timing, plus an optional `recipeId` and overrides. A model producer writes this JSON directly. The first-cut rule (`graphicsForFirstCut`, `packages/video-produce`) writes it from the applied first cut's narrative beats:
   - a title card at the start, using the first beat's opening words;
   - a lower third at each beat start that the pacing allows;
   - an end card ("Thanks for watching") when the recipe has one.
2. **Recipe** (`proposeRecipeGraphics`). Resolves the style recipe to plain style defaults. A missing recipe means `calm-explainer`. An unknown recipe is the error `unknown_recipe`.
3. **Compile** (`compileAgentGraphics`, `packages/video-project`). Places each item on the sequence:
   - centred title, boxed lower third in the lower-left, full-width end-card band and centred caption;
   - per-item overrides win over the recipe;
   - the entrance comes from the motion presets, and captions may use a word or letter reveal;
   - durations are clamped to the sequence end.

   Errors are typed: `invalid_description`, `out_of_sequence`, `overlap_limit`, `text_too_long` (more than 120 characters) and `too_large` (the proposal would exceed the native 1 MiB command-group or 2 MiB proposal limit).

4. **Review and apply.** The proposal is stored natively as pending. Apply sends only the ticked items. Native code accepts them only if they were offered and their commands are byte-identical to the offered ones.

## Style recipes

| Recipe                   | Font          | Entrances (title / lower third / end card) | Caption reveal | Card  | Min gap | Max per minute | Title / end card | Music beat snap |
| ------------------------ | ------------- | ------------------------------------------ | -------------- | ----- | ------- | -------------- | ---------------- | --------------- |
| Punchy short-form        | Verdana Bold  | slam / pop / slam                          | word           | 1.5 s | 1 s     | 12             | yes / yes        | yes             |
| Calm explainer (default) | Segoe UI Bold | tiltIn / tiltIn / pop                      | none           | 3 s   | 4 s     | 6              | yes / yes        | no              |
| Retro                    | Georgia Bold  | rockSlide / cursorDrag / rockSlide         | letter         | 2.5 s | 2.5 s   | 8              | yes / no         | yes             |

Recipes allow at most one graphic on screen at a time. Music beat snapping moves a graphic onto a detected music beat within 250 ms. The panel passes the sequence's detected beats to the recipe rule; with no detected beats, graphics stay on narrative beat starts.

## Determinism

Ids come from `derivedUuid`, seeded with the canonical description, project id, revision id and sequence id. The same first cut and recipe give byte-identical proposals. Golden files: `packages/video-produce/fixtures/v1/recipe-graphics/*.expected.json`, and the shared `packages/video-contracts/fixtures/agent-graphics-proposal.json`. The shared fixture drives the Rust end-to-end test `agent_graphics_e2e`: submit → apply → export through the graphics renderer → frame check → QC. Regenerate them with `UPDATE_RECIPE_GRAPHICS_GOLDEN=1`.

## Known gaps

- No live model producer is wired up yet. The model path is the same description schema run through `proposeRecipeGraphics`.
- "Suggest graphics" needs a first cut applied in this session. The first cut is not persisted across restarts.
- Layout estimates text width at 0.55 em. Export auto-fit and QC catch text that doesn't fit.
