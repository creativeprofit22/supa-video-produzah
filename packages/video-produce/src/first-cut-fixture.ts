import {
  acquisitionReceiptSchema,
  usePolicyProfileSchema,
  videoProjectStateV2Schema,
} from "@supa-video/contracts";
import { z } from "zod";

import { planBeatsForARollClip } from "./a-roll-beats.js";
import { buildAssetIndex, fixtureEmbeddingSource } from "./asset-index.js";
import { type CompiledFirstCut, compileFirstCut } from "./compile-first-cut.js";
import { type FirstCutProposal, planFirstCut } from "./first-cut-proposal.js";
import type { NarrativeBeat } from "./narrative-beat.js";
import { planBeatsFromScript } from "./plan-beats.js";
import { DEFAULT_RANKING_CONFIG } from "./ranking-config.js";
import type { Result } from "./result.js";

/*
 * Versioned first-cut fixtures: a project state, rights receipts, beat source
 * (script or A-roll transcript) and optional fixture embeddings. Running a
 * fixture plans a proposal and compiles it with no overrides.
 */

export const FIRST_CUT_FIXTURE_VERSION = 1;

const uuid = z.uuid();
const vector = z.array(z.number().finite()).min(1).max(4096);
const word = z
  .object({
    text: z.string().min(1).max(512),
    sourceStartUs: z.number().int().nonnegative(),
    sourceEndUs: z.number().int().nonnegative(),
  })
  .strict();

export const firstCutFixtureSchema = z
  .object({
    fixtureVersion: z.literal(FIRST_CUT_FIXTURE_VERSION),
    name: z.string().min(1).max(128),
    projectId: uuid,
    projectRevision: z.number().int().nonnegative(),
    nowMs: z.number().int().nonnegative(),
    intendedUse: usePolicyProfileSchema,
    language: z.string().min(2).max(35),
    state: videoProjectStateV2Schema,
    receipts: z.array(acquisitionReceiptSchema).max(1000),
    tags: z.record(z.string(), z.array(z.string().min(1).max(128)).max(64)),
    transcripts: z
      .array(
        z
          .object({
            assetId: uuid,
            language: z.string().min(2).max(35),
            words: z.array(word).max(100_000),
          })
          .strict(),
      )
      .max(1000),
    embeddings: z
      .object({
        modelId: z.string().min(1).max(128),
        modelVersion: z.string().min(1).max(64),
        content: z.record(z.string(), vector),
        text: z.record(z.string(), vector),
        clusters: z.record(z.string(), z.string().min(1).max(128)),
      })
      .strict()
      .nullable(),
    source: z.discriminatedUnion("workflow", [
      z
        .object({
          workflow: z.literal("explainer"),
          script: z.string().min(1).max(100_000),
          wordsPerMinute: z.number().int().min(60).max(400),
        })
        .strict(),
      z.object({ workflow: z.literal("podcast"), aRollClipId: uuid }).strict(),
    ]),
  })
  .strict();
export type FirstCutFixture = z.infer<typeof firstCutFixtureSchema>;

export interface FirstCutFixtureRun {
  readonly beats: readonly NarrativeBeat[];
  readonly proposal: FirstCutProposal;
  readonly compiled: CompiledFirstCut;
}

export type FirstCutFixtureError =
  | { readonly code: "invalid-fixture"; readonly message: string }
  | { readonly code: "beats"; readonly message: string }
  | { readonly code: "plan"; readonly message: string }
  | { readonly code: "compile"; readonly message: string };

function fixtureBeats(fixture: FirstCutFixture): Result<NarrativeBeat[], FirstCutFixtureError> {
  if (fixture.source.workflow === "explainer") {
    const result = planBeatsFromScript(fixture.source.script, {
      language: fixture.language,
      wordsPerMinute: fixture.source.wordsPerMinute,
    });
    return result.ok ? result : { ok: false, error: { code: "beats", message: result.error.code } };
  }
  const clipId = fixture.source.aRollClipId;
  const clip = fixture.state.sequences
    .flatMap((sequence) => sequence.tracks)
    .flatMap((track) => (track.kind === "caption" ? [] : track.clips))
    .find((item) => item.id === clipId);
  const assetId = clip?.source.kind === "asset" ? clip.source.assetId : null;
  const transcript = fixture.transcripts.find((item) => item.assetId === assetId);
  const result = planBeatsForARollClip(
    fixture.state,
    clipId,
    transcript?.words ?? [],
    transcript?.language ?? fixture.language,
  );
  return result.ok ? result : { ok: false, error: { code: "beats", message: result.error.code } };
}

export async function runFirstCutFixture(
  input: unknown,
): Promise<Result<FirstCutFixtureRun, FirstCutFixtureError>> {
  const parsed = firstCutFixtureSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "invalid-fixture", message: parsed.error.issues[0]?.message ?? "invalid" },
    };
  }
  const fixture = parsed.data;
  const beats = fixtureBeats(fixture);
  if (!beats.ok) return beats;
  const embeddings =
    fixture.embeddings === null ? null : fixtureEmbeddingSource(fixture.embeddings);
  const index = buildAssetIndex({
    assets: fixture.state.assets,
    receipts: fixture.receipts,
    tags: fixture.tags,
    transcripts: fixture.transcripts,
    embeddings,
  });
  const planned = await planFirstCut({
    projectId: fixture.projectId,
    projectRevision: fixture.projectRevision,
    workflow: fixture.source.workflow,
    beats: beats.value,
    index,
    receipts: fixture.receipts,
    intendedUse: fixture.intendedUse,
    nowMs: fixture.nowMs,
    config: DEFAULT_RANKING_CONFIG,
    embeddings,
  });
  if (!planned.ok) return { ok: false, error: { code: "plan", message: planned.error.code } };
  const sequence = fixture.state.sequences.find(
    (item) => item.id === fixture.state.activeSequenceId,
  );
  if (sequence === undefined) {
    return { ok: false, error: { code: "compile", message: "no active sequence" } };
  }
  const compiled = await compileFirstCut({
    proposal: planned.value,
    overrides: {},
    projectId: fixture.projectId,
    revision: fixture.projectRevision,
    sequence,
    assets: fixture.state.assets,
  });
  if (!compiled.ok) return { ok: false, error: { code: "compile", message: compiled.error.code } };
  return {
    ok: true,
    value: { beats: beats.value, proposal: planned.value, compiled: compiled.value },
  };
}
