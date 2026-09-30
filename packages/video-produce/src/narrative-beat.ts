import { z } from "zod";

/*
 * Narrative beats and shot intents (see CONTEXT.md). Beats are timed in
 * microseconds on the first-cut plan timeline, which starts at zero for an
 * explainer and at the A-roll clip's timeline position for a podcast.
 */

export const NARRATIVE_BEAT_SCHEMA_VERSION = 1;

export const orientationPreferenceSchema = z.enum(["any", "landscape", "portrait", "square"]);
export type OrientationPreference = z.infer<typeof orientationPreferenceSchema>;

const microseconds = z.number().int().safe().nonnegative();
const term = z.string().trim().min(1).max(128);

export const shotIntentKindSchema = z.enum([
  "owned-footage",
  "a-roll",
  "title",
  "lower-third",
  "map",
  "chart",
  "screenshot",
  "still-motion",
]);
export type ShotIntentKind = z.infer<typeof shotIntentKindSchema>;

export const shotIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owned-footage") }).strict(),
  z
    .object({
      kind: z.literal("a-roll"),
      assetId: z.uuid(),
      clipId: z.uuid(),
    })
    .strict(),
  z.object({ kind: z.literal("title"), text: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("lower-third"), text: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("map"), subject: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("chart"), subject: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("screenshot"), subject: z.string().trim().min(1).max(512) }).strict(),
  z
    .object({ kind: z.literal("still-motion"), subject: z.string().trim().min(1).max(512) })
    .strict(),
]);
export type ShotIntent = z.infer<typeof shotIntentSchema>;

export const narrativeBeatSchema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_BEAT_SCHEMA_VERSION),
    id: z.string().regex(/^beat-[0-9a-f]{16}$/),
    order: z.number().int().safe().nonnegative(),
    text: z.string().trim().min(1).max(4096),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .max(35),
    startUs: microseconds,
    endUs: microseconds,
    mustShow: z.array(term).max(16).readonly(),
    mustNotShow: z.array(term).max(16).readonly(),
    orientation: orientationPreferenceSchema,
    intent: shotIntentSchema,
  })
  .strict()
  .refine((beat) => beat.endUs > beat.startUs, "Beat range must be nonempty");
export type NarrativeBeat = z.infer<typeof narrativeBeatSchema>;

export function beatDurationUs(beat: Pick<NarrativeBeat, "startUs" | "endUs">): number {
  return beat.endUs - beat.startUs;
}

/** Longest label in UTF-16 code units; leaves room for marker prefixes under the 512 limit. */
export const BEAT_LABEL_MAX_LENGTH = 480;

/** Short human label used for markers and review rows. */
export function beatLabel(beat: Pick<NarrativeBeat, "order" | "text">): string {
  const words = beat.text.split(/\s+/u).slice(0, 8).join(" ");
  const label = `Beat ${beat.order + 1}: ${words}`;
  if (label.length <= BEAT_LABEL_MAX_LENGTH) return label;
  let end = BEAT_LABEL_MAX_LENGTH - 1;
  // Never split a surrogate pair.
  const last = label.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${label.slice(0, end)}…`;
}
