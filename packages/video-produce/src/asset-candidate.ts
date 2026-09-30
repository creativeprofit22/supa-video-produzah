import type { AssetProvenance } from "./asset-index.js";

/*
 * A ranked media option for one narrative beat, and why it scored what it did.
 * Candidates only ever come from assets that passed the rights hard filter.
 */

export interface AssetCandidate {
  readonly assetId: string;
  readonly displayName: string;
  readonly identityKey: string;
  readonly provenance: AssetProvenance;
  readonly receiptId: string | null;
  readonly providerId: string;
  readonly visualClusterId: string | null;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

export const SCORE_COMPONENTS = [
  "semantic",
  "transcript",
  "embedding",
  "rightsConfidence",
  "quality",
  "orientation",
  "durationFit",
  "diversity",
] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export interface CandidateScore {
  /** Raw component values in [0, 1]. */
  readonly components: Readonly<Record<ScoreComponent, number>>;
  readonly repetitionPenalty: number;
  readonly total: number;
  /** Human-readable reasons, one per contributing factor. */
  readonly explanation: readonly string[];
}

export interface RankedCandidate {
  readonly candidate: AssetCandidate;
  readonly score: CandidateScore;
}

export type CandidateRejectionReason =
  | "rights"
  | "too-short"
  | "must-show-missing"
  | "must-not-show"
  | "low-relevance"
  | "reuse-limit"
  | "near-duplicate"
  | "a-roll-source";

export interface RejectedCandidate {
  readonly assetId: string;
  readonly displayName: string;
  readonly reason: CandidateRejectionReason;
  readonly detail: string;
}

/** Fixed precision so scores serialize identically on every run. */
export function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
