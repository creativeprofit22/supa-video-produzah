import {
  type AssetCandidate,
  type CandidateScore,
  type RankedCandidate,
  type RejectedCandidate,
  SCORE_COMPONENTS,
  type ScoreComponent,
  roundScore,
} from "./asset-candidate.js";
import type { LocalAssetIndexEntry } from "./asset-index.js";
import { type NarrativeBeat, beatDurationUs } from "./narrative-beat.js";
import type { RankingConfigV1 } from "./ranking-config.js";
import type { RightsDecision } from "./rights-filter.js";
import { normalizeTokens } from "./text-normalize.js";

/*
 * Pure per-beat candidate scoring. Hard constraints (rights, must-show,
 * must-not-show, reuse, near-duplicates, length) reject before scoring; soft
 * preferences (orientation, diversity, repetition) only move the score.
 * Embedding similarity is one additive signal; it never satisfies must-show
 * and never substitutes for rights.
 */

export interface PriorSelection {
  readonly identityKey: string;
  readonly providerId: string;
  readonly visualClusterId: string | null;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

export interface RankBeatInput {
  readonly beat: NarrativeBeat;
  readonly entries: readonly LocalAssetIndexEntry[];
  readonly rights: ReadonlyMap<string, RightsDecision>;
  readonly config: RankingConfigV1;
  /** Selections for earlier beats, in beat order. */
  readonly prior: readonly PriorSelection[];
  readonly beatVector: readonly number[] | null;
  /** Asset excluded as a cutaway (the podcast A-roll). */
  readonly excludedAssetId?: string | null;
  readonly minRelevance: number;
}

export interface RankBeatResult {
  readonly ranked: readonly RankedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
}

function overlapRatio(aIn: number, aOut: number, bIn: number, bOut: number): number {
  const overlap = Math.max(0, Math.min(aOut, bOut) - Math.max(aIn, bIn));
  return overlap / Math.max(1, Math.min(aOut - aIn, bOut - bIn));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    dot += value * other;
    leftNorm += value * value;
    rightNorm += other * other;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftNorm * rightNorm));
}

function matched(beatTokens: readonly string[], tokens: readonly string[]): string[] {
  const set = new Set(tokens);
  return beatTokens.filter((token) => set.has(token));
}

function lexicalScore(matches: number, beatTokens: number): number {
  return beatTokens === 0 ? 0 : Math.min(1, matches / Math.min(beatTokens, 3));
}

function quality(entry: LocalAssetIndexEntry): number {
  const shortSide = Math.min(entry.width, entry.height);
  const resolution = shortSide >= 1080 ? 1 : shortSide >= 720 ? 0.7 : 0.4;
  return resolution * (entry.variableFrameRate ? 0.8 : 1);
}

/**
 * Picks a source window: the first transcript mention of a beat token, then
 * the start, then right after each earlier use, skipping near-duplicates.
 */
function chooseWindow(
  entry: LocalAssetIndexEntry,
  beatTokens: readonly string[],
  durationUs: number,
  prior: readonly PriorSelection[],
  ratio: number,
): { readonly sourceInUs: number; readonly fromTranscript: boolean } | null {
  const tokenSet = new Set(beatTokens);
  const mention = entry.transcriptWords.find((word) => tokenSet.has(word.token));
  const uses = prior.filter((selection) => selection.identityKey === entry.identityKey);
  const starts = [
    ...(mention === undefined ? [] : [{ at: mention.startUs, fromTranscript: true }]),
    { at: 0, fromTranscript: false },
    ...uses.map((use) => ({ at: use.sourceOutUs, fromTranscript: false })),
  ];
  for (const start of starts) {
    const sourceInUs = Math.max(0, Math.min(start.at, entry.durationUs - durationUs));
    const sourceOutUs = sourceInUs + durationUs;
    const duplicate = uses.some(
      (use) => overlapRatio(sourceInUs, sourceOutUs, use.sourceInUs, use.sourceOutUs) >= ratio,
    );
    if (!duplicate) return { sourceInUs, fromTranscript: start.fromTranscript };
  }
  return null;
}

function reject(
  entry: LocalAssetIndexEntry,
  reason: RejectedCandidate["reason"],
  detail: string,
): RejectedCandidate {
  return { assetId: entry.assetId, displayName: entry.displayName, reason, detail };
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.score.total - left.score.total ||
    (left.candidate.assetId < right.candidate.assetId
      ? -1
      : left.candidate.assetId > right.candidate.assetId
        ? 1
        : 0) ||
    left.candidate.sourceInUs - right.candidate.sourceInUs
  );
}

export function rankCandidatesForBeat(input: RankBeatInput): RankBeatResult {
  const { beat, config } = input;
  const durationUs = beatDurationUs(beat);
  const beatTokens = normalizeTokens([beat.text, ...beat.mustShow].join(" "), beat.language);
  const mustShow = [
    ...new Set(beat.mustShow.flatMap((term) => normalizeTokens(term, beat.language))),
  ];
  const mustNotShow = [
    ...new Set(beat.mustNotShow.flatMap((term) => normalizeTokens(term, beat.language))),
  ];
  const recent = input.prior.slice(Math.max(0, input.prior.length - config.diversityWindow));
  const ranked: RankedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const entry of input.entries) {
    const decision = input.rights.get(entry.assetId);
    if (decision === undefined || !decision.eligible) {
      rejected.push(
        reject(
          entry,
          "rights",
          decision?.eligible === false
            ? `${decision.reason}: ${decision.message}`
            : "No rights decision.",
        ),
      );
      continue;
    }
    if (entry.assetId === input.excludedAssetId) {
      rejected.push(reject(entry, "a-roll-source", "This is the A-roll clip itself."));
      continue;
    }
    const allTokens = new Set([...entry.descriptorTokens, ...entry.transcriptTokens]);
    const forbidden = mustNotShow.filter((token) => allTokens.has(token));
    if (forbidden.length > 0) {
      rejected.push(
        reject(entry, "must-not-show", `Shows excluded term: ${forbidden.join(", ")}.`),
      );
      continue;
    }
    const missing = mustShow.filter((token) => !allTokens.has(token));
    if (missing.length > 0) {
      rejected.push(
        reject(entry, "must-show-missing", `Missing required term: ${missing.join(", ")}.`),
      );
      continue;
    }
    if (entry.durationUs < durationUs) {
      rejected.push(reject(entry, "too-short", "Shorter than the beat."));
      continue;
    }
    const uses = input.prior.filter((selection) => selection.identityKey === entry.identityKey);
    if (uses.length >= config.maxReusePerAsset) {
      rejected.push(
        reject(
          entry,
          "reuse-limit",
          `Already used ${uses.length} times (limit ${config.maxReusePerAsset}).`,
        ),
      );
      continue;
    }
    const descriptorMatches = matched(beatTokens, entry.descriptorTokens);
    const transcriptMatches = matched(beatTokens, entry.transcriptTokens);
    const semantic = lexicalScore(descriptorMatches.length, beatTokens.length);
    const transcript = lexicalScore(transcriptMatches.length, beatTokens.length);
    const embedding =
      input.beatVector === null || entry.embedding === null
        ? 0
        : cosine(input.beatVector, entry.embedding);
    const relevance = Math.max(semantic, transcript, embedding);
    if (relevance < input.minRelevance) {
      rejected.push(
        reject(
          entry,
          "low-relevance",
          `Relevance ${roundScore(relevance)} is below ${input.minRelevance}.`,
        ),
      );
      continue;
    }
    const window = chooseWindow(
      entry,
      beatTokens,
      durationUs,
      input.prior,
      config.nearDuplicateOverlapRatio,
    );
    if (window === null) {
      rejected.push(reject(entry, "near-duplicate", "Every usable range repeats an earlier shot."));
      continue;
    }
    const orientation =
      beat.orientation === "any" || beat.orientation === entry.orientation ? 1 : 0;
    const providerRepeats =
      entry.providerId !== "local" && recent.some((item) => item.providerId === entry.providerId);
    const clusterRepeats =
      entry.visualClusterId !== null &&
      recent.some((item) => item.visualClusterId === entry.visualClusterId);
    const identityRepeats = recent.some((item) => item.identityKey === entry.identityKey);
    const diversity =
      1 - 0.5 * Number(providerRepeats) - 0.5 * Number(clusterRepeats || identityRepeats);
    const components: Record<ScoreComponent, number> = {
      semantic: roundScore(semantic),
      transcript: roundScore(transcript),
      embedding: roundScore(embedding),
      rightsConfidence: decision.rightsConfidence,
      quality: roundScore(quality(entry)),
      orientation,
      durationFit: roundScore(durationUs / entry.durationUs),
      diversity: Math.max(0, diversity),
    };
    const repetitionPenalty = roundScore(config.repetitionPenalty * uses.length);
    const weighted = SCORE_COMPONENTS.reduce(
      (sum, key) => sum + config.weights[key] * components[key],
      0,
    );
    const explanation = [
      descriptorMatches.length > 0
        ? `Name/tags match: ${descriptorMatches.join(", ")}.`
        : "No name or tag match.",
      transcriptMatches.length > 0
        ? `Spoken words match: ${transcriptMatches.join(", ")}${window.fromTranscript ? " (starts at the first mention)" : ""}.`
        : null,
      embedding > 0
        ? `Visual similarity ${roundScore(embedding)} (ranking signal only; not rights or quality proof).`
        : null,
      decision.policyOutcome === "owned"
        ? "Owned media (preferred)."
        : `Acquired media, receipt ${decision.receiptId ?? "?"}; policy ${decision.policyOutcome}.`,
      orientation === 0
        ? `Orientation mismatch: wants ${beat.orientation}, clip is ${entry.orientation}.`
        : null,
      providerRepeats ? `Same provider as a recent shot (${entry.providerId}).` : null,
      clusterRepeats || identityRepeats ? "Visually similar to a recent shot." : null,
      uses.length > 0
        ? `Reused ${uses.length} time(s); repetition penalty ${repetitionPenalty}.`
        : null,
      mustShow.length > 0 ? `Shows required: ${mustShow.join(", ")}.` : null,
    ].filter((line): line is string => line !== null);
    const score: CandidateScore = {
      components,
      repetitionPenalty,
      total: roundScore(weighted - repetitionPenalty),
      explanation,
    };
    const candidate: AssetCandidate = {
      assetId: entry.assetId,
      displayName: entry.displayName,
      identityKey: entry.identityKey,
      provenance: entry.provenance,
      receiptId: decision.receiptId,
      providerId: entry.providerId,
      visualClusterId: entry.visualClusterId,
      sourceInUs: window.sourceInUs,
      sourceOutUs: window.sourceInUs + durationUs,
    };
    ranked.push({ candidate, score });
  }
  rejected.sort(
    (a, b) =>
      (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  return { ranked: ranked.sort(compareRanked), rejected };
}
