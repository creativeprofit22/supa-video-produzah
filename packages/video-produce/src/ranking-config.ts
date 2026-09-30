import { z } from "zod";

import type { ScoreComponent } from "./asset-candidate.js";

/*
 * Versioned ranking configuration. Any change to weights or limits must bump
 * the version because the version is part of every proposal id.
 */

export const RANKING_CONFIG_VERSION = "ranking/1";

const unit = z.number().min(0).max(1);

export const rankingConfigV1Schema = z
  .object({
    version: z.string().min(1).max(64),
    weights: z
      .object({
        semantic: unit,
        transcript: unit,
        embedding: unit,
        rightsConfidence: unit,
        quality: unit,
        orientation: unit,
        durationFit: unit,
        diversity: unit,
      })
      .strict() satisfies z.ZodType<Record<ScoreComponent, number>>,
    /** Minimum of max(semantic, transcript, embedding) for a candidate to stay eligible. */
    minRelevance: unit,
    /** Higher bar for replacing podcast A-roll with a cutaway. */
    cutawayMinRelevance: unit,
    maxReusePerAsset: z.number().int().min(1).max(100),
    nearDuplicateOverlapRatio: z.number().gt(0).max(1),
    repetitionPenalty: unit,
    diversityWindow: z.number().int().min(0).max(20),
    alternativesPerBeat: z.number().int().min(0).max(10),
  })
  .strict();
export type RankingConfigV1 = z.infer<typeof rankingConfigV1Schema>;

export const DEFAULT_RANKING_CONFIG: RankingConfigV1 = Object.freeze({
  version: RANKING_CONFIG_VERSION,
  weights: Object.freeze({
    semantic: 0.35,
    transcript: 0.2,
    embedding: 0.15,
    rightsConfidence: 0.1,
    quality: 0.05,
    orientation: 0.05,
    durationFit: 0.05,
    diversity: 0.05,
  }),
  minRelevance: 0.2,
  cutawayMinRelevance: 0.3,
  maxReusePerAsset: 2,
  nearDuplicateOverlapRatio: 0.5,
  repetitionPenalty: 0.15,
  diversityWindow: 2,
  alternativesPerBeat: 3,
});
