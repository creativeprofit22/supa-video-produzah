import {
  err,
  ok,
  provenanceOf,
  runProposalProducer,
  type ProducedEdit,
  type ProducerError,
  type ProducerProvenance,
  type ProposalProducer,
  type ProposalProducerInput,
  type Result,
} from "./proposal-producer.js";
import { rangeIdOf } from "./proposal-lifecycle.js";
import {
  createTranscriptEditProposal,
  type TranscriptEditDeletedRange,
  type TranscriptEditProposal,
  type TranscriptEditReason,
} from "./transcript-edit-proposal.js";

export type ProduceProposalError =
  | ProducerError
  | { readonly code: "no_edits" }
  | { readonly code: "proposal_rejected"; readonly message: string };

export const maxReasonLength = 280;

function clampReason(text: string): string {
  if (text.length <= maxReasonLength) return text;
  let cut = text.slice(0, maxReasonLength - 1);
  // Never leave half of a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\u2026`;
}

function coveringRange(
  ranges: readonly TranscriptEditDeletedRange[],
  edit: ProducedEdit,
): TranscriptEditDeletedRange | undefined {
  if (edit.kind === "delete-words") {
    const ids = new Set(edit.occurrenceIds);
    return ranges.find((range) =>
      range.selectedWords.some(({ occurrenceId }) => ids.has(occurrenceId)),
    );
  }
  return ranges.find(
    (range) =>
      range.clipId === edit.clipId &&
      range.sourceRange.start.value <= edit.sourceStartFrame &&
      range.sourceRange.end.value >= edit.sourceEndFrame,
  );
}

/**
 * Attaches each edit's reason to the deleted range that covers it. Edits that
 * merged into one range have their reasons joined with "; ". Edits are visited
 * in edit-id order so the output is deterministic.
 */
function reasonsForRanges(
  ranges: readonly TranscriptEditDeletedRange[],
  edits: readonly ProducedEdit[],
): readonly TranscriptEditReason[] {
  const byRange = new Map<string, string[]>();
  const ordered = [...edits].sort((left, right) =>
    left.editId < right.editId ? -1 : left.editId > right.editId ? 1 : 0,
  );
  for (const edit of ordered) {
    const text = edit.reason.trim();
    const range = coveringRange(ranges, edit);
    if (text.length === 0 || range === undefined) continue;
    const rangeId = rangeIdOf(range);
    const texts = byRange.get(rangeId) ?? [];
    if (!texts.includes(text)) texts.push(text);
    byRange.set(rangeId, texts);
  }
  return ranges.flatMap((range) => {
    const rangeId = rangeIdOf(range);
    const texts = byRange.get(rangeId);
    return texts === undefined
      ? []
      : [Object.freeze({ rangeId, text: clampReason(texts.join("; ")) })];
  });
}

/**
 * Turns producer candidates into one proposal. The candidates go through the
 * same `createTranscriptEditProposal` validation as a user's own selection.
 * Each edit's reason is attached to the cut that covers it; reasons are added
 * after the proposal id is derived, so they never change it.
 */
export async function proposalFromEdits(
  input: ProposalProducerInput,
  edits: readonly ProducedEdit[],
  producer: ProducerProvenance,
): Promise<Result<TranscriptEditProposal, ProduceProposalError>> {
  if (edits.length === 0) return err({ code: "no_edits" });
  const deletedOccurrenceIds: string[] = [];
  const deletedGaps = [];
  for (const edit of edits) {
    if (edit.kind === "delete-words") deletedOccurrenceIds.push(...edit.occurrenceIds);
    else
      deletedGaps.push({
        clipId: edit.clipId,
        sourceStartFrame: edit.sourceStartFrame,
        sourceEndFrame: edit.sourceEndFrame,
      });
  }
  try {
    const proposal = await createTranscriptEditProposal({
      ...input,
      deletedOccurrenceIds,
      deletedGaps,
      producer,
    });
    const reasons = reasonsForRanges(proposal.deletedRanges, edits);
    return ok(reasons.length === 0 ? proposal : Object.freeze({ ...proposal, reasons }));
  } catch (error) {
    return err({
      code: "proposal_rejected",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Runs a producer and builds a validated proposal from its output. */
export async function produceProposal(
  producer: ProposalProducer,
  input: ProposalProducerInput,
  signal: AbortSignal,
): Promise<
  Result<
    { readonly proposal: TranscriptEditProposal; readonly edits: readonly ProducedEdit[] },
    ProduceProposalError
  >
> {
  const produced = await runProposalProducer(producer, input, signal);
  if (!produced.ok) return produced;
  const proposal = await proposalFromEdits(input, produced.value, provenanceOf(producer));
  if (!proposal.ok) return proposal;
  if (signal.aborted) return err({ code: "cancelled" });
  return ok({ proposal: proposal.value, edits: produced.value });
}
