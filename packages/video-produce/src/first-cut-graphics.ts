/**
 * Recipe graphics for a first cut: a rule producer that writes an agent graphics description (title card,
 * lower thirds on beat starts, end card) under a style recipe's pacing limits, then compiles it
 * through `proposeRecipeGraphics` like any agent-written description.
 */
import {
  type AgentGraphicsDescription,
  type AgentGraphicsItem,
  isTrackHidden,
  type ProducerProvenanceWire,
  type ProjectRevisionDescriptorV2,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { derivedUuid, sequenceEndFrames } from "@supa-video/project";

import { canonicalJson } from "./canonical.js";
import type { FirstCutProposal } from "./first-cut-proposal.js";
import type { NarrativeBeat } from "./narrative-beat.js";
import {
  proposeRecipeGraphics,
  type RecipeGraphicsError,
  type RecipeGraphicsProposal,
} from "./recipe-graphics.js";
import type { Result } from "./result.js";
import { findStyleRecipe, type StyleRecipe } from "./style-recipes.js";

export const RECIPE_GRAPHICS_PRODUCER_ID = "recipe-graphics";
export const RECIPE_GRAPHICS_PRODUCER_VERSION = "1";
export const DEFAULT_END_CARD_TEXT = "Thanks for watching";
/** How far a graphic may move to land on a music beat. */
export const MUSIC_BEAT_SNAP_TOLERANCE_US = 250_000;
const LOWER_THIRD_MAX_WORDS = 8;
const LOWER_THIRD_MAX_CHARACTERS = 60;

/** The parts of a first cut the graphics rule reads: placed narrative beats on the timeline. */
export interface FirstCutBeats {
  readonly startUs: FirstCutProposal["startUs"];
  readonly endUs: FirstCutProposal["endUs"];
  readonly beats: readonly {
    readonly beat: Pick<NarrativeBeat, "order" | "text" | "startUs">;
  }[];
}

export interface GraphicsForFirstCutInput {
  readonly firstCut: FirstCutBeats;
  readonly recipe: StyleRecipe;
  readonly sequence: VideoSequenceV2;
  /** Sorted timeline microseconds of music beats, if the sequence has music. */
  readonly musicBeatsUs?: readonly number[];
  /** Title card text; defaults to the first beat's opening words. */
  readonly title?: string;
  readonly endCardText?: string;
}

function shortText(text: string): string {
  const words = text.trim().split(/\s+/u).slice(0, LOWER_THIRD_MAX_WORDS).join(" ");
  const characters = Array.from(words);
  return characters.length <= LOWER_THIRD_MAX_CHARACTERS
    ? words
    : `${characters
        .slice(0, LOWER_THIRD_MAX_CHARACTERS - 1)
        .join("")
        .trimEnd()}…`;
}

function snapped(atUs: number, musicBeatsUs: readonly number[]): number {
  let best = atUs;
  let bestDistance = MUSIC_BEAT_SNAP_TOLERANCE_US + 1;
  for (const beat of musicBeatsUs) {
    const distance = Math.abs(beat - atUs);
    if (beat >= 0 && distance < bestDistance) {
      best = beat;
      bestDistance = distance;
    }
  }
  return best;
}

function sequenceEndUs(sequence: VideoSequenceV2): number {
  return Math.floor(
    (sequenceEndFrames(sequence) * 1_000_000 * sequence.rate.denominator) / sequence.rate.numerator,
  );
}

interface OccupiedSpan {
  readonly startUs: number;
  readonly endUs: number;
}

/**
 * Spans already taken by graphics clips on visible graphics tracks — the clips the graphics
 * compiler checks new items against. Rounded outwards so a free slot is free in frames too.
 */
function occupiedSpans(sequence: VideoSequenceV2): OccupiedSpan[] {
  const toUs = (frames: number): number =>
    (frames * 1_000_000 * sequence.rate.denominator) / sequence.rate.numerator;
  return sequence.tracks
    .flatMap((track) =>
      track.kind === "graphics" && !isTrackHidden(track)
        ? track.graphicsClips.map((clip) => ({
            startUs: Math.floor(toUs(clip.timelineStart.value)),
            endUs: Math.ceil(toUs(clip.timelineStart.value + clip.duration.value)),
          }))
        : [],
    )
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
}

/** Whether [atUs, atUs + durationUs) keeps at least `gapUs` clear of every occupied span. */
function isFree(
  atUs: number,
  durationUs: number,
  gapUs: number,
  occupied: readonly OccupiedSpan[],
): boolean {
  return occupied.every(
    (span) => span.endUs + gapUs <= atUs || atUs + durationUs + gapUs <= span.startUs,
  );
}

/**
 * Writes an agent graphics description for a first cut under the recipe's pacing limits. Graphics
 * already on visible graphics tracks block their spans (plus the recipe's gap): cards that would
 * land there are left out, so the result may be empty when every slot is taken.
 */
export function graphicsForFirstCut(input: GraphicsForFirstCutInput): AgentGraphicsDescription {
  const { firstCut, recipe, sequence } = input;
  const { pacing } = recipe;
  const occupied = occupiedSpans(sequence);
  const startUs = Math.max(0, firstCut.startUs);
  const endUs = Math.min(firstCut.endUs, sequenceEndUs(sequence));
  const beats = [...firstCut.beats]
    .map(({ beat }) => beat)
    .filter((beat) => beat.startUs >= startUs && beat.startUs < endUs)
    .sort((left, right) => left.startUs - right.startUs || left.order - right.order);
  const musicBeats = pacing.snapToMusicBeats ? (input.musicBeatsUs ?? []) : [];
  const duration = pacing.cardDurationUs;
  const budget = Math.max(1, Math.floor((pacing.maxPerMinute * (endUs - startUs)) / 60_000_000));
  if (endUs - startUs < duration) return { schemaVersion: 1, recipeId: recipe.id, items: [] };

  const items: AgentGraphicsItem[] = [];
  let lastEndUs = Number.NEGATIVE_INFINITY;
  if (pacing.titleCard && isFree(startUs, duration, pacing.minGapUs, occupied)) {
    const firstText = beats[0]?.text ?? recipe.name;
    items.push({
      kind: "card",
      id: "title",
      role: "title",
      text: shortText(input.title ?? firstText),
      atUs: startUs,
      durationUs: duration,
    });
    lastEndUs = startUs + duration;
  }
  const endCardAtUs = endUs - duration;
  const reserveEnd =
    pacing.endCard &&
    endCardAtUs >= lastEndUs + pacing.minGapUs &&
    items.length < budget &&
    isFree(endCardAtUs, duration, pacing.minGapUs, occupied)
      ? 1
      : 0;
  const lowerThirdLimitUs = reserveEnd === 1 ? endCardAtUs - pacing.minGapUs : endUs;
  for (const beat of beats) {
    if (items.length + reserveEnd >= budget) break;
    const atUs = snapped(beat.startUs, musicBeats);
    if (
      atUs < lastEndUs + pacing.minGapUs ||
      atUs + duration > lowerThirdLimitUs ||
      !isFree(atUs, duration, pacing.minGapUs, occupied)
    )
      continue;
    items.push({
      kind: "card",
      id: `beat-${beat.order + 1}`,
      role: "lowerThird",
      text: shortText(beat.text),
      atUs,
      durationUs: duration,
    });
    lastEndUs = atUs + duration;
  }
  if (reserveEnd === 1) {
    items.push({
      kind: "card",
      id: "end-card",
      role: "endCard",
      text: shortText(input.endCardText ?? DEFAULT_END_CARD_TEXT),
      atUs: endCardAtUs,
      durationUs: duration,
    });
  }
  return { schemaVersion: 1, recipeId: recipe.id, items };
}

export function recipeGraphicsProducer(recipeId: string): ProducerProvenanceWire {
  return {
    id: RECIPE_GRAPHICS_PRODUCER_ID,
    version: RECIPE_GRAPHICS_PRODUCER_VERSION,
    kind: "rule",
    parameters: { recipeId },
  };
}

export interface ProposeFirstCutGraphicsInput extends Omit<GraphicsForFirstCutInput, "recipe"> {
  readonly recipeId: string;
  readonly projectId: string;
  readonly revision: ProjectRevisionDescriptorV2;
}

/** Deterministic ids derived from everything the proposal depends on. */
async function idSource(seedValue: unknown, count: number): Promise<() => string> {
  const seed = new TextEncoder().encode(canonicalJson(seedValue));
  const ids = await Promise.all(
    Array.from({ length: count }, (_, index) => derivedUuid(seed, `recipe-graphics:${index}`)),
  );
  let next = 0;
  return () => {
    const id = ids[next];
    next += 1;
    if (id === undefined) throw new Error("Recipe graphics ran out of precomputed ids");
    return id;
  };
}

/** The rule producer: first cut + recipe → reviewable graphics proposal. */
export async function proposeFirstCutGraphics(
  input: ProposeFirstCutGraphicsInput,
): Promise<Result<RecipeGraphicsProposal, RecipeGraphicsError>> {
  const recipe = findStyleRecipe(input.recipeId);
  if (recipe === undefined)
    return { ok: false, error: { kind: "unknown_recipe", recipeId: input.recipeId } };
  const description = graphicsForFirstCut({ ...input, recipe });
  // Proposal, group, optional track + insert command, then a clip and a command per item.
  const newId = await idSource(
    {
      description,
      projectId: input.projectId,
      revisionId: input.revision.id,
      sequenceId: input.sequence.id,
    },
    4 + description.items.length * 2,
  );
  return proposeRecipeGraphics({
    description,
    projectId: input.projectId,
    revision: input.revision,
    sequence: input.sequence,
    producer: recipeGraphicsProducer(recipe.id),
    newId,
  });
}
