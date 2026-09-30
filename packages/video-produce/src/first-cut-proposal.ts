import type { AcquisitionReceipt, UsePolicyProfile } from "@supa-video/contracts";

import type { RankedCandidate, RejectedCandidate } from "./asset-candidate.js";
import type { EmbeddingSource, LocalAssetIndex } from "./asset-index.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { type NarrativeBeat, type ShotIntentKind, beatDurationUs } from "./narrative-beat.js";
import { type PriorSelection, rankCandidatesForBeat } from "./rank-candidates.js";
import type { RankingConfigV1 } from "./ranking-config.js";
import { type RightsDecision, filterByRights } from "./rights-filter.js";
import { normalizeTokens } from "./text-normalize.js";

/*
 * Reviewable first-cut proposal. Every beat ends up covered (by ranked owned or
 * rights-cleared media, by the podcast A-roll, or by a title/lower-third card)
 * or explicitly unresolved with a fallback note. Nothing here touches the
 * project; `compileFirstCut` turns an approved proposal into one command group.
 */

export const FIRST_CUT_SCHEMA_VERSION = 1;
export const FIRST_CUT_PLANNER_VERSION = "first-cut/1";

export type FirstCutWorkflow = "explainer" | "podcast";

export type FallbackTemplate = "title" | "lower-third" | "unresolved-note";

export interface FallbackGraphicSpec {
  readonly template: FallbackTemplate;
  readonly text: string;
  /** The shot intent the fallback stands in for. */
  readonly intentKind: ShotIntentKind;
}

export type BeatCoverage =
  | { readonly kind: "footage"; readonly selected: RankedCandidate }
  | { readonly kind: "a-roll"; readonly assetId: string; readonly clipId: string }
  | { readonly kind: "graphic"; readonly fallback: FallbackGraphicSpec }
  | { readonly kind: "unresolved"; readonly fallback: FallbackGraphicSpec };

export interface AcquisitionSuggestion {
  readonly query: string;
  readonly reason: string;
}

export interface BeatProposal {
  readonly beat: NarrativeBeat;
  readonly status: "covered" | "unresolved";
  readonly coverage: BeatCoverage;
  readonly alternatives: readonly RankedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly unresolvedReason: string | null;
  readonly acquisitionSuggestion: AcquisitionSuggestion | null;
}

export interface FirstCutProposal {
  readonly schemaVersion: typeof FIRST_CUT_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly plannerVersion: typeof FIRST_CUT_PLANNER_VERSION;
  readonly indexVersion: string;
  readonly normalizerVersion: string;
  readonly rankingConfigVersion: string;
  readonly embeddingModel: LocalAssetIndex["embeddingModel"];
  readonly projectId: string;
  readonly projectRevision: number;
  readonly workflow: FirstCutWorkflow;
  readonly intendedUse: UsePolicyProfile;
  readonly startUs: number;
  readonly endUs: number;
  readonly beats: readonly BeatProposal[];
  readonly rightsDecisions: readonly RightsDecision[];
}

export interface PlanFirstCutInput {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly workflow: FirstCutWorkflow;
  readonly beats: readonly NarrativeBeat[];
  readonly index: LocalAssetIndex;
  readonly receipts: readonly AcquisitionReceipt[];
  readonly intendedUse: UsePolicyProfile;
  readonly nowMs: number;
  readonly config: RankingConfigV1;
  readonly embeddings?: EmbeddingSource | null;
}

export type PlanFirstCutError =
  | { readonly code: "no-beats" }
  | { readonly code: "beats-not-contiguous"; readonly order: number }
  | { readonly code: "embedding-model-mismatch" };

function fallbackFor(beat: NarrativeBeat): {
  readonly coverage: BeatCoverage;
  readonly reason: string | null;
} | null {
  const intent = beat.intent;
  switch (intent.kind) {
    case "title":
    case "lower-third":
      return {
        coverage: {
          kind: "graphic",
          fallback: { template: intent.kind, text: intent.text, intentKind: intent.kind },
        },
        reason: null,
      };
    case "map":
    case "chart":
    case "screenshot":
    case "still-motion":
      return {
        coverage: {
          kind: "unresolved",
          fallback: {
            template: "unresolved-note",
            text: `${intent.kind.replace("-", " ")} needed: ${intent.subject}`,
            intentKind: intent.kind,
          },
        },
        reason: `A ${intent.kind.replace("-", " ")} graphic is not rendered in this version.`,
      };
    case "owned-footage":
    case "a-roll":
      return null;
  }
}

function unresolvedFootage(
  beat: NarrativeBeat,
  rejected: readonly RejectedCandidate[],
): { readonly coverage: BeatCoverage; readonly reason: string } {
  const mustShowMissing = rejected.some((item) => item.reason === "must-show-missing");
  const reason =
    beat.mustShow.length > 0 && mustShowMissing
      ? `No rights-safe media shows: ${beat.mustShow.join(", ")}.`
      : "No rights-safe owned or cleared media matches this beat.";
  return {
    coverage: {
      kind: "unresolved",
      fallback: {
        template: "unresolved-note",
        text: `Footage needed: ${beat.text}`,
        intentKind: beat.intent.kind,
      },
    },
    reason,
  };
}

function toPrior(selected: RankedCandidate): PriorSelection {
  return {
    identityKey: selected.candidate.identityKey,
    providerId: selected.candidate.providerId,
    visualClusterId: selected.candidate.visualClusterId,
    sourceInUs: selected.candidate.sourceInUs,
    sourceOutUs: selected.candidate.sourceOutUs,
  };
}

export async function planFirstCut(
  input: PlanFirstCutInput,
): Promise<{ ok: true; value: FirstCutProposal } | { ok: false; error: PlanFirstCutError }> {
  const beats = [...input.beats].sort((a, b) => a.order - b.order);
  const first = beats[0];
  const last = beats[beats.length - 1];
  if (first === undefined || last === undefined) return { ok: false, error: { code: "no-beats" } };
  for (const [index, beat] of beats.entries()) {
    const previous = beats[index - 1];
    if (beat.order !== index || (previous !== undefined && previous.endUs !== beat.startUs)) {
      return { ok: false, error: { code: "beats-not-contiguous", order: beat.order } };
    }
  }
  const embeddings = input.embeddings ?? null;
  if (
    embeddings !== null &&
    (input.index.embeddingModel?.modelId !== embeddings.modelId ||
      input.index.embeddingModel.modelVersion !== embeddings.modelVersion)
  ) {
    return { ok: false, error: { code: "embedding-model-mismatch" } };
  }

  const rightsDecisions = filterByRights({
    entries: input.index.entries,
    receipts: input.receipts,
    intendedUse: input.intendedUse,
    nowMs: input.nowMs,
  });
  const rights = new Map(rightsDecisions.map((decision) => [decision.assetId, decision]));
  const prior: PriorSelection[] = [];
  const proposals: BeatProposal[] = [];

  for (const beat of beats) {
    const graphic = fallbackFor(beat);
    if (graphic !== null) {
      proposals.push({
        beat,
        status: graphic.coverage.kind === "unresolved" ? "unresolved" : "covered",
        coverage: graphic.coverage,
        alternatives: [],
        rejected: [],
        unresolvedReason: graphic.reason,
        acquisitionSuggestion: null,
      });
      continue;
    }
    const aRoll = beat.intent.kind === "a-roll" ? beat.intent : null;
    const ranking = rankCandidatesForBeat({
      beat,
      entries: input.index.entries,
      rights,
      config: input.config,
      prior,
      beatVector: embeddings?.vectorForText(beat.text) ?? null,
      excludedAssetId: aRoll?.assetId ?? null,
      minRelevance: aRoll === null ? input.config.minRelevance : input.config.cutawayMinRelevance,
    });
    const [selected, ...rest] = ranking.ranked;
    // One offer per unique content: byte-identical imports are not real alternatives.
    const seen = new Set(selected === undefined ? [] : [selected.candidate.identityKey]);
    const alternatives = rest
      .filter((item) => {
        if (seen.has(item.candidate.identityKey)) return false;
        seen.add(item.candidate.identityKey);
        return true;
      })
      .slice(0, input.config.alternativesPerBeat);
    if (selected !== undefined) {
      prior.push(toPrior(selected));
      proposals.push({
        beat,
        status: "covered",
        coverage: { kind: "footage", selected },
        alternatives,
        rejected: ranking.rejected,
        unresolvedReason: null,
        acquisitionSuggestion: null,
      });
      continue;
    }
    if (aRoll !== null) {
      proposals.push({
        beat,
        status: "covered",
        coverage: { kind: "a-roll", assetId: aRoll.assetId, clipId: aRoll.clipId },
        alternatives: [],
        rejected: ranking.rejected,
        unresolvedReason: null,
        acquisitionSuggestion: null,
      });
      continue;
    }
    const unresolved = unresolvedFootage(beat, ranking.rejected);
    const query = normalizeTokens([...beat.mustShow, beat.text].join(" "), beat.language)
      .slice(0, 6)
      .join(" ");
    proposals.push({
      beat,
      status: "unresolved",
      coverage: unresolved.coverage,
      alternatives: [],
      rejected: ranking.rejected,
      unresolvedReason: unresolved.reason,
      acquisitionSuggestion:
        query.length === 0
          ? null
          : {
              query,
              reason: "Search stock media in the Rights panel; nothing is acquired automatically.",
            },
    });
  }

  const identity = {
    schemaVersion: FIRST_CUT_SCHEMA_VERSION,
    plannerVersion: FIRST_CUT_PLANNER_VERSION,
    indexVersion: input.index.indexVersion,
    normalizerVersion: input.index.normalizerVersion,
    rankingConfig: input.config,
    embeddingModel: input.index.embeddingModel,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    workflow: input.workflow,
    intendedUse: input.intendedUse,
    beats,
    index: input.index.entries,
    rightsDecisions,
  };
  const proposalId = `first-cut-${await sha256Hex(canonicalJson(identity))}`;
  return {
    ok: true,
    value: {
      schemaVersion: FIRST_CUT_SCHEMA_VERSION,
      proposalId,
      plannerVersion: FIRST_CUT_PLANNER_VERSION,
      indexVersion: input.index.indexVersion,
      normalizerVersion: input.index.normalizerVersion,
      rankingConfigVersion: input.config.version,
      embeddingModel: input.index.embeddingModel,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      workflow: input.workflow,
      intendedUse: input.intendedUse,
      startUs: first.startUs,
      endUs: last.endUs,
      beats: proposals,
      rightsDecisions,
    },
  };
}

/** Total planned duration; equals the sum of beat durations because beats are contiguous. */
export function proposalDurationUs(proposal: Pick<FirstCutProposal, "beats">): number {
  return proposal.beats.reduce((sum, item) => sum + beatDurationUs(item.beat), 0);
}
