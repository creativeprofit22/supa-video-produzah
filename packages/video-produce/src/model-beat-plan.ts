import { z } from "zod";

import { canonicalJson, stableShortHash } from "./canonical.js";
import {
  NARRATIVE_BEAT_SCHEMA_VERSION,
  type NarrativeBeat,
  narrativeBeatSchema,
  orientationPreferenceSchema,
  shotIntentSchema,
} from "./narrative-beat.js";
import type { Result } from "./result.js";

/*
 * Boundary for model-proposed beat plans. Model output is untrusted: the shape
 * is validated strictly, timestamps are clamped to the plan, zero-length and
 * overlapping spans are repaired or dropped, gaps are filled into the previous
 * beat (a leading gap into the first) so the result spans the whole plan
 * contiguously, and every repair is reported.
 */

const term = z.string().trim().min(1).max(128);
const modelIntentSchema = shotIntentSchema.refine(
  (intent) => intent.kind !== "a-roll",
  "Model plans cannot reference A-roll clips",
);

export const modelBeatPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .max(35),
    beats: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(4096),
            startUs: z.number().int().safe(),
            endUs: z.number().int().safe(),
            mustShow: z.array(term).max(16).optional(),
            mustNotShow: z.array(term).max(16).optional(),
            orientation: orientationPreferenceSchema.optional(),
            intent: modelIntentSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ModelBeatPlan = z.infer<typeof modelBeatPlanSchema>;

export type ModelBeatRepair =
  | { readonly index: number; readonly kind: "clamped-start"; readonly fromUs: number }
  | { readonly index: number; readonly kind: "clamped-end"; readonly fromUs: number }
  | { readonly index: number; readonly kind: "trimmed-overlap"; readonly fromUs: number }
  | { readonly index: number; readonly kind: "dropped-empty" }
  | {
      readonly index: number;
      readonly kind: "filled-gap";
      readonly fromUs: number;
      readonly toUs: number;
    };

export type ModelBeatPlanError =
  | { readonly code: "invalid-shape"; readonly issues: readonly string[] }
  | { readonly code: "invalid-plan-duration" }
  | { readonly code: "no-usable-beats" };

export interface AcceptedModelBeatPlan {
  readonly beats: readonly NarrativeBeat[];
  readonly repairs: readonly ModelBeatRepair[];
}

export function acceptModelBeatPlan(
  input: unknown,
  planDurationUs: number,
): Result<AcceptedModelBeatPlan, ModelBeatPlanError> {
  if (!Number.isSafeInteger(planDurationUs) || planDurationUs <= 0) {
    return { ok: false, error: { code: "invalid-plan-duration" } };
  }
  const parsed = modelBeatPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid-shape",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    };
  }
  const repairs: ModelBeatRepair[] = [];
  const ordered = parsed.data.beats
    .map((beat, index) => ({ beat, index }))
    .sort((left, right) => left.beat.startUs - right.beat.startUs || left.index - right.index);
  const spans: {
    beat: ModelBeatPlan["beats"][number];
    index: number;
    startUs: number;
    endUs: number;
  }[] = [];
  let previousEnd = 0;
  for (const { beat, index } of ordered) {
    let startUs = Math.min(Math.max(beat.startUs, 0), planDurationUs);
    if (startUs !== beat.startUs)
      repairs.push({ index, kind: "clamped-start", fromUs: beat.startUs });
    const endUs = Math.min(Math.max(beat.endUs, 0), planDurationUs);
    if (endUs !== beat.endUs) repairs.push({ index, kind: "clamped-end", fromUs: beat.endUs });
    if (startUs < previousEnd) {
      repairs.push({ index, kind: "trimmed-overlap", fromUs: startUs });
      startUs = previousEnd;
    }
    if (endUs <= startUs) {
      repairs.push({ index, kind: "dropped-empty" });
      continue;
    }
    spans.push({ beat, index, startUs, endUs });
    previousEnd = endUs;
  }
  const first = spans[0];
  if (first === undefined) return { ok: false, error: { code: "no-usable-beats" } };
  // Planning needs contiguous beats covering [0, planDurationUs]; silence
  // belongs to the preceding beat, matching planBeatsFromTranscript.
  if (first.startUs > 0) {
    repairs.push({ index: first.index, kind: "filled-gap", fromUs: first.startUs, toUs: 0 });
    first.startUs = 0;
  }
  for (const [position, span] of spans.entries()) {
    const targetEnd = spans[position + 1]?.startUs ?? planDurationUs;
    if (span.endUs !== targetEnd) {
      repairs.push({ index: span.index, kind: "filled-gap", fromUs: span.endUs, toUs: targetEnd });
      span.endUs = targetEnd;
    }
  }
  const beats = spans.map(({ beat, startUs, endUs }, order): NarrativeBeat => {
    const body = {
      schemaVersion: NARRATIVE_BEAT_SCHEMA_VERSION,
      order,
      text: beat.text,
      language: parsed.data.language,
      startUs,
      endUs,
      mustShow: [...(beat.mustShow ?? [])].sort(),
      mustNotShow: [...(beat.mustNotShow ?? [])].sort(),
      orientation: beat.orientation ?? "any",
      intent: beat.intent ?? { kind: "owned-footage" },
    };
    return narrativeBeatSchema.parse({
      ...body,
      id: `beat-${stableShortHash(canonicalJson(body))}`,
    });
  });
  return { ok: true, value: { beats, repairs } };
}
